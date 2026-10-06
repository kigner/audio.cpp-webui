import io
import json
from pathlib import Path
import socket
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

try:
    from . import workbench_launcher as launcher, workbench_server as server
except ImportError:
    import workbench_launcher as launcher
    import workbench_server as server


class LauncherTests(unittest.TestCase):
    def test_health_only_reuses_same_installation(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        with patch.object(launcher.urllib.request, "build_opener") as opener:
            opener.return_value.open.return_value = response
            for info, expected in (
                ({"application": launcher.APPLICATION, "install_id": launcher.INSTALL_ID}, True),
                ({"application": launcher.APPLICATION, "install_id": "other-directory"}, False),
                ({"application": "other-program", "install_id": launcher.INSTALL_ID}, False),
                ({"application": launcher.APPLICATION, "install_id": launcher.INSTALL_ID, "shutting_down": True}, False),
            ):
                response.read.return_value = json.dumps(info).encode()
                self.assertEqual(bool(launcher.existing_health(12345)), expected)

    def test_occupied_port_is_only_observed(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(2)
            port = listener.getsockname()[1]
            self.assertTrue(launcher.port_in_use(port))
            self.assertEqual(listener.getsockname()[1], port)

    def test_lock_during_slow_start_reuses_healthy_instance(self):
        with tempfile.TemporaryDirectory() as root, patch.object(launcher, "LOG_DIR", Path(root)), \
                patch.object(launcher, "existing_health", side_effect=[None, None, {"pid": 123, "runtime_revision": launcher.runtime_revision()}]), \
                patch.object(launcher, "open_existing") as opened:
            first = launcher.lock_instance(12345)
            try:
                self.assertIsNone(launcher.lock_instance(12345))
                opened.assert_called_once_with(12345)
            finally:
                first.close()

    def test_old_idle_service_is_restarted_instead_of_reusing_missing_routes(self):
        with tempfile.TemporaryDirectory() as root, patch.object(launcher, "LOG_DIR", Path(root)), \
                patch.object(launcher, "existing_health", side_effect=[{"pid": 123}, None]), \
                patch.object(launcher, "instance_idle", return_value=True), \
                patch.object(launcher, "stop_instance") as stop, \
                patch.object(launcher, "open_existing") as opened, patch.object(launcher.time, "sleep"):
            handle = launcher.lock_instance(12345)
            try:
                self.assertIsNotNone(handle)
                stop.assert_called_once_with(12345)
                opened.assert_not_called()
            finally:
                handle.close()

    def test_code_update_does_not_stop_an_active_task_or_call(self):
        with tempfile.TemporaryDirectory() as root, patch.object(launcher, "LOG_DIR", Path(root)), \
                patch.object(launcher, "existing_health", return_value={"runtime_revision": "old"}), \
                patch.object(launcher, "instance_idle", return_value=False), \
                patch.object(launcher, "stop_instance") as stop:
            with self.assertRaisesRegex(RuntimeError, "当前任务或实时通话"):
                launcher.lock_instance(12345)
            stop.assert_not_called()

    def test_runtime_revision_tracks_loaded_python_code(self):
        with tempfile.TemporaryDirectory() as root, patch.object(launcher, "WEBUI_DIR", Path(root)):
            module = Path(root) / "workbench_server.py"
            module.write_text("old source", encoding="utf-8")
            revision = launcher.runtime_revision()
            self.assertEqual(launcher.runtime_revision(), revision)
            module.write_text("new source", encoding="utf-8")
            self.assertNotEqual(launcher.runtime_revision(), revision)

    @unittest.skipUnless(launcher.os.name == "nt", "Windows batch entrypoint")
    def test_default_batch_keeps_console_output_and_passes_diagnostic_mode(self):
        with tempfile.TemporaryDirectory() as root:
            entry = Path(root) / "workbench_launcher.py"
            entry.write_text("import json,sys; print('LIVE CONSOLE LOG'); print(json.dumps(sys.argv[1:]))", encoding="utf-8")
            env = dict(launcher.os.environ, PY=launcher.sys.executable, WEBUI_DIR=root, AUDIOCPP_BACKEND="cpu")
            result = launcher.subprocess.run(["cmd.exe", "/d", "/c", str(launcher.WEBUI_DIR / "start_webui.bat")],
                env=env, capture_output=True, text=True, encoding="utf-8", timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("LIVE CONSOLE LOG", result.stdout)
            self.assertEqual(json.loads(result.stdout.strip().splitlines()[-1]), ["--diagnostic"])

    def test_invalid_port_is_rejected(self):
        for port in ("0", "65536", "invalid"):
            with patch.dict(launcher.os.environ, {"AUDIOCPP_UI_PORT": port}):
                with self.assertRaises(ValueError):
                    launcher.ui_port()

    def test_stop_never_signals_an_unrecognised_port_owner(self):
        with patch.object(launcher, "existing_health", return_value=None), \
                patch.object(launcher.urllib.request, "Request") as request:
            with self.assertRaises(RuntimeError):
                launcher.stop_instance(12345)
            request.assert_not_called()

    def test_missing_dependency_is_recorded_with_diagnostic_path(self):
        with tempfile.TemporaryDirectory() as root, \
                patch.object(launcher, "STARTUP_LOG", Path(root) / "startup.log"), \
                patch.object(launcher, "LOG_DIR", Path(root)), \
                patch.object(launcher, "lock_instance", return_value=Mock()), \
                patch.object(launcher, "port_in_use", return_value=False), \
                patch.object(launcher.runpy, "run_path", side_effect=ModuleNotFoundError("missing_test_dependency")), \
                patch.object(launcher.sys, "stdout", io.StringIO()), \
                patch.object(launcher.sys, "stderr", io.StringIO()), \
                patch.dict(launcher.os.environ, {"AUDIOCPP_NO_DIALOG": "1", "AUDIOCPP_WEBUI_LEGACY": "0"}):
            self.assertEqual(launcher.main(["--diagnostic"]), 1)
            text = launcher.STARTUP_LOG.read_text(encoding="utf-8")
            self.assertIn("missing_test_dependency", text)
            self.assertIn("run_webui.bat --diagnostic", text)
            launcher.sys.stdout.log.close()


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.backend = SimpleNamespace(OUTPUT_DIR=temp.name, _stop_server=Mock())
        self.downloads = SimpleNamespace(close=Mock())
        self.asr = SimpleNamespace(close=Mock())
        self.app = server.create_workbench_app(self.backend, realtime=False,
            download_manager=self.downloads, asr_manager=self.asr)
        self.client = TestClient(self.app)

    def test_shutdown_requires_token_and_supported_launcher(self):
        health = self.client.get("/api/workbench/health").json()
        self.assertEqual(health["application"], launcher.APPLICATION)
        self.assertEqual(health["runtime_revision"], launcher.runtime_revision())
        self.assertFalse(health["shutdown_available"])
        self.assertEqual(self.client.post("/api/workbench/shutdown").status_code, 403)
        headers = {"X-Workbench-Shutdown": health["shutdown_token"]}
        self.assertEqual(self.client.post("/api/workbench/shutdown", headers=headers).status_code, 409)
        callback = self.app.state.shutdown_callback = Mock()
        self.assertEqual(self.client.post("/api/workbench/shutdown", headers={**headers, "Origin": "https://example.invalid"}).status_code, 403)
        callback.assert_not_called()
        self.assertEqual(self.client.post("/api/workbench/shutdown", headers=headers).status_code, 200)
        callback.assert_called_once_with()
        self.assertTrue(self.app.state.shutting_down)

    def test_service_exit_closes_owned_managers(self):
        with self.client:
            self.backend._stop_server.assert_not_called()
        self.downloads.close.assert_called_once_with()
        self.asr.close.assert_called_once_with()
        self.backend._stop_server.assert_called_once_with()

    def test_cleanup_continues_if_download_manager_fails(self):
        self.downloads.close.side_effect = RuntimeError("cleanup failed")
        with self.assertRaises(RuntimeError):
            with self.client:
                pass
        self.asr.close.assert_called_once_with()
        self.backend._stop_server.assert_called_once_with()

    def test_logs_are_bounded_allowlisted_and_redacted(self):
        (self.root / "startup.log").write_text("x" * 70000 + "\nAuthorization: Bearer private-value\napi_key=other-secret\nhf_abcdefghijklmnopqrstuvwx\ntoken=private-token\n", encoding="utf-8")
        (self.root / "private.log").write_text("not served", encoding="utf-8")
        with patch.object(server, "LOG_DIR", self.root):
            payload = self.client.get("/api/workbench/logs?path=private.log").json()
        self.assertEqual(len(payload["logs"]), 3)
        text = payload["logs"][0]["text"]
        self.assertTrue(payload["logs"][0]["truncated"])
        for secret in ("private-value", "other-secret", "hf_abcdefghijklmnopqrstuvwx", "private-token", "not served"):
            self.assertNotIn(secret, text)
        self.assertLessEqual(len(text), 65536)

    def test_foreign_service_prevents_launch_without_signal(self):
        with patch.object(server, "existing_health", return_value=None), \
                patch.object(server, "port_in_use", return_value=True):
            with self.assertRaisesRegex(RuntimeError, "端口"):
                server.launch_workbench(self.backend)
        self.backend._stop_server.assert_not_called()


if __name__ == "__main__":
    unittest.main()
