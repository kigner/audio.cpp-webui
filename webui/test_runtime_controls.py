"""Runtime contracts across the catalog; no model downloads or inference."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

try:
    from webui import webui as backend
    from webui.workbench_metadata import model_detail
except ImportError:
    import webui as backend
    from workbench_metadata import model_detail

ROOT = Path(__file__).resolve().parents[1]
module = importlib.util.spec_from_file_location('runtime_audit', ROOT / 'tools/check_runtime_options.py')
audit = importlib.util.module_from_spec(module)
module.loader.exec_module(audit)


class RuntimeControlsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.entries = {entry['id']: entry for entry in backend.catalog_models()}
        with patch.object(backend, 'catalog_by_id', cls.entries.get):
            cls.details = {ident: model_detail(backend, entry) for ident, entry in cls.entries.items()}

    def params(self, ident):
        return {p['name']: p for p in self.details[ident]['parameters']}

    def test_all_catalog_runtime_declarations_have_ui_contracts(self):
        self.assertEqual(audit.scan(), {})
        for ident, detail in self.details.items():
            for p in detail['parameters']:
                if p['scope'] != 'request':
                    self.assertEqual(p['level'], 'expert', (ident, p['name']))
                    self.assertIn(p['runtime_group'], {'common', 'advanced'})
                    self.assertRegex(p['help'], '重载|重新加载')

    def test_index_precision_and_convolution_use_separate_whitelists(self):
        params = self.params('index-tts2')
        weight = params['session_options.index_tts2.weight_type']
        conv = params['session_options.index_tts2.conv_weight_type']
        self.assertEqual(weight['choices'], ['native', 'f32', 'f16', 'bf16', 'q8_0'])
        self.assertEqual(conv['choices'], ['native', 'f32', 'f16'])
        self.assertEqual(weight['runtime_group'], 'common')
        self.assertEqual(conv['runtime_group'], 'advanced')
        self.assertNotIn('default', weight)
        self.assertIn('不会恢复量化损失', weight['help'])

    def test_rejected_and_compatibility_only_options_are_not_offered(self):
        all_names = {p['name'] for d in self.details.values() for p in d['parameters']}
        self.assertNotIn('session_options.pocket_tts.weight_type', all_names)
        for scope in ('session', 'load'):
            for key in ('denoise', 'load_denoiser', 'denoiser'):
                self.assertNotIn(f'{scope}_options.voxcpm2.{key}', all_names)
        voicegen = next(d for d in self.details.values() if d['family'] == 'moss_voicegen')
        weight = next(p for p in voicegen['parameters'] if p['name'].endswith('.weight_type'))
        self.assertNotIn('f16', weight['choices'])

    def test_task_specific_runtime_controls_stay_on_their_route(self):
        for key in ('t3_weight_type', 'multilingual_t3', 't3_speech_cond_prompt_len'):
            self.assertNotIn('session_options.chatterbox.' + key, self.params('chatterbox-vc'))
            self.assertIn('session_options.chatterbox.' + key, self.params('chatterbox'))
        self.assertNotIn('session_options.vibevoice_asr.max_history_steps', self.params('vibevoice-asr'))

    def test_bundled_vad_models_have_controls_without_package_specs(self):
        for family in ('silero_vad', 'marblenet_vad'):
            detail = next(d for d in self.details.values() if d['family'] == family)
            self.assertTrue(any(p['name'] == f'session_options.{family}.weight_type' for p in detail['parameters']))
            self.assertFalse((ROOT / 'model_specs' / f'{family}.json').exists())

    def test_literal_parser_keeps_adjacent_descriptions_and_scope(self):
        text = '''cli.session_options = {
            {"demo.weight_type", "native|f32", "Weight " "format"},
            {"foreign.weight_type", "native|f32", "Compatibility namespace"}
        }; cli.load_options = {{"demo.path", "path", "Weights"}};'''
        rows = audit.cpp_options(text, 'demo')
        self.assertEqual(rows['session', 'demo.weight_type']['description'], 'Weight format')
        self.assertIn(('load', 'demo.path'), rows)
        self.assertEqual(len(rows), 2)

    def test_audit_catches_future_missing_control_and_enum_mismatch(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for path in ('webui/configs', 'model_specs', 'src/models/demo'):
                (root / path).mkdir(parents=True)
            (root / 'webui/configs/models_catalog.json').write_text(json.dumps({'models': [{'family': 'demo'}]}))
            (root / 'webui/configs/model_params.json').write_text('{}')
            (root / 'src/models/demo/loader.cpp').write_text('cli.session_options = {{"demo.weight_type", "native|f32", "Format"}};')
            self.assertEqual(audit.scan(root)['demo']['missing'][0]['name'], 'demo.weight_type')
            (root / 'model_specs/demo.json').write_text(json.dumps({'options': {'session': [
                {'name': 'weight_type', 'type': 'enum', 'values': ['native', 'q8_0']} ]}}))
            self.assertTrue(audit.scan(root)['demo']['errors'])

    def test_alias_detection_only_excludes_actual_fallback_names(self):
        text = '''find_option(options.options, {"demo.weight_type", "demo.old_weight_type"});
            option_weight_type(options, {"demo.decoder_weight_type", "demo.thinker_weight_type"});
            const auto independent_keys = {"demo.graph_arena_mb", "demo.weight_context_mb"};
            apply_option_v1_compatibility(opts, {{"demo.legacy", "demo.current"}});'''
        self.assertEqual(audit.compatibility_aliases(text, 'demo'), {
            'demo.old_weight_type': 'demo.weight_type', 'demo.legacy': 'demo.current',
            'demo.thinker_weight_type': 'demo.decoder_weight_type'})


if __name__ == '__main__':
    unittest.main()
