import atexit
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from workbench_asr import ManagedASR


class ManagedASRTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        exe = root / "audiocpp_server.exe"
        exe.write_bytes(b"test placeholder; never executed")
        self.entries = [{"id": "asr-model", "label": "ASR Model", "task": "asr",
                         "family": "asr_family", "installed": True, "abs_path": str(root / "model"),
                         "backend": "cpu", "config": "config.json", "weight": "weights.bin",
                         "session_options": {"asr_family.weight_type": "q8_0"},
                         "profile": {"default_options": {
                             "session_options.asr_family.arena_mb": 64,
                             "load_options": {"asr_family.mmap": True}, "temperature": 0.1}}}]
        self.backend = SimpleNamespace(
            SERVER="http://127.0.0.1:8088", SERVER_BACKEND="cuda", SERVER_EXE=str(exe),
            LOG_DIR=str(root / "logs"), BUNDLE_ROOT=str(root), DEVICE=0, VOICE_DIR=str(root / "voice"),
            LOAD_TIMEOUT=1, MODEL_SPECS={"asr_family": {"modes": ["offline", "streaming"],
                "options": {"load": [{"name": "mmap"}],
                            "session": [{"name": "weight_type"}, {"name": "arena_mb"}]}}},
            catalog_models=lambda: self.entries, profile_for=lambda entry: entry.get("profile", {}),
            _server_model_path=lambda entry: entry["abs_path"] + "/model.gguf",
            _model_threads=lambda backend: 8 if backend == "cpu" else 1,
            _stop_server=Mock(), _server_proc=Mock())
        self.env = patch.dict(os.environ, {"AUDIOCPP_ASR_SERVER": "http://127.0.0.1:8081"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def manager(self):
        value = ManagedASR(self.backend)
        self.addCleanup(value.close)
        self.addCleanup(atexit.unregister, value.close)
        return value

    def fake_process(self):
        process = Mock()
        process.poll.return_value = None
        process.wait.return_value = 0
        return process

    def test_catalog_only_installed_offline_asr(self):
        self.entries += [{"id": "tts", "task": "tts", "installed": True},
                         {"id": "missing", "task": "asr", "installed": False},
                         {"id": "stream", "task": "asr", "installed": True, "family": "stream"}]
        self.backend.MODEL_SPECS["stream"] = {"modes": ["streaming"]}
        rows = self.manager().catalog()
        self.assertEqual([row["id"] for row in rows], ["asr-model"])
        self.assertEqual(rows[0]["backend"], "cpu")

    def test_external_matching_server_is_reused_and_never_stopped(self):
        manager = self.manager()
        manager._status = Mock(return_value=(True, {"external-asr"}))
        with patch("workbench_asr.subprocess.Popen") as popen:
            self.assertIn("复用", manager.load("external-asr"))
            manager.close()
        popen.assert_not_called()
        self.backend._stop_server.assert_not_called()
        self.backend._server_proc.terminate.assert_not_called()

    def test_external_mismatch_is_refused_without_starting_or_killing(self):
        manager = self.manager()
        manager._status = Mock(return_value=(True, {"other-model"}))
        with patch("workbench_asr.subprocess.Popen") as popen:
            with self.assertRaisesRegex(RuntimeError, "端口 8081"):
                manager.load("asr-model")
        popen.assert_not_called()
        self.assertIsNone(manager._proc)

    def test_unhealthy_port_owner_is_not_replaced(self):
        manager = self.manager()
        manager._status = Mock(return_value=(False, set()))
        manager._port_open = Mock(return_value=True)
        with patch("workbench_asr.subprocess.Popen") as popen:
            with self.assertRaisesRegex(RuntimeError, "占用"):
                manager.load("asr-model")
        popen.assert_not_called()

    def test_launch_preserves_runtime_options_and_cpu_override_then_cleans_up(self):
        manager = self.manager()
        manager._status = Mock(side_effect=[(False, set()), (True, {"asr-model"}),
                                           (True, {"asr-model"})])
        manager._port_open = Mock(return_value=False)
        process = self.fake_process()
        with patch("workbench_asr.subprocess.Popen", return_value=process) as popen:
            manager.load("asr-model")
            config_path = Path(manager._config_path)
            config = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertEqual((config["host"], config["port"], config["backend"], config["threads"]),
                             ("127.0.0.1", 8081, "cpu", 8))
            model = config["models"][0]
            self.assertEqual(model["path"], self.entries[0]["abs_path"] + "/model.gguf")
            self.assertEqual(model["mode"], "offline")
            self.assertEqual(model["weight"], "weights.bin")
            self.assertEqual(model["load_options"], {"asr_family.mmap": "true"})
            self.assertEqual(model["session_options"], {"asr_family.weight_type": "q8_0", "asr_family.arena_mb": "64"})
            self.assertNotIn("temperature", model)
            self.assertIn("--no-ui", popen.call_args.args[0])
            if os.name == "nt":
                self.assertEqual(popen.call_args.kwargs["creationflags"], subprocess.CREATE_NO_WINDOW)
            manager.load("asr-model")
            popen.assert_called_once()
            manager.close()
        process.terminate.assert_called_once()
        self.assertFalse(config_path.exists())
        self.assertIsNone(manager._log_file)
        self.backend._stop_server.assert_not_called()

    def test_load_timeout_stops_only_owned_child_and_removes_config(self):
        manager = self.manager()
        self.backend.LOAD_TIMEOUT = 0
        manager._status = Mock(return_value=(False, set()))
        manager._port_open = Mock(return_value=False)
        process = self.fake_process()
        with patch("workbench_asr.subprocess.Popen", return_value=process) as popen:
            with self.assertRaisesRegex(RuntimeError, "取消或超时"):
                manager.load("asr-model")
            path = Path(popen.call_args.args[0][2])
        self.assertFalse(path.exists())
        self.assertIsNone(manager._proc)
        process.terminate.assert_called_once()
        self.backend._stop_server.assert_not_called()

    def test_remote_nested_or_main_tts_addresses_are_not_managed(self):
        for address in ("https://example.invalid", "http://localhost:8081/api", "http://127.0.0.1:8088",
                        "http://localhost:8081/?key=test", "http://user:pass@localhost:8081"):
            with self.subTest(address=address), patch.dict(os.environ, {"AUDIOCPP_ASR_SERVER": address}):
                manager = self.manager()
                self.assertFalse(manager.can_manage)
                with self.assertRaises(ValueError):
                    manager.load("asr-model")

    def test_unsupported_scoped_options_fail_before_process_launch(self):
        self.entries[0]["session_options"]["asr_family.unknown"] = 5
        manager = self.manager()
        manager._status = Mock(return_value=(False, set()))
        manager._port_open = Mock(return_value=False)
        with patch("workbench_asr.subprocess.Popen") as popen:
            with self.assertRaisesRegex(ValueError, "不在模型规格"):
                manager.load("asr-model")
        popen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
