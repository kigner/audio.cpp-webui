"""Contracts for the October 30 backend integration; no model inference or downloads."""
import base64
import io
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock
import wave

try:
    from webui import webui as app
    from webui.workbench_metadata import model_detail
    from webui.workbench_server import Workbench
except ImportError:
    import webui as app
    from workbench_metadata import model_detail
    from workbench_server import Workbench


def wav_bytes(channels=1, rate=24000):
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setparams((channels, 2, rate, 0, 'NONE', 'not compressed'))
        wav.writeframes(b'\x01\x00\xff\xff' * channels * 20)
    return output.getvalue()


class Response:
    status_code = 200

    def __init__(self, events):
        self.events = events

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def iter_lines(self, **kwargs):
        for event in self.events:
            yield 'data: ' + json.dumps(event)


class UpstreamOctoberTests(unittest.TestCase):
    def detail(self, ident):
        return model_detail(app, app.catalog_by_id(ident))

    def test_new_entries_and_manual_bark_contracts(self):
        for ident in ['lfm3-audio-asr', 'lfm3-audio-tts', 'lfm3-audio-s2s',
                      'gradium-phonon-31m-en', 'magenta-realtime-2-small', 'magenta-realtime-2-base',
                      'earshot-vad', 'music-flamingo', 'irodori-tts-meanflow', 'irodori-tts-meanflow-vdesign']:
            with self.subTest(model=ident):
                self.assertIsNotNone(app.catalog_by_id(ident))
        for variant in ['standard', 'plus', 'pro']:
            entry = app.catalog_by_id('underdog-bark3-' + variant)
            self.assertTrue(entry['manual_install'])
            self.assertNotIn('download_id', entry)
            self.assertNotIn('download_path', entry)
            self.assertTrue(app.profile_for(entry)['supports_streaming'])
            self.assertEqual(app._runtime_model_spec(entry), 'embedded')
            self.assertFalse(self.detail(entry['id'])['installable'])

    def test_lfm3_task_specific_controls_and_voices(self):
        asr = self.detail('lfm3-audio-asr')
        tts = self.detail('lfm3-audio-tts')
        chat = self.detail('lfm3-audio-s2s')
        names = lambda detail: {p['name'] for p in detail['parameters']}
        self.assertTrue({'chat', 'enable_thinking', 'audio_chunk_duration_sec'} <= names(asr))
        self.assertFalse({'voice', 'temperature', 'stream_frames_per_event'} & names(asr))
        self.assertFalse(asr['streaming'])
        self.assertIn('zh', asr['languages'])
        self.assertTrue(tts['streaming'])
        self.assertEqual(tts['profile']['stream_sample_rate'], 24000)
        self.assertFalse(tts['accepts_voice_reference'])
        voices = next(p for p in tts['parameters'] if p['name'] == 'voice')
        self.assertEqual(len(voices['choices']), 39)
        self.assertEqual(tts['tts_controls']['voice_languages']['chinese_male'], 'zh')
        self.assertFalse({'chat', 'return_codes', 'audio_chunk_mode', 'max_audio_tail_frames'} & names(tts))
        self.assertEqual(chat['task'], 'vc')
        self.assertTrue(chat['profile']['native_s2s'])
        self.assertTrue(chat['streaming'])
        self.assertFalse({'voice', 'language', 'chat', 'return_codes', 'text_chunk_size'} & names(chat))
        self.assertIn('max_audio_tail_frames', names(chat))
        options = {}
        app._tts_preset_options(app.catalog_by_id('lfm3-audio-tts'), 'zh', options)
        self.assertEqual(options, {'voice': 'chinese_female'})

    def test_lfm3_selects_backbone_and_requires_mmproj(self):
        with tempfile.TemporaryDirectory() as output:
            folder = Path(output)
            for name in ['LFM3-Audio-2B-Q8_0.gguf', 'LFM3-Audio-2B-Q4_K_M.gguf', 'mmproj-LFM3-Audio-2B-Q8_0.gguf', 'model.gguf']:
                (folder / name).touch()
            entry = app.catalog_by_id('lfm3-audio-asr') | {'abs_path': output}
            self.assertEqual(Path(app._server_model_path(entry)).name, 'LFM3-Audio-2B-Q8_0.gguf')
            entry['download_id'] = 'lfm3_audio_2b_q4_k_m'
            self.assertEqual(Path(app._server_model_path(entry)).name, 'LFM3-Audio-2B-Q4_K_M.gguf')
            (folder / 'mmproj-LFM3-Audio-2B-Q8_0.gguf').unlink()
            with mock.patch.object(app, 'CATALOG', {'models': [entry]}), \
                    mock.patch.object(app, '_model_path_candidates', return_value=[output]):
                actual = app.catalog_models()[0]
            self.assertFalse(actual['installed'])
            self.assertTrue(actual['incomplete'])

    def test_meanflow_streaming_and_new_runtime_options(self):
        self.assertTrue(self.detail('ming3-tts')['streaming'])
        for ident in ['irodori-tts', 'irodori-tts-meanflow']:
            steps = next(p for p in self.detail(ident)['parameters'] if p['name'] == 'num_inference_steps')
            self.assertIsNone(steps.get('default'))
        breeze = next(e for e in app.catalog_models() if e['family'] == 'breeze_tts')
        names = {p['name'] for p in self.detail(breeze['id'])['parameters']}
        for name in ['perf_mode', 'fused_depth', 'direct_prefill', 'skip_cache_round', 'round_bf16_fusion', 'batched_cfg']:
            self.assertIn('session_options.breeze_tts.' + name, names)
        music = self.detail('magenta-realtime-2-small')
        self.assertTrue(music['music_inputs']['style_audio'])
        self.assertTrue(music['music_inputs']['pianoroll'])
        self.assertFalse(music['music_inputs']['lyrics'])
        self.assertTrue(music['streaming'])
        drums = next(p for p in music['parameters'] if p['name'] == 'drums')
        self.assertEqual(drums['type'], 'choice')

    def test_phonon_requires_bundled_voice_and_has_valid_temperature(self):
        detail = self.detail('gradium-phonon-31m-en')
        self.assertTrue(detail['streaming'])
        self.assertFalse(detail['accepts_voice_reference'])
        temperature = next(p for p in detail['parameters'] if p['name'] == 'temperature')
        self.assertAlmostEqual((temperature['default'] - temperature['min']) / temperature['step'],
                               round((temperature['default'] - temperature['min']) / temperature['step']))
        with tempfile.TemporaryDirectory() as output:
            (Path(output) / 'phonon-31m-en-q8_0.gguf').touch()
            entry = app.catalog_by_id('gradium-phonon-31m-en')
            with mock.patch.object(app, 'CATALOG', {'models': [entry]}), \
                    mock.patch.object(app, '_model_path_candidates', return_value=[output]):
                self.assertFalse(app.catalog_models()[0]['installed'])

    def test_ultimate_clone_requires_reference_before_loading(self):
        entry = app.catalog_by_id('voxcpm2')
        with self.assertRaises(app.gr.Error):
            app._tts_reference_text_required(entry, app.profile_for(entry), False, {'ultimate_clone': True})
        self.assertTrue(app._tts_reference_text_required(entry, app.profile_for(entry), True, {'ultimate_clone': True}))

    def test_music_flamingo_question_replaces_catalog_instruction(self):
        for explicit, expected in [({}, 'What is the tempo?'),
                                   ({'instruct': 'List the instruments.'}, 'List the instruments.')]:
            with self.subTest(options=explicit), \
                    mock.patch.object(app, '_prepare_asr_input', return_value='public.wav'), \
                    mock.patch.object(app, '_ensure_with_options'), \
                    mock.patch.object(app, '_asr_transcribe_wav', return_value=('answer', 1, 1)) as transcribe:
                list(app.do_asr('music-flamingo', 'public.wav', context='What is the tempo?', adv_values=explicit))
                extras = transcribe.call_args.args[4]
                self.assertEqual(extras['options']['instruct'], expected)

    def test_new_gguf_packages_select_their_declared_weights_in_shared_directories(self):
        ids = ['music-flamingo', 'irodori-tts-meanflow', 'irodori-tts-meanflow-vdesign',
               'magenta-realtime-2-small', 'magenta-realtime-2-base']
        with tempfile.TemporaryDirectory() as output:
            folder = Path(output)
            for ident in ids:
                entry = app.catalog_by_id(ident)
                required = app.SPEC_PACKAGE_BY_ID[entry['download_id']]['required_files']
                for name in required:
                    (folder / name).parent.mkdir(parents=True, exist_ok=True)
                    (folder / name).touch()
            (folder / 'unrelated-model.gguf').touch()
            for ident in ids:
                with self.subTest(model=ident):
                    entry = app.catalog_by_id(ident) | {'abs_path': output}
                    expected = app.SPEC_PACKAGE_BY_ID[entry['download_id']]['required_files'][0]
                    self.assertEqual(Path(app._server_model_path(entry)), folder / expected)

    def native(self, work, ident, inputs, result, *, events=None, sequence=1, options=None):
        job = {'id': str(sequence), 'cancel': threading.Event(), 'text': '', 'audio_segments': []}
        request = SimpleNamespace(model=ident, inputs=inputs, options=options or {})
        entry = app.catalog_by_id(ident)
        with mock.patch.object(app, '_ensure_with_options') as load, \
                mock.patch.object(app, '_ensure_wav', side_effect=lambda path, **kwargs: path), \
                mock.patch.object(app, '_run_task', return_value=result) as run, \
                mock.patch.object(app.requests, 'post', return_value=Response(events or [])) as post:
            paths, message = work._run_native_audio(job, request, entry, inputs.get('audio'))
        return job, paths, message, load, run, post

    def test_spoken_chat_replays_history_and_new_conversation_resets_it(self):
        with tempfile.TemporaryDirectory() as output, mock.patch.object(app, 'OUTPUT_DIR', output):
            audio = Path(output) / 'question.wav'
            audio.write_bytes(wav_bytes())
            work = Workbench(app)
            artifact = {'id': 'lfm3_audio.reply', 'kind': 'acoustic_tokens', 'payload': 'AAAAAA==',
                        'meta': {'format': 'lfm3_audio.reply/1', 'steps': '1'}}
            result = {'audio': base64.b64encode(wav_bytes()).decode(), 'text': '你好', 'artifacts': [artifact]}
            inputs = {'audio': str(audio), 'conversation_id': 'first'}
            _, paths, _, load, run, _ = self.native(work, 'lfm3-audio-s2s', inputs, result)
            self.assertEqual(len(paths), 2)
            self.assertEqual(run.call_args.args[2]['artifacts'], [])
            self.assertEqual(load.call_args.kwargs['mode'], 'offline')
            _, _, _, _, run, _ = self.native(work, 'lfm3-audio-s2s', inputs, result, sequence=2)
            history = run.call_args.args[2]['artifacts']
            self.assertEqual([a['id'] for a in history], ['lfm3_audio.question', 'lfm3_audio.reply'])
            self.assertEqual(history[1], artifact)
            self.assertEqual(base64.b64decode(history[0]['payload']), audio.read_bytes())
            _, _, _, _, run, _ = self.native(work, 'lfm3-audio-s2s', inputs | {'conversation_id': 'new'}, result, sequence=3)
            self.assertEqual(run.call_args.args[2]['artifacts'], [])

    def test_native_stream_keeps_stereo_and_requires_completion(self):
        with tempfile.TemporaryDirectory() as output, mock.patch.object(app, 'OUTPUT_DIR', output):
            work = Workbench(app)
            encoded = base64.b64encode(wav_bytes(channels=2, rate=48000)).decode()
            events = [{'type': 'task.stream.event', 'event': {'audio': encoded}},
                      {'type': 'task.stream.done', 'result': {'audio': encoded}}]
            job, paths, _, load, _, post = self.native(work, 'magenta-realtime-2-small',
                {'text': 'piano', 'stream': True}, {}, events=events)
            self.assertEqual(job['audio_segments'][0]['channels'], 2)
            self.assertEqual(job['audio_segments'][0]['sample_rate'], 48000)
            self.assertEqual(Path(paths[0]).read_bytes(), base64.b64decode(encoded))
            self.assertEqual(post.call_args.kwargs['json']['stream_format'], 'sse')
            self.assertEqual(load.call_args.kwargs['mode'], 'streaming')
            with self.assertRaisesRegex(RuntimeError, '断开'):
                self.native(work, 'magenta-realtime-2-small', {'text': 'piano', 'stream': True}, {}, events=events[:1])

    def test_magenta_duration_matches_backend_contract_offline_and_streaming(self):
        declared = {option['name'] for option in app.MODEL_SPECS['magenta_realtime_2']['options']['request']}
        self.assertIn('duration_sec', declared)
        self.assertNotIn('duration_seconds', declared)
        encoded = base64.b64encode(wav_bytes(channels=2, rate=48000)).decode()
        result = {'audio': encoded}
        events = [{'type': 'task.stream.done', 'result': result}]
        with tempfile.TemporaryDirectory() as output, mock.patch.object(app, 'OUTPUT_DIR', output):
            work = Workbench(app)
            for ident in ['magenta-realtime-2-small', 'magenta-realtime-2-base']:
                for streaming in [False, True]:
                    with self.subTest(model=ident, streaming=streaming):
                        _, _, _, load, run, post = self.native(work, ident,
                            {'text': 'piano', 'duration': 1.25, 'stream': streaming}, result, events=events)
                        request = post.call_args.kwargs['json']['request'] if streaming else run.call_args.args[2]
                        self.assertNotIn('duration_seconds', request)
                        self.assertEqual(request['options']['duration_sec'], 1.25)
                        self.assertLessEqual(set(request['options']), declared)
                        self.assertEqual(load.call_args.kwargs['mode'], 'streaming' if streaming else 'offline')

    def test_magenta_explicit_duration_option_takes_precedence(self):
        encoded = base64.b64encode(wav_bytes(channels=2, rate=48000)).decode()
        with tempfile.TemporaryDirectory() as output, mock.patch.object(app, 'OUTPUT_DIR', output):
            _, _, _, _, run, _ = self.native(Workbench(app), 'magenta-realtime-2-small',
                {'text': 'piano', 'duration': 10}, {'audio': encoded}, options={'duration_sec': 2.5})
            request = run.call_args.args[2]
            self.assertNotIn('duration_seconds', request)
            self.assertEqual(request['options']['duration_sec'], 2.5)

    def test_legacy_magenta_duration_matches_backend_contract(self):
        result = {'audio': base64.b64encode(wav_bytes(channels=2, rate=48000)).decode()}
        with tempfile.TemporaryDirectory() as output, mock.patch.object(app, 'OUTPUT_DIR', output), \
                mock.patch.object(app, '_ensure_with_options'), \
                mock.patch.object(app, '_run_task', return_value=result) as run:
            for ident in ['magenta-realtime-2-small', 'magenta-realtime-2-base']:
                with self.subTest(model=ident):
                    path, _ = app.do_music_gen(ident, 'piano', '', None, 1.25, 42, {}, '')
                    self.assertTrue(Path(path).is_file())
                    request = run.call_args.args[2]
                    self.assertNotIn('duration_seconds', request)
                    self.assertEqual(request['options']['duration_sec'], 1.25)

    def test_style_only_music_and_piano_roll_upload(self):
        with tempfile.TemporaryDirectory() as output, mock.patch.object(app, 'OUTPUT_DIR', output):
            work = Workbench(app)
            audio, roll = Path(output) / 'style.wav', Path(output) / 'notes.json'
            audio.write_bytes(wav_bytes())
            roll.write_text('[]', encoding='utf-8')
            work.uploads['notes'] = roll
            result = {'audio': base64.b64encode(wav_bytes(channels=2, rate=48000)).decode()}
            _, _, _, _, run, _ = self.native(work, 'magenta-realtime-2-small',
                {'audio': str(audio), 'pianoroll': 'notes', 'duration': 1}, result)
            request = run.call_args.args[2]
            self.assertNotIn('text', request)
            self.assertEqual(request['options']['pianoroll_file'], str(roll))
            self.assertNotIn('duration_seconds', request)
            self.assertEqual(request['options']['duration_sec'], 1)


if __name__ == '__main__':
    unittest.main()
