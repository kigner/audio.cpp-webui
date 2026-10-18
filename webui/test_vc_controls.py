"""VC controls and captured HTTP requests; no model loading or inference."""
import base64
import copy
import tempfile
import unittest
from unittest import mock

try:
    from webui import webui as app
    from webui.workbench_metadata import model_detail
    from webui.vc_controls import normalize_options
except ImportError:
    import webui as app
    from workbench_metadata import model_detail
    from vc_controls import normalize_options


class VoiceConversionControlsTests(unittest.TestCase):
    def detail(self, ident):
        return model_detail(app, app.catalog_by_id(ident))

    def test_common_controls_cover_conversion_models_without_changing_tts(self):
        original = copy.deepcopy(app.MODEL_PARAMS)
        for ident, expected in {
            'chatterbox-vc': {'num_inference_steps', 's3gen_cfg_rate'},
            'seed-vc': {'num_inference_steps', 'intelligibility_guidance_scale', 'similarity_guidance_scale'},
            'seed-vc-svc': {'num_inference_steps', 'inference_guidance_scale', 'auto_f0_adjust', 'semitone_shift'},
            'vevo2': {'route', 'num_inference_steps', 'use_pitch_shift'},
            'vevo2-svc': {'route', 'num_inference_steps', 'use_pitch_shift'},
            'rvc': {'rms_mix_rate', 'unvoiced_protection'},
            'tone-color-vc': {'temperature'},
        }.items():
            with self.subTest(model=ident):
                common = {p['name'] for p in self.detail(ident)['parameters'] if p['level'] in {'basic', 'effect'}}
                self.assertTrue(expected <= common, common)
        for entry in app.catalog_models():
            if entry['family'] in {'chatterbox', 'vevo2'} and entry['task'] in {'tts', 'clon'}:
                controls = {p['name']: p for p in model_detail(app, entry)['parameters']}
                self.assertNotIn('num_inference_steps', {name for name, p in controls.items() if p['level'] in {'basic', 'effect'}})
        self.assertEqual(app.MODEL_PARAMS, original)
        self.assertFalse(self.detail('miocodec')['profile']['send_seed'])
        for ident, seed in [('meanvc2', 42), ('tone-color-vc', 1234)]:
            self.assertEqual(next(p['default'] for p in self.detail(ident)['parameters'] if p['name'] == 'seed'), seed)

    def test_routes_and_f0_defaults_match_each_entry(self):
        for ident, expected in {
            'seed-vc': ['v2_vc', 'v1_whisper_bigvgan_vc', 'v1_xlsr_hift_vc'],
            'seed-vc-svc': ['v1_svc'],
            'vevo2': ['style_preserved_vc', 'style_converted_vc'],
            'vevo2-svc': ['style_preserved_svc', 'style_converted_svc', 'singing_style_conversion'],
        }.items():
            parameters = {p['name']: p for p in self.detail(ident)['parameters']}
            self.assertEqual(parameters['route']['choices'], expected)
            self.assertEqual(parameters['route']['default'], expected[0])
            if ident.startswith('seed-vc'):
                self.assertEqual(parameters['f0_condition']['default'], ident.endswith('-svc'))
                self.assertGreater(parameters['length_adjust']['min'], 0)

    def test_route_filter_preserves_runtime_and_unknown_expert_options(self):
        values = {'num_inference_steps': 17, 'inference_guidance_scale': 0.4,
                  'intelligibility_guidance_scale': 0.8, 'similarity_cfg_rate': 0.6,
                  'voice_anonymization': True, 'f0_condition': True,
                  'auto_f0_adjust': True, 'semi_tone_shift': 4,
                  'session_options.seed_vc.weight_type': 'f16', 'noise_path': 'noise.bin'}
        v2 = dict(values)
        normalize_options(app.catalog_by_id('seed-vc'), v2)
        self.assertEqual(v2, {'num_inference_steps': 17, 'intelligibility_guidance_scale': 0.8,
                             'similarity_guidance_scale': 0.6, 'voice_anonymization': True,
                             'session_options.seed_vc.weight_type': 'f16', 'noise_path': 'noise.bin'})
        svc = dict(values, route='v1_svc', f0_condition='false')
        normalize_options(app.catalog_by_id('seed-vc-svc'), svc)
        self.assertNotIn('semitone_shift', svc)
        self.assertNotIn('auto_f0_adjust', svc)
        self.assertNotIn('voice_anonymization', svc)
        self.assertNotIn('intelligibility_guidance_scale', svc)
        self.assertEqual(svc['inference_guidance_scale'], 0.4)
        svc = {'auto_f0_adjust': True, 'semitone_shift': 2}
        normalize_options(app.catalog_by_id('seed-vc-svc'), svc)
        self.assertEqual(svc, {'auto_f0_adjust': True, 'semitone_shift': 2})
        normalize_options(app.catalog_by_id('seed-vc'), svc)
        self.assertEqual(svc, {})
        for ident in ['vevo2', 'vevo2-svc']:
            options = {'temperature': 0.5, 'top_k': 10, 'top_p': 0.7, 'num_inference_steps': 12}
            normalize_options(app.catalog_by_id(ident), options)
            self.assertEqual(options, {'num_inference_steps': 12})
            options.update(route='style_converted_svc' if ident.endswith('-svc') else 'style_converted_vc',
                           temperature=0.5, target_text='Hello')
            normalize_options(app.catalog_by_id(ident), options)
            self.assertEqual(options['temperature'], 0.5)
            with self.assertRaises(ValueError):
                normalize_options(app.catalog_by_id(ident), {'route': 'editing'})

    def run_conversion(self, ident, seed=None, options=None, raw=''):
        with tempfile.TemporaryDirectory() as output, \
                mock.patch.object(app, 'OUTPUT_DIR', output), \
                mock.patch.object(app, '_ensure_with_options'), \
                mock.patch.object(app, '_ensure_wav', side_effect=lambda path, **kwargs: path), \
                mock.patch.object(app, '_trim_wav_seconds', side_effect=lambda path, *_: path), \
                mock.patch.object(app, '_split_wav_chunks', return_value=[('source.wav', 1.0)]), \
                mock.patch.object(app, '_audio_duration_seconds', return_value=1), \
                mock.patch.object(app, '_ui_log'), \
                mock.patch.object(app, '_run_task', return_value={'audio': base64.b64encode(b'RIFF-test').decode()}) as run:
            path, message = app.do_vc(ident, 'source.wav', 'target.wav', '(none)', None, None,
                                      seed, options or {}, raw)
            self.assertTrue(path, message)
            return run.call_args.args[2]

    def test_blank_and_explicit_seed_reach_the_backend_correctly(self):
        for ident in ['meanvc2', 'tone-color-vc', 'seed-vc', 'seed-vc-svc', 'chatterbox-vc', 'vevo2', 'vevo2-svc']:
            with self.subTest(model=ident):
                self.assertNotIn('seed', self.run_conversion(ident))
                self.assertEqual(self.run_conversion(ident, 0)['seed'], 0)
                request = self.run_conversion(ident, 7, {'seed': 12}, '{"seed":23}')
                self.assertEqual(request['seed'], 23)
                self.assertNotIn('seed', request.get('options', {}))
        for ident in ['miocodec', 'rvc']:
            request = self.run_conversion(ident, 7, {'seed': 12})
            self.assertNotIn('seed', request)
            self.assertNotIn('seed', request.get('options', {}))
        with mock.patch.object(app.random, 'randrange', return_value=2147483647) as random:
            self.assertEqual(self.run_conversion('tone-color-vc', -1)['seed'], 2147483647)
            random.assert_called_once_with(0, 2 ** 31)

    def test_actual_request_drops_inactive_route_values_from_json(self):
        request = self.run_conversion('seed-vc', options={'inference_guidance_scale': 0.9},
                                      raw='{"semitone_shift":5,"auto_f0_adjust":true,"num_inference_steps":16}')
        self.assertEqual(request['options'], {'num_inference_steps': 16})
        request = self.run_conversion('rvc', options={'rms_mix_rate': 0.5, 'unvoiced_protection': 0.1})
        self.assertEqual(request['options'], {'rms_mix_rate': 0.5, 'unvoiced_protection': 0.1})
        self.assertEqual(self.run_conversion('tone-color-vc', options={'temperature': 0})['options'], {'temperature': 0})


if __name__ == '__main__':
    unittest.main()
