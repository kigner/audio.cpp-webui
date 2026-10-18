"""Local-only lifecycle tests; subprocess and model traffic are always mocked."""
import json
import os
import queue
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import workbench_downloads as downloads


class Process:
    def __init__(self):
        self.pid = os.getpid()
        self.code = None
        self.lines = queue.Queue()
        self.stdout = self

    def __iter__(self):
        return self

    def __next__(self):
        value = self.lines.get(timeout=5)
        if value is None:
            raise StopIteration
        return value

    def poll(self):
        return self.code

    def wait(self, timeout=None):
        return self.code

    def close(self):
        pass

    def finish(self, code=0):
        self.code = code
        self.lines.put(None)

    def event(self, **values):
        self.lines.put("AUDIOCPP_DOWNLOAD_EVENT " + json.dumps(values) + "\n")


class DownloadJobTests(unittest.TestCase):
    def setUp(self):
        self.directory = self.enterContext(tempfile.TemporaryDirectory())
        root = Path(self.directory)
        self.entries = {
            "demo": {"id": "demo", "label": "Demo", "download_id": "demo_q8", "installed": False,
                     "download_installed": False, "abs_path": str(root / "models" / "Demo")},
            "alias": {"id": "alias", "label": "Alias", "download_id": "demo_q8", "installed": False,
                      "download_installed": False, "abs_path": str(root / "models" / "Demo")},
        }
        self.backend = SimpleNamespace(
            CONFIG_DIR=str(root / "configs"), MODELS_ROOT=str(root / "models"),
            PROJECT_ROOT=str(root), LOG_DIR=str(root / "logs"), OUTPUT_DIR=str(root / "output"),
            SPEC_MODEL_MANAGER=str(Path(__file__).with_name("model_manager_webui.py")),
            SPEC_PACKAGE_BY_ID={"demo_q8": {"id": "demo_q8", "target_directory": "Demo", "files": ["model.gguf"],
                                           "download": {"kind": "huggingface_snapshot", "repo": "audio-cpp/demo"}}},
            catalog_by_id=lambda value: self.entries.get(value),
            _webui_can_install_package=lambda p: bool(p.get("download", {}).get("repo")),
            _staged_bytes=lambda _entry: 0,
        )
        self.processes = []
        def spawn(*args, **kwargs):
            process = Process()
            self.processes.append(process)
            return process
        self.popen = self.enterContext(patch.object(downloads.subprocess, "Popen", side_effect=spawn))
        self.jobs = downloads.DownloadJobs(self.backend)
        self.addCleanup(self.finish_processes)

    def finish_processes(self):
        self.jobs.close()
        for process in self.processes:
            if process.code is None:
                process.finish(75)
        if self.jobs.worker:
            self.jobs.worker.join(timeout=2)

    def start_download(self, token=""):
        result = self.jobs.start("demo", token)
        deadline = time.monotonic() + 2
        while not self.processes and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue(self.processes)
        return result

    def wait_status(self, expected):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            records = self.jobs.list()
            if records and records[0]["status"] == expected:
                return records[0]
            time.sleep(0.01)
        self.fail(f"expected {expected}, got {self.jobs.list()}")

    def test_installed_and_manual_models_do_not_launch_downloads(self):
        self.entries["demo"]["installed"] = True
        self.entries["demo"]["download_installed"] = True
        self.assertEqual(self.jobs.start("demo")["status"], "done")
        self.entries["alias"]["manual_install"] = True
        with self.assertRaises(ValueError):
            self.jobs.start("alias")
        self.popen.assert_not_called()

    def test_shutdown_before_worker_start_preserves_pause_without_spawn(self):
        # Hold creation until after close, matching a pending download thread.
        with patch.object(downloads.threading.Thread, "start"):
            self.jobs.start("demo")
        self.jobs.close()
        self.jobs._run(["unused"], {})
        self.popen.assert_not_called()
        self.assertEqual(self.jobs.list()[0]["status"], "paused")
        self.jobs.worker = None

    def test_token_is_child_environment_only_and_cli_has_control_file(self):
        token = "hf_TEST_DO_NOT_PERSIST_98765"
        self.start_download(token)
        command = self.popen.call_args.args[0]
        kwargs = self.popen.call_args.kwargs
        self.assertIn("--control-file", command)
        self.assertIn("--models-root", command)
        self.assertEqual(kwargs["env"]["HF_TOKEN"], token)
        self.assertNotIn(token, str(command))
        for path in Path(self.backend.CONFIG_DIR).rglob("*"):
            if path.is_file():
                self.assertNotIn(token, path.read_text(encoding="utf-8"))

    def test_only_one_download_can_occupy_the_slot(self):
        self.start_download()
        with self.assertRaises(RuntimeError):
            self.jobs.start("alias")
        self.assertEqual(self.popen.call_count, 1)
        self.backend.SPEC_PACKAGE_BY_ID["different_package"] = {
            **self.backend.SPEC_PACKAGE_BY_ID["demo_q8"], "id": "different_package"}
        self.entries["alias"]["download_id"] = "different_package"
        with self.assertRaises(RuntimeError):
            self.jobs.start("alias")
        self.assertEqual(self.popen.call_count, 1)

    def test_progress_and_success_events_are_exposed(self):
        self.start_download()
        process = self.processes[0]
        process.event(phase="downloading", file="model.gguf", bytes=4, total=10, route="HF mirror direct")
        record = self.wait_status("downloading")
        self.assertEqual(record["route"], "HF mirror direct")
        self.assertGreaterEqual(record["bytes"], 4)
        process.event(phase="complete", package="demo_q8")
        process.finish(0)
        self.wait_status("done")

    def test_pause_uses_control_file_and_exit_75(self):
        self.start_download()
        result = self.jobs.control("demo", "pause")
        self.assertIn(result["status"], {"pausing", "paused"})
        controls = []
        for path in Path(self.backend.OUTPUT_DIR).rglob("*.json"):
            value = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(value, dict) and value.get("action") == "pause":
                controls.append(path)
        self.assertTrue(controls)
        self.processes[0].event(phase="paused")
        self.processes[0].finish(75)
        self.wait_status("paused")

    def test_recovered_live_pid_blocks_duplicate_process(self):
        self.start_download()
        recovered = downloads.DownloadJobs(self.backend)
        try:
            recovered.start("demo")
            self.assertEqual(self.popen.call_count, 1)
        finally:
            recovered.close()

    def test_paused_task_holds_slot_until_cancelled_then_can_switch(self):
        self.start_download()
        self.jobs.control("demo", "pause")
        self.processes[0].finish(75)
        self.wait_status("paused")
        with self.assertRaises(RuntimeError):
            self.jobs.start("alias")
        self.jobs.control("demo", "cancel")
        self.jobs.start("alias")
        self.assertEqual(len(self.jobs.list()), 1)
        self.assertEqual(self.jobs.list()[0]["model"], "alias")

    def test_stopped_recovered_process_can_resume(self):
        self.start_download()
        self.jobs.control("demo", "pause")
        self.processes[0].finish(75)
        self.wait_status("paused")
        recovered = downloads.DownloadJobs(self.backend)
        self.assertEqual(recovered.list()[0]["status"], "paused")
        recovered.close()


if __name__ == "__main__":
    unittest.main()
