"""ASR UI contracts checked against the shipped catalog and request builder; no inference."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

try:
    from webui import webui as app
    from webui.workbench_metadata import asr_aligner_models, model_detail
except ImportError:
    import webui as app
    from workbench_metadata import asr_aligner_models, model_detail


class AsrControlTests(unittest.TestCase):
    def detail(self, ident):
        return model_detail(app, app.catalog_by_id(ident))

    def params(self, ident):
        return {p['name']: p for p in self.detail(ident)['parameters']}

    def test_all_catalog_asr_controls_have_a_backend_contract(self):
        entries = [e for e in app.catalog_models() if e['task'] == 'asr']
        self.assertGreaterEqual(len(entries), 32)
        for entry in entries:
            with self.subTest(model=entry['id']):
                detail = model_detail(app, entry)
                request = {p['name'] for p in app.MODEL_SPECS[entry['family']].get('options', {}).get('request', [])}
                names = [p['name'] for p in detail['parameters']]
                self.assertEqual(len(names), len(set(names)))
                for p in detail['parameters']:
                    if p['scope'] == 'request':
                        self.assertIn(p['name'], request)
                    else:
                        self.assertEqual(p['level'], 'expert')
                self.assertEqual(detail['streaming'], app.profile_for(entry)['supports_streaming'])

    def test_fixed_or_metadata_languages_are_not_recognition_controls(self):
        for ident in ('kroko-asr', 'lfm2-audio', 'lfm2-audio-jp', 'higgs-audio-stt',
                      'granite5asr', 'niagara-asr', 'firered-audio', 'vibevoice-asr-streaming'):
            with self.subTest(model=ident):
                self.assertNotIn('language', self.params(ident))
                self.assertLessEqual(len(self.detail(ident)['languages']), 1)
        for ident in ('citrinet-asr', 'audio8-asr', 'parakeet-tdt', 'voxtral-realtime'):
            self.assertEqual(self.detail(ident)['languages'], [])

    def test_language_defaults_and_detection_are_distinct(self):
        self.assertEqual(self.detail('hviske-asr')['asr_inputs']['language_default'], 'da')
        self.assertIsNone(self.detail('hviske-asr')['asr_inputs']['language_auto'])
        self.assertEqual(self.detail('owsm')['asr_inputs']['language_default'], 'eng')
        self.assertEqual(self.detail('owsm')['asr_inputs']['language_auto'], 'auto')
        self.assertEqual(self.detail('confucius4-r2t2')['asr_inputs']['language_auto'], 'Auto')

    def test_common_options_and_prerequisites(self):
        kroko = self.params('kroko-asr')
        self.assertEqual(kroko['decoding_method']['level'], 'basic')
        for key in ('hotwords', 'hotwords_score', 'num_beams'):
            self.assertEqual(kroko[key]['requires'], {'decoding_method': ['modified_beam_search']})
        self.assertEqual(kroko['rule1_min_trailing_silence_sec']['requires'], {'enable_endpoint': [True]})
        self.assertEqual(self.params('sense-asr')['keep_tags']['level'], 'basic')
        self.assertEqual(self.params('higgs-audio-stt')['enable_thinking']['level'], 'basic')
        self.assertEqual(self.params('owsm')['condition_on_previous_text']['level'], 'basic')
        self.assertNotIn('verbatimize', self.params('crisperwhisper')['transcription_mode']['choices'])
        nemotron = self.params('nemotron-asr')
        self.assertNotIn('streaming', nemotron)
        self.assertNotIn('return_timestamps', nemotron)  # Native timestamps are always computed.
        self.assertEqual(nemotron['speaker_mode']['requires_value'], ['speaker_probabilities'])
        self.assertEqual(self.params('hviske-asr')['seed']['requires'], {'do_sample': [True], 'num_beams': [1]})
        self.assertEqual(self.params('audio-flamingo')['temperature']['requires'], {'do_sample': [True]})

    def test_timestamp_and_runtime_path_controls(self):
        qwen = self.params('qwen3-asr')
        self.assertEqual(qwen['return_timestamps']['modes'], ['offline'])
        self.assertEqual(qwen['return_timestamps']['level'], 'expert')
        self.assertEqual(qwen['return_timestamps']['scope'], 'request')
        self.assertEqual(self.params('owsm')['return_timestamps']['level'], 'basic')
        self.assertEqual(qwen['preserve_punctuation']['requires'], {'return_timestamps': [True]})
        self.assertTrue(qwen['session_options.qwen3_asr.forced_aligner_path']['wide'])
        for ident in ('qwen3-asr', 'parakeet-tdt', 'vibevoice-asr-streaming'):
            self.assertEqual(self.params(ident)['audio_chunk_mode']['modes'], ['offline'])

    def test_dialogue_workflow_requires_installed_diarization_model(self):
        entry = app.catalog_by_id('qwen3-asr')
        # params_for resolves through the same catalog; keep the ASR entry available.
        with mock.patch.object(app, 'catalog_models', return_value=[entry]):
            self.assertFalse(model_detail(app, entry)['asr_inputs']['dialogue_available'])
        with mock.patch.object(app, 'catalog_models', return_value=[entry, {'task': 'diar', 'installed': True}]):
            self.assertTrue(model_detail(app, entry)['asr_inputs']['dialogue_available'])
        for ident in ('moss-transcribe-diarize', 'vibevoice-asr'):
            self.assertFalse(self.detail(ident)['asr_inputs']['dialogue'])

    def test_aligner_choices_use_compatible_catalog_models_and_resolved_paths(self):
        entry = app.catalog_by_id('qwen3-asr')
        aligner = {'id': 'aligner', 'label': 'Qwen3 Forced Aligner', 'family': 'qwen3_forced_aligner',
                   'task': 'align', 'installed': True, 'abs_path': 'E:/音频模型/Aligner',
                   'gguf_path': 'E:\\音频模型\\Aligner\\aligner-q8_0.gguf'}
        incompatible = [{'id': family, 'family': family, 'task': 'align', 'installed': True}
                        for family in ('mms_forced_aligner', 'crisperwhisper')]
        key = 'session_options.qwen3_asr.forced_aligner_path'
        for installed, incomplete in ((True, False), (False, False), (True, True)):
            with self.subTest(installed=installed, incomplete=incomplete), mock.patch.object(
                    app, 'catalog_models', return_value=[entry, {**aligner, 'installed': installed,
                    'incomplete': incomplete}, *incompatible]):
                parameter = self.params(entry['id'])[key]
                self.assertEqual(parameter['type'], 'model')
                self.assertEqual(parameter['label'], '强制对齐模型')
                self.assertEqual(len(parameter['model_choices']), 1)
                choice = parameter['model_choices'][0]
                self.assertEqual(choice['value'], 'E:/音频模型/Aligner/aligner-q8_0.gguf')
                self.assertEqual(choice['installed'], installed and not incomplete)
                self.assertEqual(choice['install_path'], aligner['abs_path'])
        with mock.patch.object(app, 'catalog_models', return_value=[entry, {**aligner, 'gguf_path': None}]):
            self.assertEqual(self.params(entry['id'])[key]['model_choices'][0]['value'], aligner['abs_path'])
        with mock.patch.object(app, 'catalog_models', return_value=[entry, *incompatible]):
            self.assertEqual(self.params(entry['id'])[key]['model_choices'], [])

    def test_aligner_uses_catalog_search_roots_and_downloaded_gguf(self):
        # No model download/inference: exercise the real install-path resolver with a fixture file.
        entry = next(m for m in app.CATALOG['models'] if m['id'] == 'qwen3-forced-aligner')
        relative = Path(entry.get('download_path') or entry['path']).relative_to('models')
        with tempfile.TemporaryDirectory() as temporary:
            roots = [str(Path(temporary) / 'primary'), str(Path(temporary) / 'secondary')]
            with mock.patch.object(app, 'MODEL_SEARCH_ROOTS', roots), \
                    mock.patch.object(app, 'CATALOG', {'models': [entry]}):
                missing = asr_aligner_models(app)[0]
                self.assertFalse(missing['installed'])
                self.assertEqual(missing['install_path'], (Path(roots[0]) / relative).as_posix())
                installed = Path(roots[1]) / relative
                installed.mkdir(parents=True)
                gguf = installed / 'model.gguf'
                gguf.write_bytes(b'fixture-only')
                choice = asr_aligner_models(app)[0]
                self.assertTrue(choice['installed'])
                self.assertEqual(choice['value'], gguf.as_posix())
                self.assertEqual(choice['install_path'], installed.as_posix())

    def test_request_options_and_detailed_artifact_are_preserved(self):
        def transcribe(model, entry, profile, path, extras, **kwargs):
            self.assertEqual(extras['language'], 'zh')
            self.assertEqual(extras['options']['return_timestamps'], True)
            kwargs['details'].append({'offset_seconds': 0, 'result': {'text': '你好', 'words': [{'word': '你好', 'start': 0, 'end': 1}]}})
            return '你好', 1, 1

        with tempfile.TemporaryDirectory() as output, mock.patch.object(app, 'OUTPUT_DIR', output), \
                mock.patch.object(app, '_prepare_asr_input', return_value='fixture.wav'), \
                mock.patch.object(app, '_ensure_with_options'), mock.patch.object(app, '_ui_log'), \
                mock.patch.object(app, '_asr_transcribe_wav', side_effect=transcribe):
            results = list(app.do_asr_with_details('qwen3-asr', 'fixture.wav', 'zh', '', False, False,
                           {'return_timestamps': True}, '', True))
            self.assertEqual(results[-1][0], '你好')
            details = json.loads(Path(results[-1][3]).read_text(encoding='utf-8'))
            self.assertEqual(details[0]['result']['words'][0]['word'], '你好')


if __name__ == '__main__':
    unittest.main()
