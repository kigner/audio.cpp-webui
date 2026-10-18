"""TTS controls must match the loaded model and preserve speech wire contracts."""
import base64
import tempfile
import unittest
from unittest import mock

try:
    from webui import webui as app
    from webui.workbench_metadata import model_detail
except ImportError:
    import webui as app
    from workbench_metadata import model_detail


class TtsControlsTests(unittest.TestCase):
    def setUp(self):
        output = tempfile.TemporaryDirectory()
        self.addCleanup(output.cleanup)
        for name, kwargs in [('OUTPUT_DIR', {'new': output.name}),
                             ('get_language', {'return_value': 'zh'}),
                             ('_ensure_with_options', {}), ('_ui_log', {}),
                             ('_ensure_wav', {'side_effect': lambda p: p})]:
            patch = mock.patch.object(app, name, **kwargs)
            patch.start()
            self.addCleanup(patch.stop)
        response = mock.MagicMock(status_code=200, content=b'RIFF-test', text='')
        response.__enter__.return_value = response
        patch = mock.patch.object(app.requests, 'post', return_value=response)
        self.post = patch.start()
        self.addCleanup(patch.stop)
        patch = mock.patch.object(app, '_iter_sse_events', return_value=iter([]))
        self.events = patch.start()
        self.addCleanup(patch.stop)

    def detail(self, ident):
        return model_detail(app, app.catalog_by_id(ident))

    def speech(self, ident='chatterbox-turbo', seed=None, options=None, language='', stream=False):
        args = (ident, 'Hello there.', language, None, '(none)', '', seed, None, options or {}, '')
        if stream:
            self.events.return_value = iter([{'type': 'speech.audio.delta',
                'audio': base64.b64encode(b'\0\0' * 64).decode()}])
            list(app.do_tts_stream(*args))
        else:
            path, message = app.do_tts(*args)
            self.assertTrue(path, message)
        return self.post.call_args.kwargs['json']

    def test_builtin_voice_catalog_and_language_map(self):
        for ident, count, default in [('kitten-tts', 8, 'Leo'), ('kokoro-tts', 54, 'af_heart')]:
            detail = self.detail(ident)
            voice = next(p for p in detail['parameters'] if p['name'] == 'voice')
            self.assertEqual(len(voice['choices']), count)
            self.assertEqual(voice['default'], default)
            self.assertEqual(voice['level'], 'basic')
            self.assertFalse(detail['accepts_voice_reference'])
        voices = self.detail('kokoro-tts')['tts_controls']['voice_languages']
        self.assertEqual(voices['zf_xiaoxiao'], 'zh')
        self.assertEqual(voices['bf_emma'], 'en-gb')

    def test_common_and_reference_controls_stay_out_of_model_settings(self):
        cases = [('kitten-tts2', 'preset', None), ('dramabox', 'duration_scale', None),
                 ('irodori-tts', 'duration_scale', None), ('echo-tts', 'max_duration_sec', None),
                 ('sopro-tts', 'max_seconds', None), ('sopro-tts', 'ref_seconds', 'reference'),
                 ('qwen3-tts', 'x_vector_only_mode', 'reference'), ('irodori-tts', 'no_ref', 'reference'),
                 ('echo-tts', 'reference_duration_sec', 'reference'), ('outetts', 'reference_language', 'reference'),
                 ('dots-tts-edit', 'source_text', 'reference'), ('dots-tts-edit', 'target_text', 'reference')]
        for ident, name, placement in cases:
            with self.subTest(model=ident, name=name):
                param = next(p for p in self.detail(ident)['parameters'] if p['name'] == name)
                self.assertIn(param['level'], {'basic', 'effect'})
                self.assertEqual(param.get('placement'), placement)

    def test_capability_filters_and_new_sampling_controls(self):
        turbo = self.detail('chatterbox-turbo')
        self.assertFalse(turbo['accepts_voice_reference'])
        self.assertTrue(turbo['profile']['send_seed'])
        self.assertFalse(turbo['profile']['send_max_tokens'])
        names = {p['name'] for p in turbo['parameters']}
        self.assertTrue({'temperature', 'top_p', 'top_k', 'repetition_penalty', 'max_new_tokens'} <= names)
        for ident in ['index-tts2', 'index-tts2.5']:
            names = {p['name'] for p in self.detail(ident)['parameters']}
            self.assertTrue({'emotion_vector', 'do_sample', 'top_p', 'top_k', 'temperature', 'length_penalty', 'num_beams', 'repetition_penalty'} <= names)
        for ident in ['dots-tts-soar', 'dots-tts-meanflow']:
            names = {p['name'] for p in self.detail(ident)['parameters']}
            self.assertFalse(names & {'instruction', 'source_audio', 'source_text', 'target_text', 'use_xvector'})
        self.assertNotIn('prompt_text', {p['name'] for p in self.detail('voxcpm1')['parameters']})

    def test_seed_default_zero_random_and_json_precedence_offline_and_stream(self):
        for stream, ident in [(False, 'chatterbox-turbo'), (True, 'supertonic')]:
            for seed, expected in [(None, None), ('', None), (0, 0), (42, 42)]:
                with self.subTest(stream=stream, seed=seed):
                    payload = self.speech(ident, seed=seed, stream=stream)
                    if expected is None:
                        self.assertNotIn('seed', payload)
                    else:
                        self.assertEqual(payload['seed'], expected)
            with mock.patch.object(app.random, 'randrange', return_value=123):
                self.assertEqual(self.speech(ident, seed=-1, stream=stream)['seed'], 123)
            self.assertEqual(self.speech(ident, seed=42, options={'seed': 0}, stream=stream)['seed'], 0)

    def test_kokoro_voice_and_language_payload(self):
        payload = self.speech('kokoro-tts', options={'voice': 'zf_xiaoxiao'}, language='zh')
        self.assertEqual(payload['voice'], 'zf_xiaoxiao')
        self.assertNotIn('voice', payload.get('options', {}))
        self.assertEqual(self.speech('kokoro-tts', language='zh')['voice'], 'zf_xiaobei')
        self.post.reset_mock()
        path, message = app.do_tts('kokoro-tts', 'Hello', 'zh', None, '(none)', '', None, None,
                                   {'voice': 'af_heart'}, '')
        self.assertIsNone(path)
        self.assertIn('不匹配', message)
        self.post.assert_not_called()

    def test_turbo_ignores_stale_reference_but_keeps_its_own_token_limit(self):
        path, message = app.do_tts('chatterbox-turbo', 'Hello', '', 'old.wav', '(none)', 'old text',
                                   0, 20, {'max_new_tokens': 500}, '')
        self.assertTrue(path, message)
        payload = self.post.call_args.kwargs['json']
        self.assertNotIn('voice_ref', payload)
        self.assertNotIn('reference_text', payload)
        self.assertNotIn('max_tokens', payload)
        self.assertEqual(payload['options']['max_new_tokens'], 500)
        self.assertEqual(payload['seed'], 0)

    def test_moss_clone_accepts_positional_samples_without_single_reference(self):
        payload = self.speech('moss-ttsd-clone', options={'voice_samples': ',second.wav'})
        self.assertNotIn('voice_ref', payload)
        self.assertEqual(payload['options']['voice_samples'], ',second.wav')


if __name__ == '__main__':
    unittest.main()
