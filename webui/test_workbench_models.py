import copy
import os
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

try:
    from .workbench_models import delete_installation
    from .workbench_server import create_workbench_app
except ImportError:
    from workbench_models import delete_installation
    from workbench_server import create_workbench_app


class ModelDeletionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.models = self.root / 'models'
        self.path = self.models / 'voice'
        self.path.mkdir(parents=True)
        (self.path / 'model.gguf').write_bytes(b'fixture-weight')
        self.entries = [dict(id='voice', label='Test voice', family='pocket_tts', task='tts',
                             abs_path=str(self.path), download_id='voice-package')]
        for directory in ('configs', 'voice', 'outputs'):
            (self.root / directory).mkdir()
            (self.root / directory / 'keep.txt').write_text('preserved')
        self.parameters = [{'name': 'speed', 'type': 'number', 'default': 1}]
        self.b = SimpleNamespace(OUTPUT_DIR=self.root / 'outputs', CONFIG_DIR=self.root / 'configs',
            VOICE_DIR=self.root / 'voice', MODELS_ROOT=self.models, MODEL_SEARCH_ROOTS=(self.models,),
            APP_VERSION='test', SERVER_BACKEND='cpu', LOCAL_VRAM_GB=None, SERVER='http://127.0.0.1:8088',
            _loaded_id=None, _server_proc=None, SPEC_PACKAGE_BY_ID={'voice-package': {'required_files': ['model.gguf']}},
            catalog_models=self.catalog, catalog_by_id=lambda ident: next((e for e in self.catalog() if e['id'] == ident), None),
            _webui_can_install_package=lambda p: True, profile_for=lambda e: {}, params_for=lambda ident: self.parameters,
            builtin_voices=lambda: [], loaded_ids=Mock(return_value=[]), unload_model=Mock(),
            _ensure_with_options=Mock())
        self.downloads = SimpleNamespace(lock=threading.RLock(), list=Mock(return_value=[]),
                                         close=Mock(), start=Mock(), control=Mock())
        self.app = create_workbench_app(self.b, realtime=False, download_manager=self.downloads)
        self.work = self.app.state.workbench
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

    def catalog(self):
        return [dict(entry, installed=Path(entry['abs_path']).exists()) for entry in self.entries]

    def preview(self):
        return self.client.get('/api/workbench/models/voice/deletion')

    def remove(self, token=None):
        token = token if token is not None else self.preview().json()['token']
        return self.client.post('/api/workbench/models/voice/delete', json={'token': token})

    def test_delete_and_reinstall_preserve_configuration_and_shared_entries(self):
        self.entries.append(dict(self.entries[0], id='voice-design', label='Voice design', task='vdes'))
        before = self.client.get('/api/workbench/models/voice').json()
        config = copy.deepcopy((self.entries, self.parameters, self.b.SPEC_PACKAGE_BY_ID))
        plan = self.preview().json()
        self.assertEqual({e['id'] for e in plan['affected']}, {'voice', 'voice-design'})
        self.assertEqual(plan['files'], 1)
        self.assertEqual(plan['bytes'], 14)
        self.assertIsNone(plan['blocker'])
        self.assertEqual(self.remove(plan['token']).status_code, 200)
        self.assertFalse(self.path.exists())
        after = self.client.get('/api/workbench/models/voice').json()
        self.assertFalse(after['installed'])
        self.assertFalse(after['deletable'])
        self.assertTrue(after['installable'])
        self.assertEqual(after['parameters'], before['parameters'])
        self.assertTrue(all(not e['installed'] for e in self.catalog()))
        self.assertEqual(config, (self.entries, self.parameters, self.b.SPEC_PACKAGE_BY_ID))
        for directory in ('configs', 'voice', 'outputs'):
            self.assertEqual((self.root / directory / 'keep.txt').read_text(), 'preserved')
        self.client.post('/api/workbench/downloads/voice', json={})
        self.downloads.start.assert_called_once_with('voice', '')
        # Simulate the installer's atomic placement without downloading weights.
        self.path.mkdir()
        (self.path / 'model.gguf').write_bytes(b'new-fixture-weight')
        restored = self.client.get('/api/workbench/models/voice').json()
        self.assertTrue(restored['installed'])
        self.assertEqual(restored['parameters'], before['parameters'])
        self.assertEqual(restored['install_path'], before['install_path'])

    def test_path_outside_roots_roots_themselves_and_user_data_are_rejected(self):
        for path in (self.root, self.models, self.root / 'configs', self.root / 'voice', self.root / 'outputs'):
            with self.subTest(path=path):
                self.entries[0]['abs_path'] = str(path)
                self.assertEqual(self.preview().status_code, 400)
                self.assertFalse(self.client.get('/api/workbench/models/voice').json()['deletable'])
        self.b.MODEL_SEARCH_ROOTS = (self.root,)
        self.entries[0]['abs_path'] = str(self.root / 'configs')
        self.assertEqual(self.preview().status_code, 400)
        self.assertTrue((self.path / 'model.gguf').exists())

    def test_link_and_junction_targets_are_rejected(self):
        target = self.root / 'outside'
        target.mkdir()
        (target / 'keep').write_text('keep')
        link = self.models / 'linked'
        if os.name == 'nt':
            import _winapi
            _winapi.CreateJunction(str(target), str(link))
        else:
            link.symlink_to(target, target_is_directory=True)
        self.addCleanup(lambda: link.rmdir() if os.name == 'nt' else link.unlink())
        self.entries[0]['abs_path'] = str(link)
        self.assertEqual(self.preview().status_code, 400)
        self.entries[0]['abs_path'] = str(self.models)
        self.b.MODEL_SEARCH_ROOTS = (self.root,)
        self.assertEqual(self.preview().status_code, 400)
        self.assertEqual((target / 'keep').read_text(), 'keep')

    def test_stale_and_missing_confirmation_never_delete(self):
        token = self.preview().json()['token']
        (self.path / 'new-file').write_text('new')
        self.assertEqual(self.remove(token).status_code, 409)
        self.assertEqual(self.remove('').status_code, 409)
        self.assertEqual(self.client.post('/api/workbench/models/voice/delete', json={}).status_code, 422)
        self.assertTrue(self.path.exists())
        self.assertEqual(self.remove().status_code, 200)

    def test_busy_realtime_loaded_and_download_states_are_blocked(self):
        token = self.preview().json()['token']
        self.work.active_job = 'busy'
        self.assertEqual(self.remove(token).status_code, 409)
        self.work.active_job = None
        self.work.leases['call'] = {}
        self.assertEqual(self.remove(token).status_code, 409)
        self.work.leases.clear()
        for status in ('preparing', 'downloading', 'installing', 'paused', 'pausing'):
            self.downloads.list.return_value = [{'status': status}]
            self.assertEqual(self.remove(token).status_code, 409)
        self.downloads.list.return_value = []
        self.b._loaded_id = 'voice'
        self.b._server_proc = SimpleNamespace(poll=lambda: None)
        self.assertTrue(self.preview().json()['blocker']['unload'])
        self.assertEqual(self.remove(token).status_code, 409)
        self.b._server_proc = None
        self.b.loaded_ids.return_value = ['external']
        self.assertFalse(self.preview().json()['blocker']['unload'])
        self.assertEqual(self.remove(token).status_code, 409)
        self.b.loaded_ids.return_value = []
        self.work.asr = SimpleNamespace(status=lambda: {'model': 'resident-asr', 'managed': True})
        self.assertEqual(self.remove(token).status_code, 409)
        self.work.asr = SimpleNamespace(status=lambda: {'model': None, 'managed': True})
        self.assertEqual(self.remove(token).status_code, 409)
        self.assertTrue(self.path.exists())
        self.assertIsNone(self.work.active_job)

    def test_single_file_and_external_components_preserve_other_weights(self):
        sibling = self.models / 'other.gguf'
        sibling.write_bytes(b'keep')
        self.entries[0]['source_roots'] = {'shared': str(sibling)}
        self.entries[0]['abs_path'] = str(self.path / 'model.gguf')
        self.assertEqual(self.remove().status_code, 200)
        self.assertTrue(self.path.is_dir())
        self.assertEqual(sibling.read_bytes(), b'keep')

    def test_changed_associations_and_nested_installations_are_confirmed(self):
        token = self.preview().json()['token']
        self.entries.append(dict(self.entries[0], id='nested', label='Nested', abs_path=str(self.path / 'sub')))
        self.assertEqual(self.remove(token).status_code, 409)
        self.assertEqual({e['id'] for e in self.preview().json()['affected']}, {'voice', 'nested'})

    def test_delete_holds_download_lock_and_inference_reservation(self):
        token = self.preview().json()['token']
        real_delete = delete_installation
        def checked(*args):
            self.assertTrue(self.downloads.lock._is_owned())
            self.assertTrue(self.work.active_job)
            self.assertEqual(self.client.post('/api/workbench/models/voice/load', json={}).status_code, 409)
            return real_delete(*args)
        with patch(create_workbench_app.__module__ + '.delete_installation', side_effect=checked):
            self.assertEqual(self.remove(token).status_code, 200)
        self.assertIsNone(self.work.active_job)

    def test_partial_failure_releases_reservation_and_explains_refresh(self):
        with patch(delete_installation.__module__ + '.shutil.rmtree', side_effect=PermissionError('locked')):
            response = self.remove()
        self.assertEqual(response.status_code, 409)
        self.assertIn('部分文件可能已删除', response.json()['detail'])
        self.assertIsNone(self.work.active_job)

    def test_cross_origin_delete_is_rejected(self):
        token = self.preview().json()['token']
        response = self.client.post('/api/workbench/models/voice/delete', json={'token': token},
                                    headers={'Origin': 'https://untrusted.example'})
        self.assertEqual(response.status_code, 403)
        self.assertTrue(self.path.exists())


if __name__ == '__main__':
    unittest.main()
