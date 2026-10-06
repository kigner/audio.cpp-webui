"""Owned runtime shutdown races; all process creation and health calls are mocked."""
import asyncio
from contextlib import ExitStack
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

try:
    from webui import webui as backend
    from webui.workbench_server import create_workbench_app
except ImportError:
    import webui as backend
    from workbench_server import create_workbench_app


class RuntimeShutdownTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.entry = dict(id="fixture", label="Fixture", task="tts", installed=True,
                          mode="offline", backend="cuda")
        for name, value in (
            ("_proc_lock", threading.Lock()), ("_proc_lifecycle_lock", threading.RLock()),
            ("_server_closing", threading.Event()), ("_workbench_runtime_guard", None),
            ("_server_proc", None), ("_loaded_id", None), ("_loaded_mode", None),
            ("_loaded_load_options", None), ("_loaded_session_options", None),
        ):
            self.stack.enter_context(patch.object(backend, name, value))
        for name, value in (
            ("catalog_by_id", Mock(return_value=self.entry)),
            ("_write_temp_config", Mock(return_value="fixture.json")),
            ("_open_log_file", Mock()), ("_ui_log", Mock()),
            ("_pump_server_output", Mock()), ("_port_open", Mock(return_value=False)),
            ("server_alive", Mock(side_effect=lambda: backend._server_proc is not None)),
        ):
            self.stack.enter_context(patch.object(backend, name, value))
        self.stack.enter_context(patch.object(backend.os.path, "isfile", return_value=True))
        self.process = Mock()
        self.process.poll.return_value = None
        self.popen = self.stack.enter_context(patch.object(backend.subprocess, "Popen", return_value=self.process))

    def start_thread(self, target):
        errors = []

        def run():
            try:
                target()
            except BaseException as error:
                errors.append(error)

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        return thread, errors

    def test_lifespan_shutdown_blocks_load_waiting_before_process_creation(self):
        entered, resume = threading.Event(), threading.Event()

        def prepare(_entry):
            entered.set()
            if not resume.wait(3):
                raise TimeoutError("test did not release the pending configuration")
            return "fixture.json"

        backend._write_temp_config.side_effect = prepare
        with tempfile.TemporaryDirectory() as root:
            fake = SimpleNamespace(OUTPUT_DIR=root, _shutdown_server=backend._shutdown_server)
            app = create_workbench_app(fake, realtime=False,
                download_manager=SimpleNamespace(close=lambda: None))

            async def exercise():
                async with app.router.lifespan_context(app):
                    worker, errors = self.start_thread(lambda: backend.ensure_model_loaded("fixture", {"tts"}))
                    self.assertTrue(await asyncio.to_thread(entered.wait, 3))
                resume.set()
                await asyncio.to_thread(worker.join, 3)
                self.assertFalse(worker.is_alive())
                self.assertEqual(len(errors), 1)
                self.assertIn("退出", str(errors[0]))

            try:
                asyncio.run(exercise())
            finally:
                resume.set()
        self.popen.assert_not_called()
        self.assertIsNone(backend._server_proc)

    def test_shutdown_stops_a_process_whose_creation_is_already_in_flight(self):
        entered, resume, stopped = threading.Event(), threading.Event(), threading.Event()

        def create(*_args, **_kwargs):
            entered.set()
            if not resume.wait(3):
                raise TimeoutError("test did not release Popen")
            return self.process

        self.popen.side_effect = create
        worker, errors = self.start_thread(lambda: backend._start_server(self.entry))
        self.assertTrue(entered.wait(3))
        closer, close_errors = self.start_thread(lambda: (backend._shutdown_server(), stopped.set()))
        try:
            self.assertTrue(backend._server_closing.wait(3))
            self.assertFalse(stopped.is_set())
        finally:
            resume.set()
            worker.join(3)
            closer.join(3)
        self.assertFalse(worker.is_alive() or closer.is_alive())
        self.assertEqual(errors + close_errors, [])
        self.assertTrue(stopped.is_set())
        self.process.terminate.assert_called_once()
        self.assertIsNone(backend._server_proc)

    def test_normal_unload_allows_the_next_model_load(self):
        with patch.object(backend, "_wait_health", return_value=True):
            backend.ensure_model_loaded("fixture", {"tts"})
            backend.unload_model()
            self.assertFalse(backend._server_closing.is_set())
            backend.ensure_model_loaded("fixture", {"tts"})
        self.assertEqual(self.popen.call_count, 2)
        self.assertIs(backend._server_proc, self.process)

    def test_shutdown_rejects_late_loads_and_interrupts_health_wait(self):
        backend._shutdown_server()
        with self.assertRaisesRegex(Exception, "退出"):
            backend.ensure_model_loaded("fixture", {"tts"})
        self.assertFalse(backend._wait_health(3600))
        self.popen.assert_not_called()
        backend.server_alive.assert_not_called()


if __name__ == "__main__":
    unittest.main()
