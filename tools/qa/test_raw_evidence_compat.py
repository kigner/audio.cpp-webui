"""Temporary-only schema/preflight regression; all HTTP/process work is mocked."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave

ROOT = Path(__file__).resolve().parents[2]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


raw = module('raw_replay', 'build/functional-qa-20261008/raw-model-replay.py')
harness = module('workbench_replay', 'tools/qa/run_workbench_functional.py')
validator = module('postvalidation', 'tools/qa/validate_workbench_results.py')
dynamic = module('roundtrip_dynamic', 'tools/qa/dynamic-tts-roundtrip.py')
quality = module('roundtrip_quality', 'tools/qa/report_tts_roundtrip.py')


class RawCompatTests(unittest.TestCase):
    def test_text_sampling_keeps_changes_and_unchanged_terminal(self):
        result = {}
        for elapsed, state, text in [(0, 'running', ''), (1, 'running', 'Hello'),
                                      (2, 'running', 'Hello'), (3, 'done', 'Hello')]:
            harness.record_asr_text(result, {'status': state, 'text': text}, elapsed)
        self.assertEqual([x['elapsed'] for x in result['text_changes']], [0, 1, 3])
        self.assertTrue(result['text_changes'][-1]['final'])

    def test_raw_stream_retry_uses_model_policy_without_unknown_flag(self):
        cases = raw.definitions()
        retry = next(case for case in cases if case['id'] == 'raw-asr-voxtral-stream-correct-cli')
        command = raw.make_command(retry, Path('unused'), Path('dummy.exe'), 4)
        self.assertNotIn('--chunk-size', command)
        self.assertEqual(retry['retry_of'], 'raw-asr-voxtral-stream')
        self.assertEqual(len({case['id'] for case in cases}), len(cases))

    def fake_cli_case(self, folder, task='tts'):
        cli = folder / 'dummy_cli.exe'
        cli.write_bytes(b'unit-test placeholder; never executed')
        case = {'id': 'raw-' + task + '-test', 'stage': task, 'task': task, 'family': 'test',
                'model': 'local-test-model', 'mode': 'offline', 'session_options': {},
                'request': {'target_text': 'Hello test'}, 'unicode_outputs': True,
                'outputs': ['audio' if task == 'tts' else 'text']}

        class FakeProcess:
            pid, returncode = 123, 0

            def __init__(self, command, **kwargs):
                self.command = command

            def wait(self, timeout=None):
                flag = '--out' if task == 'tts' else '--text-out'
                path = Path(self.command[self.command.index(flag) + 1])
                if task == 'tts':
                    with wave.open(str(path), 'wb') as wav:
                        wav.setparams((1, 2, 16000, 0, 'NONE', ''))
                        wav.writeframes(struct.pack('<hhhh', 0, 1200, -1200, 0))
                else:
                    path.write_text('Hello test', encoding='utf-8')
                return 0

            def poll(self):
                return 0

        args = SimpleNamespace(output=folder, cli=cli, threads=2, timeout=1, base='not-used')
        with patch.object(raw, 'idle_guard', return_value={'busy': False}), patch.object(raw.subprocess, 'Popen', FakeProcess), contextlib.redirect_stdout(io.StringIO()):
            result = raw.run_case(case, args)
        return result

    def test_raw_records_progress_and_validator(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            for task in ('tts', 'asr'):
                result = self.fake_cli_case(folder, task)
                self.assertEqual(result['surface'], 'cli_raw')
                self.assertNotIn('job', result)
                self.assertIn('inputs', result['case'])
                self.assertIn('options', result['case'])
                record = folder / 'cases' / (result['case']['id'] + '.json')
                checked = validator.validate_case(result['case'], record)
                self.assertEqual(checked['status'], 'PASS', checked['checks'])
                self.assertEqual(checked['surface'], 'cli_raw')
            (folder / 'cases/bad.json').write_text('{ incomplete', encoding='utf-8')
            harness.update_summary(folder)
            summary = (folder / 'progress.md').read_text(encoding='utf-8')
            self.assertIn('CLI raw', summary)
            self.assertIn('中文输出/测试结果.wav', summary)
            self.assertIn('NEED_REVIEW', summary)

    def test_dynamic_excludes_raw_and_report_labels_raw_asr(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            raw_result = self.fake_cli_case(folder)
            ui_case = {'id': 'tts-test-ui', 'task': 'tts', 'model': 'test-ui', 'inputs': {'text': 'Hello test'}}
            ui = {'case': ui_case, 'verdict': 'PASS', 'artifacts': raw_result['artifacts'], 'started_at': '2026-10-08T00:00:00Z'}
            (folder / 'cases/tts-test-ui.json').write_text(json.dumps(ui), encoding='utf-8')
            output = folder / 'roundtrip.json'
            with patch.object(sys, 'argv', ['dynamic', '--source', str(folder), '--output', str(output)]), contextlib.redirect_stdout(io.StringIO()):
                dynamic.main()
            manifest = json.loads(output.read_text(encoding='utf-8'))
            self.assertEqual(len(manifest['cases']), 1)
            self.assertEqual(len(manifest['excluded_cli_raw_records']), 1)
            self.assertEqual(manifest['cases'][0]['quality_source']['surface'], 'workbench_http')
            case = manifest['cases'][0]
            result = {'case': case, 'surface': 'cli_raw', 'verdict': 'PASS', 'text': 'Hello test'}
            (folder / 'cases' / (case['id'] + '.json')).write_text(json.dumps(result), encoding='utf-8')
            report_path = folder / 'quality.json'
            with patch.object(sys, 'argv', ['quality', '--manifest', str(output), '--output', str(report_path)]), contextlib.redirect_stdout(io.StringIO()):
                quality.main()
            report = json.loads(report_path.read_text(encoding='utf-8'))
            self.assertEqual(report['models'][0]['asr_surface'], 'cli_raw')
            self.assertIsNone(report['models'][0]['char_similarity'])

    def test_dependency_pending_failed_and_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            case = {'id': 'next', 'depends_on': 'first'}
            self.assertEqual(harness.dependency_preflight(case, folder)['verdict'], 'PENDING')
            (folder / 'cases').mkdir()
            path = folder / 'cases/first.json'
            path.write_text(json.dumps({'verdict': 'FAIL', 'error': 'CUDA out of memory'}), encoding='utf-8')
            self.assertIn('CUDA out of memory', harness.dependency_preflight(case, folder)['skip_reason'])
            path.write_text(json.dumps({'verdict': 'PASS'}), encoding='utf-8')
            self.assertIsNone(harness.dependency_preflight(case, folder))

    def test_missing_install_and_diar_are_prerequisites(self):
        case = {'id': 'test', 'model': 'test', 'inputs': {'dialogue': True}}
        self.assertEqual(harness.model_preflight(case, {'installed': False})['failure_category'], 'MODEL_NOT_INSTALLED')
        self.assertEqual(harness.model_preflight(case, {'installed': False, 'incomplete': True})['failure_category'], 'MODEL_INCOMPLETE')
        self.assertEqual(harness.model_preflight(case, {'installed': True}, {'models': []})['failure_category'], 'DIAR_MODEL_PREREQUISITE')
        self.assertIsNone(harness.model_preflight(case, {'installed': True}, {'models': [{'installed': True, 'model_task': 'diar'}]}))

    def test_main_blocks_before_posts_and_retries_ready_preserving_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            manifest = folder / 'manifest.json'
            case = {'id': 'test', 'task': 'music', 'model': 'test', 'action': 'analyze_source'}
            manifest.write_text(json.dumps({'cases': [case]}), encoding='utf-8')
            calls, installed = [], [False]

            class Response:
                def __init__(self, data):
                    self.data = data

                def raise_for_status(self):
                    pass

                def json(self):
                    return self.data

            class Session:
                trust_env = False

                def request(self, method, url, **kwargs):
                    route = url.split('/api/workbench', 1)[1]
                    calls.append((method, route))
                    if route == '/models/test':
                        return Response({'installed': installed[0], 'incomplete': False})
                    if route == '/status':
                        return Response({'busy': False, 'realtime_active': False})
                    if route == '/jobs':
                        return Response({'id': 'test-job'})
                    if route.startswith('/jobs/'):
                        return Response({'id': 'test-job', 'status': 'done', 'task': 'music', 'model': 'test', 'message': '', 'artifacts': [], 'text': ''})
                    if route == '/unload-all':
                        return Response({})
                    raise AssertionError((method, route))

            argv = ['harness', '--manifest', str(manifest), '--output', str(folder), '--case', 'test']
            with patch.object(harness.requests, 'Session', Session), patch.object(sys, 'argv', argv), contextlib.redirect_stdout(io.StringIO()):
                harness.main()
            path = folder / 'cases/test.json'
            self.assertEqual(json.loads(path.read_text(encoding='utf-8'))['verdict'], 'BLOCKED')
            self.assertFalse(any(method == 'POST' for method, _ in calls))
            installed[0] = True
            with patch.object(harness.requests, 'Session', Session), patch.object(sys, 'argv', argv + ['--resume']), contextlib.redirect_stdout(io.StringIO()):
                harness.main()
            self.assertEqual(json.loads(path.read_text(encoding='utf-8'))['verdict'], 'PASS')
            self.assertEqual(len(list((folder / 'cases/attempts').glob('test-*.json'))), 1)


if __name__ == '__main__':
    unittest.main()
