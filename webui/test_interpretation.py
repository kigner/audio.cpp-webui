import base64
import io
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave

import httpx
import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient

try:
    from . import workbench_interpretation as interpretation
    from .workbench_server import Workbench
except ImportError:
    import workbench_interpretation as interpretation
    from workbench_server import Workbench


def frames(count, value=1000):
    return np.full(count * interpretation.FRAME, value, dtype='<i2').tobytes()


class VoiceSegmentTests(unittest.TestCase):
    def segmenter(self):
        return interpretation.VoiceSegments(lambda frame: float(np.max(frame) > .001))

    def test_onset_and_short_tail_are_preserved(self):
        vad = self.segmenter()
        segments = vad.feed(frames(8, 0) + frames(10) + frames(17, 0))
        self.assertEqual(len(segments), 1)
        self.assertEqual(np.count_nonzero(np.frombuffer(segments[0].pcm, dtype='<i2')), 10 * interpretation.FRAME)
        self.assertLessEqual(segments[0].start, 8 * interpretation.FRAME / interpretation.RATE)
        self.assertFalse(vad.active)

    def test_forced_boundaries_do_not_drop_speech(self):
        vad = self.segmenter()
        segments = []
        for _ in range(260):
            segments.extend(vad.feed(frames(1)))
        segments.extend(vad.finish())
        self.assertEqual(len(segments), 2)
        self.assertEqual(sum(len(s.pcm) for s in segments), 260 * interpretation.FRAME * 2)
        self.assertEqual(segments[0].end, segments[1].start)

    def test_finish_flushes_a_partial_frame(self):
        vad = self.segmenter()
        original = frames(4) + b'\xe8\x03' * 100
        vad.feed(original)
        segments = vad.finish()
        self.assertEqual(len(segments), 1)
        self.assertTrue(segments[0].pcm.startswith(original))
        self.assertEqual(vad.finish(), [])

    def test_finish_keeps_a_boundary_created_by_its_padded_tail(self):
        vad = self.segmenter()
        vad.feed(frames(4) + frames(16, 0) + b'\0' * 100)
        self.assertEqual(len(vad.finish()), 1)

    def test_silence_is_not_translated_and_buffers_are_bounded(self):
        vad = self.segmenter()
        for _ in range(100):
            self.assertEqual(vad.feed(frames(30, 0)), [])
        self.assertEqual(vad.finish(), [])
        self.assertLessEqual(len(vad.pre), 10)
        self.assertFalse(vad.frames)

    def test_bad_pcm_is_rejected(self):
        for data in [b'1', b'0' * 65538]:
            with self.assertRaises(ValueError):
                self.segmenter().feed(data)

    def test_context_is_recent_bounded_unicode_text(self):
        self.assertEqual(interpretation.translation_context([]), '')
        rows = [{'source': str(i), 'translation': '中文' * 200} for i in range(4)]
        text = interpretation.translation_context(rows)
        self.assertEqual([r['source'] for r in json.loads(text)], ['2', '3'])
        self.assertLessEqual(len(text.encode('utf-8')), 3500)
        self.assertEqual(interpretation.translation_context([{'source': '中' * 4096}]), '')


class TranslationSocketTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.calls, self.loads = [], []
        self.entry = {'id': 'lfm3-audio-s2s', 'family': 'lfm3_audio', 'task': 's2s', 'installed': True}
        self.backend = SimpleNamespace(OUTPUT_DIR=self.temp.name, SERVER='http://native.test', VC_TASKS=['s2s'], LOCAL_VRAM_GB=8, SERVER_BACKEND='cpu', LOCAL_GPU_NAME='fixture',
            catalog_models=lambda: [self.entry], _server_proc=None,
            _ensure_with_options=lambda *args, **kwargs: self.loads.append((args, kwargs)))
        self.work = Workbench(self.backend)
        self.service = interpretation.Interpretation(self.work, probability_factory=lambda: lambda frame: float(np.max(frame) > .001))
        self.addCleanup(self.service.saver.shutdown, wait=True)
        self.app = FastAPI()
        self.app.websocket(interpretation.PREFIX + '/live')(self.service.connect)
        self.app.post(interpretation.PREFIX + '/stop')(self.service.stop)
        self.app.get(interpretation.PREFIX + '/recordings/{ident}')(self.service.recording)
        self.complete = True
        self.native_error = False
        self.real_async_client = httpx.AsyncClient
        patcher = patch.object(interpretation.httpx, 'AsyncClient', self.client)
        patcher.start()
        self.addCleanup(patcher.stop)

    def client(self, **kwargs):
        return self.real_async_client(transport=httpx.MockTransport(self.native), **kwargs)

    def native(self, request):
        body = json.loads(request.content)
        self.calls.append(body)
        self.assertEqual(body['request']['options']['language'], 'zh')
        self.assertEqual(body['request']['options']['target_language'], 'en')
        path = Path(body['request']['audio'])
        self.assertTrue(path.is_file())
        with wave.open(str(path), 'rb') as wav:
            self.assertEqual((wav.getframerate(), wav.getnchannels()), (16000, 1))
        data = io.BytesIO()
        with wave.open(data, 'wb') as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(24000); wav.writeframes(b'\0\0' * 240)
        def artifact(stage):
            return {'id': 'lfm3_audio.translation', 'meta': {'stage': stage, 'source_text': '大家好。',
                'translation': 'Hello everyone.' if stage == 'translated' else ''}}
        messages = [
            {'type': 'task.stream.event', 'event': {'artifacts': [artifact('recognized')]}},
            {'type': 'task.stream.event', 'event': {'artifacts': [artifact('translated')], 'partial_text': {'text': 'Hello everyone.'}}},
            {'type': 'task.stream.event', 'event': {'audio': base64.b64encode(data.getvalue()).decode('ascii')}}]
        if self.complete:
            messages.append({'type': 'task.stream.done', 'result': {'text': 'Hello everyone.'}})
        if self.native_error:
            messages = [{'type': 'error', 'error': {'message': 'test model failure'}}]
        return httpx.Response(200, text=''.join('data: ' + json.dumps(message) + '\n\n' for message in messages))

    def begin(self, ws):
        ws.send_json({'type': 'start', 'source_language': 'zh', 'target_language': 'en'})
        self.assertEqual(ws.receive_json()['type'], 'preparing')
        self.assertEqual(ws.receive_json()['type'], 'ready')

    def test_ordered_native_stages_one_load_and_temporary_audio_cleanup(self):
        with TestClient(self.app) as client:
            with client.websocket_connect(interpretation.PREFIX + '/live') as ws:
                self.begin(ws)
                ws.send_bytes(frames(10) + frames(17, 0))
                ws.send_bytes(frames(10) + frames(17, 0))
                ws.send_json({'type': 'finish'})
                messages = []
                while not messages or messages[-1]['type'] != 'finished':
                    messages.append(ws.receive_json())
        for ident in [1, 2]:
            kinds = [m['type'] for m in messages if m.get('id') == ident]
            self.assertLess(kinds.index('recognized'), kinds.index('translated'))
            self.assertLess(kinds.index('translated'), kinds.index('audio'))
            self.assertEqual(kinds.count('audio'), 1)
            self.assertEqual(kinds.count('segment_done'), 1)
        self.assertEqual(len(self.loads), 1)
        self.assertEqual(len(self.calls), 2)
        self.assertTrue(self.calls[1]['request']['options']['translation_context'])
        self.assertFalse(self.work.leases)
        self.assertTrue(all(not Path(call['request']['audio']).exists() for call in self.calls))

    def test_incomplete_or_failed_stream_releases_session_and_reports_error(self):
        for native_error in [False, True]:
            self.complete = False
            self.native_error = native_error
            with TestClient(self.app) as client:
                with client.websocket_connect(interpretation.PREFIX + '/live') as ws:
                    self.begin(ws)
                    ws.send_bytes(frames(10) + frames(17, 0))
                    while True:
                        message = ws.receive_json()
                        if message['type'] == 'error':
                            self.assertTrue(message['message'])
                            break
            self.assertFalse(self.work.leases)
            self.service.saver.submit(lambda: None).result(timeout=5)
            self.assertTrue(all(not record.snapshot()['clips'] for record in self.service.recordings.values()))

    def test_builtin_voices_are_language_filtered_and_forwarded(self):
        voices = self.service.capabilities()['voices']
        self.assertEqual(len(voices), 38)
        self.assertEqual(len([voice for voice in voices if voice['language'] == 'en']), 4)
        with TestClient(self.app) as client, client.websocket_connect(interpretation.PREFIX + '/live') as ws:
            ws.send_json({'type': 'start', 'voice': 'british_english_male'})
            self.assertEqual(ws.receive_json()['type'], 'preparing')
            self.assertEqual(ws.receive_json()['type'], 'ready')
            ws.send_bytes(frames(10) + frames(17, 0))
            ws.send_json({'type': 'finish'})
            while ws.receive_json()['type'] != 'finished':
                pass
        self.assertEqual(self.calls[0]['request']['voice'], 'british_english_male')

    def test_invalid_or_wrong_language_voices_do_not_load_the_model(self):
        for voice in ['unknown', 'chinese_male', {}, ['american_english_male']]:
            with TestClient(self.app) as client, client.websocket_connect(interpretation.PREFIX + '/live') as ws:
                ws.send_json({'type': 'start', 'voice': voice})
                self.assertIn('内置音色', ws.receive_json()['message'])
        self.assertFalse(self.loads)

    def test_slow_file_writer_does_not_delay_the_next_inference_or_finish(self):
        release, started = threading.Event(), threading.Event()
        save = interpretation.TranslationRecording._save

        def slow(record, *args):
            started.set()
            if not release.wait(10):
                raise RuntimeError('test file writer was not released')
            return save(record, *args)

        try:
            with patch.object(interpretation.TranslationRecording, '_save', slow), TestClient(self.app) as client:
                with client.websocket_connect(interpretation.PREFIX + '/live') as ws:
                    self.begin(ws)
                    ws.send_bytes(frames(10) + frames(17, 0))
                    ws.send_bytes(frames(10) + frames(17, 0))
                    ws.send_json({'type': 'finish'})
                    while ws.receive_json()['type'] != 'finished':
                        pass
                    self.assertTrue(started.wait(2))
                    self.assertEqual(len(self.calls), 2, 'Next inference completes while disk writes are blocked')
                    recording = next(iter(self.service.recordings.values()))
                    snapshot = client.get(interpretation.PREFIX + '/recordings/' + recording.ident).json()
                    self.assertEqual(snapshot['pending'], 2)
                    self.assertFalse(snapshot['clips'])
                self.assertFalse(self.work.leases, 'Saving must not hold the model lease')
        finally:
            release.set()
        self.service.saver.submit(lambda: None).result(timeout=5)
        snapshot = recording.snapshot()
        self.assertEqual(snapshot['state'], 'done')
        self.assertEqual([clip['id'] for clip in snapshot['clips']], [1, 2])
        for clip in [*snapshot['clips'], {'audio': snapshot['audio']}]:
            token = clip['audio']['url'].rsplit('/', 1)[-1]
            with wave.open(str(self.work.artifacts[token]), 'rb') as wav:
                self.assertEqual((wav.getframerate(), wav.getnchannels(), wav.getsampwidth()), (24000, 1, 2))
                self.assertEqual(wav.getnframes(), 480 if clip['audio'] == snapshot['audio'] else 240)
        self.assertFalse(list(Path(self.temp.name).rglob('*.part')))

    def test_save_failure_does_not_stop_translation(self):
        with patch.object(interpretation.Path, 'mkdir', side_effect=OSError('disk full')), TestClient(self.app) as client:
            with client.websocket_connect(interpretation.PREFIX + '/live') as ws:
                self.begin(ws)
                ws.send_bytes(frames(10) + frames(17, 0))
                ws.send_json({'type': 'finish'})
                while ws.receive_json()['type'] != 'finished':
                    pass
            self.service.saver.submit(lambda: None).result(timeout=5)
        record = next(iter(self.service.recordings.values())).snapshot()
        self.assertEqual(record['state'], 'error')
        self.assertIsNone(record['audio'])
        self.assertIn('磁盘', record['message'])
        self.assertEqual(len(self.calls), 1)

    def test_stop_preserves_completed_utterances_for_download(self):
        with TestClient(self.app) as client, client.websocket_connect(interpretation.PREFIX + '/live') as ws:
            self.begin(ws)
            ws.send_bytes(frames(10) + frames(17, 0))
            while ws.receive_json()['type'] != 'segment_done':
                pass
            client.post(interpretation.PREFIX + '/stop')
        self.service.saver.submit(lambda: None).result(timeout=5)
        record = next(iter(self.service.recordings.values())).snapshot()
        self.assertEqual(record['state'], 'done')
        self.assertEqual(len(record['clips']), 1)
        self.assertTrue(record['audio']['url'])

    def test_file_queue_pressure_does_not_stop_inference(self):
        self.service.save_bytes = 32 * 1024 * 1024
        with TestClient(self.app) as client, client.websocket_connect(interpretation.PREFIX + '/live') as ws:
            self.begin(ws)
            ws.send_bytes(frames(10) + frames(17, 0))
            ws.send_json({'type': 'finish'})
            while ws.receive_json()['type'] != 'finished':
                pass
        self.service.saver.submit(lambda: None).result(timeout=5)
        record = next(iter(self.service.recordings.values())).snapshot()
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(self.work.leases)
        self.assertEqual(record['state'], 'error')
        self.assertIn('仍会继续', record['message'])
        self.assertEqual(record['pending'], 0)

    def test_silence_and_finish_do_not_call_native_model(self):
        with TestClient(self.app) as client:
            with client.websocket_connect(interpretation.PREFIX + '/live') as ws:
                self.begin(ws)
                ws.send_bytes(frames(30, 0))
                ws.send_json({'type': 'finish'})
                while ws.receive_json()['type'] != 'finished':
                    pass
        self.assertFalse(self.calls)
        self.assertFalse(self.work.leases)

    def test_existing_session_is_not_displaced(self):
        self.work.lease('existing', {'asr_model': 'old'})
        with TestClient(self.app) as client:
            with client.websocket_connect(interpretation.PREFIX + '/live') as ws:
                ws.send_json({'type': 'start'})
                self.assertEqual(ws.receive_json()['type'], 'error')
        self.assertIn('existing', self.work.leases)
        self.assertFalse(self.loads)

    def test_missing_model_and_invalid_direction_do_not_load(self):
        for config in [{'type': 'start', 'source_language': 'zh', 'target_language': 'zh'},
                       {'type': 'start', 'source_language': {}}, []]:
            with TestClient(self.app) as client:
                with client.websocket_connect(interpretation.PREFIX + '/live') as ws:
                    ws.send_json(config)
                    self.assertEqual(ws.receive_json()['type'], 'error')
        self.entry['installed'] = False
        self.assertFalse(self.service.capabilities()['ready'])
        with TestClient(self.app) as client:
            with client.websocket_connect(interpretation.PREFIX + '/live') as ws:
                ws.send_json({'type': 'start'})
                self.assertIn('安装', ws.receive_json()['message'])
        self.assertFalse(self.loads)

    def test_cross_origin_socket_is_rejected(self):
        with TestClient(self.app) as client:
            with self.assertRaises(Exception):
                with client.websocket_connect(interpretation.PREFIX + '/live', headers={'origin': 'https://example.com'}):
                    pass
        self.assertFalse(self.loads)

    def test_global_stop_releases_the_translation_lease(self):
        with TestClient(self.app) as client:
            with client.websocket_connect(interpretation.PREFIX + '/live') as ws:
                self.begin(ws)
                self.assertTrue(self.work.status()['interpretation_active'])
                self.assertEqual(client.post(interpretation.PREFIX + '/stop').json(), {'stopped': True})
        self.assertFalse(self.work.leases)


if __name__ == '__main__':
    unittest.main()
