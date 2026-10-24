"""Exercise the workbench regressions found after the October upstream merge."""
import base64
from pathlib import Path
import tempfile
import threading
import time
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


class UpstreamReviewTests(unittest.TestCase):
    def test_vc_aliases_migrate_saved_values_and_publish_one_control(self):
        cases = [
            ('seed-vc', 'length_adjust', 'duration_scale', 1.2, 1.4),
            ('chatterbox-vc', 's3gen_cfg_rate', 'flow_guidance_scale', .4, .8),
            ('rvc', 'retrieval_index_path', 'retrieval_index_file', 'old.index', 'new.index'),
            ('rvc', 'pitch_path', 'pitch_file', 'old.csv', 'new.csv'),
        ]
        for ident, old, current, saved, edited in cases:
            with self.subTest(model=ident, option=old):
                entry = app.catalog_by_id(ident)
                detail = model_detail(app, entry)
                names = [p['name'] for p in detail['parameters']]
                self.assertEqual(detail['option_aliases'][old], current)
                self.assertNotIn(old, names)
                self.assertEqual(names.count(current), 1)
                self.assertEqual(app._canonicalize_options(entry, {old: saved}), {current: saved})
                for options in ({old: saved, current: edited}, {current: edited, old: saved}):
                    with mock.patch.object(app, 'ensure_model_loaded'):
                        app._ensure_with_options(ident, app.VC_TASKS, options)
                    self.assertEqual(options, {current: edited})
        for ident, name in [('seed-vc', 'duration_scale'), ('chatterbox-vc', 'flow_guidance_scale')]:
            param = next(p for p in model_detail(app, app.catalog_by_id(ident))['parameters'] if p['name'] == name)
            self.assertEqual(param['level'], 'effect')
            if name == 'duration_scale':
                self.assertGreater(param['min'], 0)

    def test_vc_aliases_do_not_rename_unrelated_family_options(self):
        entry = {'family': 'qwen3_tts'}
        options = {'length_adjust': 1.2, 's3gen_cfg_rate': .4, 'pitch_path': 'pitch.csv'}
        self.assertEqual(app._canonicalize_options(entry, options), options)

    def test_rvc_workbench_accepts_new_index_and_no_index_clears_both_names(self):
        with tempfile.TemporaryDirectory() as output, mock.patch.object(app, 'OUTPUT_DIR', output):
            audio = Path(output) / 'fixture.wav'
            with wave.open(str(audio), 'wb') as wav:
                wav.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
                wav.writeframes(b'\0\0' * 16)
            work = Workbench(app)
            work.input_path = lambda ident, **kwargs: str(audio) if ident else None
            for no_index in (False, True):
                with self.subTest(no_index=no_index):
                    options = {'voice_model_path': 'custom.pth', 'retrieval_index_file': 'new.index', 'retrieval_blend': .5}
                    if no_index:
                        options['retrieval_index_path'] = 'old.index'
                    req = SimpleNamespace(task='vc', model='rvc',
                                          inputs={'audio': 'source', 'rvc_use_builtin': False, 'rvc_no_index': no_index},
                                          options=options)
                    job = {'id': 'review-rvc', 'task': 'vc', 'cancel': threading.Event(),
                           'started': time.monotonic(), 'audio_segments': []}
                    with mock.patch.object(app, 'do_vc', return_value=(str(audio), '✅')) as run:
                        work._run(job, req)
                    self.assertEqual(job['status'], 'done', job.get('message'))
                    run.assert_called_once()
                    submitted = run.call_args.args[7]
                    if no_index:
                        self.assertNotIn('retrieval_index_file', submitted)
                        self.assertNotIn('retrieval_index_path', submitted)
                        self.assertEqual(submitted['retrieval_blend'], 0)
                    else:
                        self.assertEqual(submitted['retrieval_index_file'], 'new.index')

    def test_dot_edit_is_offline_and_rejects_stale_stream_before_loading(self):
        entry = app.catalog_by_id('dots-tts-edit')
        self.assertFalse(model_detail(app, entry)['streaming'])
        with mock.patch.object(app, 'ensure_model_loaded') as load:
            with self.assertRaises(app.gr.Error):
                list(app.do_tts_stream(entry['id'], 'Edit this.', '', 'source.wav', '(none)', '', None, None, {}, ''))
            # A stale JSON template on another DotTTS entry must not bypass the restriction.
            with self.assertRaisesRegex(app.gr.Error, '离线|offline'):
                list(app.do_tts_stream('dots-tts-soar', 'Edit this.', '', 'source.wav', '(none)', '', None, None,
                                       {'template_name': 'edit'}, ''))
            load.assert_not_called()
        self.assertTrue(app.supports_streaming('dots-tts-soar'))

    def test_rvc_uploaded_index_uses_current_field_and_preserves_saved_override(self):
        with tempfile.TemporaryDirectory() as output, mock.patch.object(app, 'OUTPUT_DIR', output), \
                mock.patch.object(app, 'ensure_model_loaded'), \
                mock.patch.object(app, '_ensure_wav', side_effect=lambda path, **kwargs: path), \
                mock.patch.object(app, '_audio_duration_seconds', return_value=1), \
                mock.patch.object(app, '_ui_log'), \
                mock.patch.object(app, '_run_task', return_value={'audio': base64.b64encode(b'RIFF-test').decode()}) as run:
            for options, expected in [({}, 'uploaded.index'),
                                      ({'retrieval_index_path': 'saved.index'}, 'saved.index')]:
                with self.subTest(options=options):
                    path, message = app.do_vc('rvc', 'source.wav', None, '(none)', 'voice.pth', 'uploaded.index',
                                              None, options, '')
                    self.assertTrue(path, message)
                    submitted = run.call_args.args[2]['options']
                    self.assertEqual(submitted['retrieval_index_file'], expected)
                    self.assertNotIn('retrieval_index_path', submitted)

    def test_dot_edit_instruction_remains_visible_after_saved_name_migration(self):
        entry = app.catalog_by_id('dots-tts-edit')
        detail = model_detail(app, entry)
        self.assertEqual(detail['option_aliases']['instruction'], 'instruct')
        self.assertEqual([p['name'] for p in detail['parameters'] if p['name'] in {'instruction', 'instruct'}], ['instruct'])
        for ident in ('dots-tts-soar', 'dots-tts-meanflow'):
            self.assertFalse(any(p['name'] in {'instruction', 'instruct'}
                                 for p in model_detail(app, app.catalog_by_id(ident))['parameters']))


if __name__ == '__main__':
    unittest.main()
