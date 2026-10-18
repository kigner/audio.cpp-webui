"""No models/network: regression checks for the saved-evidence validator."""
import importlib.util
import contextlib
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest
import wave

spec = importlib.util.spec_from_file_location("postvalidation", Path(__file__).with_name("validate_workbench_results.py"))
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


class ValidatorTests(unittest.TestCase):
    def test_wav_decodes_samples_and_rejects_truncation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.wav"
            with wave.open(str(path), "wb") as wav:
                wav.setparams((1, 2, 16000, 0, "NONE", ""))
                wav.writeframes(struct.pack("<hhhh", 0, 1200, -2400, 0))
            info = qa.wav_info(path)
            self.assertEqual(info["frames"], 4)
            self.assertGreater(info["peak"], 0)
            path.write_bytes(path.read_bytes()[:-2])
            with self.assertRaisesRegex(ValueError, "truncated"):
                qa.wav_info(path)

    def test_spans_use_sample_rate_and_chunk_offset(self):
        checks = qa.Checks()
        data = {"sample_rate": 16000, "words": [{"word": "test", "start_sample": 0, "end_sample": 16000}]}
        qa.validate_spans(data, checks, "test", duration=2, offset=1)
        self.assertFalse(any(c["status"] == "FAIL" for c in checks.items))
        qa.validate_spans(data, checks, "bad", duration=1.5, offset=1)
        self.assertTrue(any(c["name"] == "bad.words[0].within_audio" and c["status"] == "FAIL" for c in checks.items))

    def test_details_continuity_and_local_bounds(self):
        result = {"text": "test", "timing": {"audio_duration_ms": 1000}, "sample_rate": 16000,
                  "words": [{"word": "test", "start_sample": 0, "end_sample": 16000}]}
        checks = qa.Checks()
        qa.validate_details([{"offset_seconds": 0, "result": result},
                             {"offset_seconds": 1, "result": result}], checks, 2, True)
        self.assertTrue(all(c["status"] == "PASS" for c in checks.items))
        bad = qa.Checks()
        qa.validate_details([{"offset_seconds": 0, "result": result},
                             {"offset_seconds": .5, "result": result}], bad, 2)
        self.assertTrue(any(c["status"] == "FAIL" and "continuity" in c["name"] for c in bad.items))

    def test_missing_timebase_requires_review(self):
        checks = qa.Checks()
        qa.validate_spans({"segments": [{"start_sample": 0, "end_sample": 100}]}, checks, "test", 1)
        self.assertTrue(any(c["status"] == "NEED_REVIEW" for c in checks.items))

    def test_midi_parses_notes_and_running_status(self):
        track = bytes.fromhex("00 90 3c 64 60 3c 00 00 ff 2f 00")
        data = b"MThd" + struct.pack(">IHHH", 6, 0, 1, 96) + b"MTrk" + struct.pack(">I", len(track)) + track
        self.assertEqual(qa.midi_info(data)["note_on_count"], 1)
        with self.assertRaisesRegex(ValueError, "truncated"):
            qa.midi_info(data[:-2])

    def test_abc_generated_subset_and_rest_fallback(self):
        header = 'X:1\nT:\nM:4/4\nL:1/16\nQ:1/4=120\nV: Vocal\nK:C\n'
        self.assertEqual(qa.abc_info(header + '"C"C4 D4 E4 F4 | [K:G] G8 z8 |]\n')["note_count"], 5)
        fallback = qa.abc_info(header + "Z|\nV: Ins\nZ|\n")
        self.assertEqual(fallback["note_count"], 0)
        self.assertEqual(fallback["rest_count"], 2)
        with self.assertRaisesRegex(ValueError, "before K|missing"):
            qa.abc_info("X:1\nC D E |\nK:C\n")
        with self.assertRaisesRegex(ValueError, "zero"):
            qa.abc_info(header + "C0 |\n")

    def test_pending_blocked_and_expected_error_are_not_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "case.json"
            case = {"id": "test", "task": "asr", "model": "test"}
            self.assertEqual(qa.validate_case(case, path)["status"], "PENDING")
            self.assertEqual(qa.validate_case({**case, "runnable": False}, path)["status"], "BLOCKED")
            path.write_text(json.dumps({"verdict": "PASS", "job": {"task": "asr", "model": "test", "status": "error", "message": "invalid combination"}}), encoding="utf-8")
            result = qa.validate_case({**case, "expect": "error", "contains": "invalid"}, path)
            self.assertEqual(result["status"], "EXPECTED_ERROR")

    def test_silent_stem_is_allowed_but_missing_label_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            folder, artifacts = Path(directory), []
            for stem, values in (("vocals", [100, -100]), ("accompaniment", [0, 0])):
                path = folder / f"audiocpp_sep_123_{stem}.wav"
                with wave.open(str(path), "wb") as wav:
                    wav.setparams((1, 2, 16000, 0, "NONE", ""))
                    wav.writeframes(struct.pack("<hh", *values))
                artifacts.append({"path": str(path), "sha256": qa.sha256(path)})
            record_path = folder / "case.json"
            record = {"verdict": "PASS", "job": {"task": "separation", "model": "test", "status": "done"}, "artifacts": artifacts}
            record_path.write_text(json.dumps(record), encoding="utf-8")
            case = {"id": "test", "task": "separation", "model": "test", "supplemental_assertions": {"stems": ["vocals", "accompaniment"], "minimum_audio_artifacts": 2}}
            self.assertEqual(qa.validate_case(case, record_path)["status"], "NEED_REVIEW")
            case["supplemental_assertions"]["stems"].append("piano")
            self.assertEqual(qa.validate_case(case, record_path)["status"], "FAIL")

    def test_original_harness_failure_is_not_promoted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "case.json"
            path.write_text(json.dumps({"verdict": "FAIL", "error": "original check failed", "job": {"task": "analysis", "model": "test", "status": "done"}}), encoding="utf-8")
            case = {"id": "test", "task": "unknown", "model": "test"}
            # Match task to avoid a deliberate identity failure; this exercises
            # the independent original-result gate alone.
            record = json.loads(path.read_text(encoding="utf-8"))
            record["job"]["task"] = "unknown"
            path.write_text(json.dumps(record), encoding="utf-8")
            self.assertEqual(qa.validate_case(case, path)["status"], "NEED_REVIEW")

    def test_dependency_and_missing_install_classification(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            prerequisite = {"verdict": "FAIL", "job": {"status": "error", "message": "CUDA out of memory"}}
            (folder / "first.json").write_text(json.dumps(prerequisite), encoding="utf-8")
            result = qa.validate_case({"id": "second", "task": "music", "model": "test", "depends_on": "first"}, folder / "second.json")
            self.assertEqual(result["status"], "BLOCKED")
            self.assertEqual(result["dependency_failure_category"], "VRAM_RESOURCE_FAILURE")
            self.assertEqual(qa.failure_category({"job": {"status": "error"}, "detail": {"installed": False}}), "MODEL_NOT_INSTALLED")
            self.assertEqual(qa.failure_category({"job": {"status": "error", "message": "unknown DotTTS request option: instruction"}}), "BACKEND_PARAMETER_FAILURE")

    def test_smart_turn_schema_and_probability(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            artifact = folder / "analysis.json"
            data = {"custom_schema_output": {"schema": "smart_turn.v1", "data": {"complete": True, "probability": .7}}}
            artifact.write_text(json.dumps(data), encoding="utf-8")
            path = folder / "case.json"
            record = {"verdict": "PASS", "job": {"task": "analysis", "model": "smart-turn", "status": "done"},
                      "artifacts": [{"path": str(artifact), "sha256": qa.sha256(artifact)}]}
            path.write_text(json.dumps(record), encoding="utf-8")
            case = {"id": "test", "task": "analysis", "model": "smart-turn", "supplemental_assertions": {"completion_decision": True}}
            self.assertEqual(qa.validate_case(case, path)["status"], "NEED_REVIEW")
            data["custom_schema_output"]["data"]["probability"] = 1.5
            artifact.write_text(json.dumps(data), encoding="utf-8")
            record["artifacts"][0]["sha256"] = qa.sha256(artifact)
            path.write_text(json.dumps(record), encoding="utf-8")
            self.assertEqual(qa.validate_case(case, path)["status"], "FAIL")

    def test_source_analysis_requires_meaningful_updates(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "case.json"
            record = {"verdict": "PASS", "job": {"task": "music", "model": "ace-step", "status": "done",
                                                  "parameter_updates": {"source_caption": "Piano", "bpm": 120}}}
            path.write_text(json.dumps(record), encoding="utf-8")
            case = {"id": "test", "task": "music", "model": "ace-step", "action": "analyze_source"}
            self.assertEqual(qa.validate_case(case, path)["status"], "NEED_REVIEW")
            record["job"]["parameter_updates"] = {"source_caption": ""}
            path.write_text(json.dumps(record), encoding="utf-8")
            self.assertEqual(qa.validate_case(case, path)["status"], "FAIL")

    def test_changed_manifest_or_runtime_cannot_reuse_old_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            snapshot = folder / 'runtime.json'
            snapshot.write_text('{"head":"original"}', encoding='utf-8')
            path = folder / 'case.json'
            case = {'id': 'test', 'task': 'metadata-test', 'model': 'test', 'options': {'value': 1}}
            record = {'case': case, 'verdict': 'PASS', 'job': {'task': 'metadata-test', 'model': 'test', 'status': 'done'},
                      'context_path': str(snapshot), 'context_sha256': qa.sha256(snapshot)}
            path.write_text(json.dumps(record), encoding='utf-8')
            self.assertEqual(qa.validate_case(case, path)['status'], 'PASS')
            changed = {**case, 'options': {'value': 2}}
            self.assertEqual(qa.validate_case(changed, path)['status'], 'NEED_REVIEW')
            snapshot.write_text('{"head":"new"}', encoding='utf-8')
            self.assertEqual(qa.validate_case(case, path)['status'], 'NEED_REVIEW')

    def test_expected_error_missing_trace_does_not_complete_acceptance(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / 'cases').mkdir()
            case = {'id': 'negative', 'task': 'asr', 'model': 'test', 'expect': 'error',
                    'supplemental_assertions': {'must_fail_before_inference': True}}
            manifest = folder / 'manifest.json'
            manifest.write_text(json.dumps({'cases': [case]}), encoding='utf-8')
            record = {'case': case, 'verdict': 'PASS', 'job': {'task': 'asr', 'model': 'test', 'status': 'error'}}
            (folder / 'cases/negative.json').write_text(json.dumps(record), encoding='utf-8')
            with contextlib.redirect_stdout(io.StringIO()):
                qa.main(['--evidence', str(folder), '--manifest', str(manifest)])
            report = json.loads((folder / 'postvalidation.json').read_text(encoding='utf-8'))
            self.assertEqual(report['counts'], {'EXPECTED_ERROR': 1})
            self.assertEqual(report['acceptance'], 'INCOMPLETE')

    def test_moonshine_final_result_only_exempts_its_own_increment_check(self):
        checks = qa.Checks()
        qa.validate_asr_stream_progress({'model': 'moonshine-asr'}, {'detail': {'family': 'moonshine_asr'}}, checks)
        self.assertEqual(checks.items[0]['status'], 'NOT_APPLICABLE')
        self.assertEqual(checks.items[0]['detail']['output'], 'FinalResult')
        other = qa.Checks()
        qa.validate_asr_stream_progress({'model': 'other'}, {'detail': {'family': 'parakeet_tdt'}}, other)
        self.assertEqual(other.items[0]['status'], 'NEED_REVIEW')

    def test_asr_progress_needs_actual_nonterminal_changes_and_final_prefix(self):
        record = {'text_changes': [{'elapsed': 1, 'status': 'running', 'text': 'Hello'},
                                   {'elapsed': 2, 'status': 'running', 'text': 'Hello world'},
                                   {'elapsed': 3, 'status': 'done', 'text': 'Hello world.'}],
                  'job': {'text': 'Hello world.'}}
        checks = qa.Checks()
        qa.validate_asr_stream_progress({}, record, checks)
        self.assertTrue(all(item['status'] == 'PASS' for item in checks.items))
        record['job']['text'] = 'Goodbye.'
        bad = qa.Checks()
        qa.validate_asr_stream_progress({}, record, bad)
        self.assertTrue(any(item['status'] == 'FAIL' for item in bad.items))
        short = qa.Checks()
        qa.validate_asr_stream_progress({}, {'text_changes': [{'elapsed': 3, 'status': 'done', 'text': 'Hello'}]}, short)
        self.assertEqual(short.items[0]['status'], 'NEED_REVIEW')

    def test_raw_unknown_cli_flag_is_harness_error_with_hashed_stderr(self):
        with tempfile.TemporaryDirectory() as directory:
            stderr = Path(directory) / 'stderr.log'
            stderr.write_text('audiocpp_cli error: unknown option: --chunk-size\n', encoding='utf-8')
            record = {'verdict': 'FAIL', 'case': {'id': 'test'}, 'cli': {'status': 'error', 'exit_code': 1},
                      'exit_code': 1, 'request': {'argv': ['dummy.exe', '--chunk-size', '16000']},
                      'evidence_files': [{'path': str(stderr), 'sha256': qa.sha256(stderr)}]}
            report = qa.validate_cli_record({'id': 'test'}, record, {}, qa.Checks())
            self.assertEqual(report['status'], 'FAIL')
            self.assertEqual(report['failure_category'], 'TEST_HARNESS_ERROR')
            record['evidence_files'][0]['sha256'] = 'changed'
            report = qa.validate_cli_record({'id': 'test'}, record, {}, qa.Checks())
            self.assertEqual(report['failure_category'], 'CLI_EXECUTION_FAILURE')


if __name__ == "__main__":
    unittest.main()
