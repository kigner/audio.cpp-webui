"""Generation feedback must report the seed actually sent, without inference."""
import base64
import tempfile
import unittest
from unittest import mock

try:
    from webui import webui as app
except ImportError:
    import webui as app


class GenerationFeedbackTests(unittest.TestCase):
    def setUp(self):
        output = tempfile.TemporaryDirectory()
        self.addCleanup(output.cleanup)
        for name, kwargs in (
                ('OUTPUT_DIR', {'new': output.name}),
                ('get_language', {'return_value': 'zh'}),
                ('_ui_log', {}), ('_ensure_with_options', {}),
                ('_ensure_wav', {'side_effect': lambda path: path}),
                ('_audio_duration_seconds', {'return_value': 1.0})):
            patcher = mock.patch.object(app, name, **kwargs)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.response = mock.MagicMock(status_code=200, content=b'RIFF-test', text='')
        self.response.__enter__.return_value = self.response
        patcher = mock.patch.object(app.requests, 'post', return_value=self.response)
        self.post = patcher.start()
        self.addCleanup(patcher.stop)

    def test_fixed_random_and_json_override_match_tts_request(self):
        for seed, options, raw, expected in (
                (1234, {}, '', 1234), (0, {}, '', 0), (-1, {}, '', 987654321),
                (1234, {'seed': 42}, '', 42), (1234, {}, '{"seed":-1}', 987654321)):
            with self.subTest(seed=seed, options=options, raw=raw), \
                    mock.patch.object(app.random, 'randrange', return_value=987654321):
                output, message = app.do_tts('qwen3-tts-1.7b-custom', '你好。', '', None,
                    '(none)', '', seed, 500, options, raw)
                self.assertTrue(output, message)
                payload = self.post.call_args.kwargs['json']
                self.assertEqual(payload['seed'], expected)
                self.assertNotIn('seed', payload.get('options', {}))
                self.assertIn(f'随机种子：{expected}', message)

    def test_streaming_completion_keeps_actual_seed(self):
        events = [{'type': 'speech.audio.delta', 'audio': 'AQACAA=='},
                  {'type': 'speech.audio.done', 'timing': {}}]
        with mock.patch.object(app, '_iter_sse_events', return_value=events), \
                mock.patch.object(app.random, 'randrange', return_value=7654):
            outputs = list(app.do_tts_stream('pocket-tts', 'Hello.', '', 'voice.wav',
                '(none)', 'Reference text.', -1, 500, {}, ''))
        self.assertTrue(outputs[-1][1], outputs[-1][2])
        self.assertEqual(self.post.call_args.kwargs['json']['seed'], 7654)
        self.assertIn('随机种子：7654', outputs[-1][2])

    def test_music_and_voice_design_report_option_override(self):
        response = {'audio': base64.b64encode(b'RIFF-test').decode()}
        with mock.patch.object(app, '_run_task', return_value=response) as run:
            output, message = app.do_music_gen('minimax-music3', 'Pop', 'Lyrics', None,
                20, 1234, {'seed': 83}, '')
        self.assertTrue(output, message)
        self.assertEqual(run.call_args.args[2]['seed'], 83)
        self.assertIn('随机种子：83', message)
        output, message = app.do_vdes('qwen3-tts-1.7b-vdesign', '你好。', '温暖的声音',
            1234, 500, {'seed': 84}, '')
        self.assertTrue(output, message)
        self.assertEqual(self.post.call_args.kwargs['json']['seed'], 84)
        self.assertIn('随机种子：84', message)

    def test_models_without_seed_do_not_claim_one_was_used(self):
        profile = dict(app.profile_for(app.catalog_by_id('qwen3-tts-1.7b-custom')), send_seed=False)
        with mock.patch.object(app, 'profile_for', return_value=profile):
            output, message = app.do_tts('qwen3-tts-1.7b-custom', '你好。', '', None,
                '(none)', '', -1, 500, {}, '')
        self.assertTrue(output, message)
        self.assertNotIn('seed', self.post.call_args.kwargs['json'])
        self.assertNotIn('随机种子', message)

    def test_conversion_reports_actual_random_seed(self):
        response = {'audio': base64.b64encode(b'RIFF-test').decode()}
        with mock.patch.object(app, '_run_task', return_value=response) as run, \
                mock.patch.object(app.random, 'randrange', return_value=321):
            output, message = app.do_vc('meanvc2', 'source.wav', 'target.wav', '(none)',
                None, None, -1, {}, '')
        self.assertTrue(output, message)
        self.assertEqual(run.call_args.args[2]['seed'], 321)
        self.assertIn('随机种子：321', message)

    def test_index_emotion_description_enables_conditioning(self):
        output, message = app.do_tts('index-tts2', '终于等到你了。', 'chinese', 'voice.wav',
            '(none)', '', 1234, 500, {'emotion_text': '开心又激动', 'emotion_alpha': 0.7}, '')
        self.assertTrue(output, message)
        payload = self.post.call_args.kwargs['json']
        self.assertEqual(payload['language'], 'zh')
        self.assertEqual(payload['options']['emotion_text'], '开心又激动')
        self.assertEqual(payload['options']['emotion_alpha'], 0.7)
        self.assertTrue(payload['options']['use_emotion_text'])


if __name__ == '__main__':
    unittest.main()
