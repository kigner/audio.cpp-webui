"""Real catalog contracts: no downloads or model inference."""
import json
from pathlib import Path
import re
import unittest
from unittest.mock import patch

try:
    from webui import webui as backend
    from webui.workbench_metadata import MODEL_INFO, model_detail
    from webui.parameter_i18n import option_label
except ImportError:
    import webui as backend
    from workbench_metadata import MODEL_INFO, model_detail
    from parameter_i18n import option_label


class ModelPresentationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.entries = {e['id']: e for e in backend.catalog_models()}
        with patch.object(backend, 'catalog_by_id', cls.entries.get):
            cls.details = {key: model_detail(backend, value) for key, value in cls.entries.items()}

    def names(self, ident):
        return {p['name'] for p in self.details[ident]['parameters']}

    def test_every_visible_parameter_has_chinese_text_and_unique_wire_name(self):
        for ident, detail in self.details.items():
            with self.subTest(model=ident):
                params = detail['parameters']
                self.assertEqual(len(params), len({p['name'] for p in params}))
                for param in params:
                    self.assertIsNotNone(option_label(param['name']), param['name'])
                    self.assertRegex(param['label'], r'[\u4e00-\u9fff]', param['name'])
                    self.assertRegex(param['help'], r'[\u4e00-\u9fff]', param['name'])

    def test_lfm_recognition_and_generation_do_not_share_task_options(self):
        asr = {p for p in self.names('lfm2-audio') if '_options.' not in p}
        self.assertEqual(asr, {'max_tokens', 'audio_chunk_mode', 'audio_chunk_duration_sec'})
        for ident in ('lfm2-audio-tts', 'lfm2-audio-tts-jp'):
            self.assertNotIn('audio_chunk_mode', self.names(ident))
            self.assertIn('temperature', self.names(ident))
        self.assertEqual(self.details['lfm2-audio']['languages'], ['english'])
        self.assertEqual(self.details['lfm2-audio-jp']['languages'], ['japanese'])
        self.assertNotIn('voice', self.names('lfm2-audio-tts-jp'))

    def test_model_defining_controls_are_common_and_runtime_stays_advanced(self):
        expected = {
            'index-tts2': {'emotion_text', 'emotion_alpha', 'use_emotion_text', 'duration_scale'},
            'index-tts2.5': {'emotion_text', 'emotion_alpha', 'use_emotion_text'},
            'neutts-2e': {'voice_id', 'emotion'},
            'supertonic': {'voice_id', 'speed'},
            'chatterbox': {'exaggeration'},
            'qwen3-tts-1.7b-custom': {'voice_id', 'instruct'},
            'maya1': {'instruct'}, 'habibi-tts': {'dialect', 'speed'},
            'ace-step': {'task_route', 'bpm', 'keyscale', 'timesignature', 'audio_cover_strength'},
            'stable-audio-small-music': {'audio_input_kind'},
            'kroko-asr': {'hotwords'}, 'canary-asr': {'target_language', 'punc'},
            'crisperwhisper': {'transcription_mode'},
            'seed-vc': {'route', 'length_adjust', 'voice_anonymization'},
            'vevo2': {'route', 'use_pitch_shift'}, 'rvc': {'semitone_shift', 'speaker_id'},
            'muscriptor-small': {'instruments', 'output_format'},
        }
        for ident, names in expected.items():
            common = {p['name'] for p in self.details[ident]['parameters'] if p['level'] != 'expert'}
            self.assertTrue(names <= common, (ident, names - common))
        for ident, detail in self.details.items():
            for param in detail['parameters']:
                if param['scope'] != 'request' or param['name'] in {
                        'temperature', 'top_p', 'top_k', 'num_inference_steps', 'text_chunk_size'}:
                    if detail['task'] == 'vc' and (detail['family'], param['name']) in {
                            ('chatterbox', 'num_inference_steps'), ('seed_vc', 'num_inference_steps'),
                            ('vevo2', 'num_inference_steps'), ('tone_color_vc', 'temperature')}:
                        self.assertEqual(param['level'], 'effect')  # Conversion exposes its main quality controls.
                        continue
                    self.assertEqual(param['level'], 'expert', (ident, param['name']))
        for ident in ('index-tts2', 'index-tts2.5'):
            self.assertNotIn('lang', self.names(ident))
            self.assertTrue(self.details[ident]['languages'])
        for ident in ('dots-tts-soar', 'dots-tts-meanflow', 'dots-tts-edit'):
            self.assertNotIn('instruct', self.names(ident))

    def test_firered_routes_do_not_expose_other_tasks(self):
        self.assertNotIn('instruct', self.names('firered-audio'))
        self.assertNotIn('num_inference_steps', self.names('firered-audio'))
        self.assertNotIn('instruct', self.names('firered-audio-clone'))
        self.assertIn('instruct', self.names('firered-audio-design'))
        self.assertNotIn('enable_thinking', self.names('firered-audio-tts'))
        self.assertNotIn('template_name', self.names('fireredtts3-design'))

    def test_legacy_variant_controls_keep_local_defaults_unless_profile_overrides(self):
        for key in ('voice_id', 'instruct'):
            self.assertNotIn(key, self.names('qwen3-tts'))
            self.assertIn(key, self.names('qwen3-tts-1.7b-custom'))
        self.assertNotIn('x_vector_only_mode', self.names('qwen3-tts-1.7b-custom'))
        for ident, entry in self.entries.items():
            if entry['family'] == 'f5_tts' and 'habibi' not in ident:
                self.assertNotIn('dialect', self.names(ident))
                self.assertNotIn('strip_diacritics', self.names(ident))
        original = backend.MODEL_PARAMS
        for ident, detail in self.details.items():
            entry = self.entries[ident]
            presets = original.get(ident, original.get(entry['family'], []))
            expected = {p['name']: p for p in presets}
            defaults = backend.profile_for(entry).get('default_options', {})
            for actual in detail['parameters']:
                if actual['name'] in expected:
                    name = actual['name']
                    if entry['family'] == 'seed_vc' and name == 'route':
                        # Each fixed task entry now advertises its compatible native default.
                        native_default = 'v1_svc' if entry['task'] == 'svc' else 'v2_vc'
                        self.assertEqual(actual.get('default'), native_default, (ident, name))
                        self.assertIn(native_default, actual['choices'])
                    elif entry['family'] == 'vevo2' and detail['task'] == 'vc' and name == 'route':
                        self.assertEqual(actual['default'], detail['vc_controls']['default_route'], (ident, name))
                        self.assertIn(actual['default'], actual['choices'])
                    else:
                        self.assertEqual(actual.get('default'), defaults.get(name, expected[name].get('default')), (ident, name))

    def test_language_and_asr_inputs_follow_actual_model_contract(self):
        self.assertEqual(self.details['niagara-asr']['languages'], [])  # English-only checkpoint; no language selector.
        self.assertEqual(self.details['piper-tts']['languages'], [])
        self.assertIn('zho', self.details['owsm-ctc']['languages'])
        self.assertNotIn('chinese', self.details['owsm-ctc']['languages'])
        self.assertFalse(self.details['niagara-asr']['asr_inputs']['context'])
        self.assertTrue(self.details['qwen3-asr']['asr_inputs']['context'])
        for ident, detail in self.details.items():
            if detail['task'] == 'asr' and 'offline' not in backend.MODEL_SPECS[detail['family']].get('modes', []):
                self.assertFalse(detail['asr_inputs']['details'], ident)
                self.assertFalse(detail['asr_inputs']['dialogue'], ident)

    def test_enriched_models_have_attributed_size_and_memory_estimates(self):
        for ident, info in MODEL_INFO['models'].items():
            with self.subTest(model=ident):
                self.assertRegex(info['description'], r'[\u4e00-\u9fff]')
                self.assertTrue(info.get('size_bytes') or info.get('size_estimate_gb'))
                self.assertEqual(len(info['memory_range_gb']), 2)
                self.assertTrue(info['memory_basis'])
                self.assertTrue(info['size_note'])
                if info['size_kind'] == 'published_files':
                    self.assertTrue(info['sources'])
                self.assertEqual(info['package_ids'], [p for p in [self.entries[ident].get('download_id'), *self.entries[ident].get('additional_download_ids', [])] if p])
        self.assertIsNone(self.details['vibeasr']['min_vram_gb'])
        self.assertEqual(self.details['vibeasr']['memory_device'], 'ram')
        self.assertGreater(self.details['auk']['size_bytes'], 13 * 2**30)
        self.assertIn('auk-vae-f32.gguf', self.details['auk']['files'])
        self.assertIn('qwen2.5-omni-3b-bf16.gguf', self.details['auk']['files'])
        self.assertLess(self.details['yue2']['size_bytes'], 5 * 2**30)


if __name__ == '__main__':
    unittest.main()
