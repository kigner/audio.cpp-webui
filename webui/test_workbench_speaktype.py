import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

try:
    from .workbench_server import Workbench
    from .workbench_speaktype import SpeakTypeLauncher, install_speaktype_routes, language_contract
    MODULE = "webui.workbench_speaktype"
except ImportError:
    from workbench_server import Workbench
    from workbench_speaktype import SpeakTypeLauncher, install_speaktype_routes, language_contract
    MODULE = "workbench_speaktype"


class SpeakTypeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        client = root / "SpeakType"
        client.mkdir()
        (client / "run.py").write_text("", encoding="utf-8")
        self.config = {"asr": {"model": "asr", "input_gain_db": 7},
                       "ui": {"port": 18765}, "hotkeys": {"toggle_recording": "ctrl+shift+space"},
                       "vad": {"threshold": 0.35}, "injection": {"restore_clipboard": False}}
        (client / "config.json").write_text(json.dumps(self.config), encoding="utf-8")
        self.entries = [dict(id="asr", task="asr", family="asr", installed=True),
                        dict(id="offline", task="asr", family="offline", installed=True),
                        dict(id="missing", task="asr", family="asr", installed=False)]
        self.backend = SimpleNamespace(PROJECT_ROOT=str(root), OUTPUT_DIR=str(root), LOG_DIR=str(root),
            MODEL_SPECS={"asr": {"languages": ["auto", "zh", "en"], "options": {"request": [
                {"name": "language", "default": "auto"}]}}},
            catalog_models=lambda: self.entries, profile_for=lambda e: {"supports_streaming": e["family"] == "asr"})
        self.work = Workbench(self.backend)
        self.work.asr = Mock(server_url="http://127.0.0.1:8081")
        self.launcher = SpeakTypeLauncher(self.work)
        self.proc = Mock(pid=123)
        self.proc.poll.return_value = None
        self.addCleanup(self.launcher.close)

    def start(self, ui_language="zh"):
        with patch(MODULE + ".subprocess.Popen", return_value=self.proc) as spawn, \
             patch(MODULE + ".socket.socket"), \
             patch(MODULE + ".requests.Session") as session, \
             patch(MODULE + ".threading.Thread"):
            session.return_value.__enter__.return_value.get.return_value.json.return_value = {"pid": 123, "ready": True}
            result = self.launcher.start("asr", "zh", ui_language)
            return result, spawn.call_args

    def test_config_is_preserved_and_streaming_service_is_prepared(self):
        result, call = self.start()
        self.assertTrue(result["running"])
        self.work.asr.load.assert_called_once_with("asr", mode="streaming")
        generated = json.loads(Path(call.args[0][3]).read_text(encoding="utf-8"))
        self.assertEqual(generated["asr"]["language"], "zh")
        self.assertEqual(generated["asr"]["input_gain_db"], 7)
        self.assertEqual(generated["hotkeys"], self.config["hotkeys"])
        self.assertEqual(generated["injection"], self.config["injection"])
        self.assertEqual(self.launcher.config(), self.config)
        with self.assertRaisesRegex(Exception, "实时会话"):
            self.work.reserve("other-job")
        with self.assertRaisesRegex(RuntimeError, "实时会话"):
            self.work.lease("chat", {})
        self.launcher.stop()
        self.assertFalse(self.work.leases)
        self.assertFalse(Path(call.args[0][3]).exists())
        self.work.asr.unload.assert_not_called()

    def test_interface_language_does_not_change_recognition_language(self):
        _, call = self.start(ui_language="en")
        generated = json.loads(Path(call.args[0][3]).read_text(encoding="utf-8"))
        self.assertEqual(generated["ui"]["language"], "en")
        self.assertEqual(generated["asr"]["language"], "zh")
        self.assertEqual(self.launcher.config(), self.config)

    def test_duplicate_start_does_not_spawn_or_reload(self):
        self.start()
        with patch(MODULE + ".subprocess.Popen") as spawn:
            self.assertTrue(self.launcher.start("asr", "auto")["running"])
            spawn.assert_not_called()
        self.assertEqual(self.work.asr.load.call_count, 1)

    def test_port_conflict_never_loads_or_kills_external_process(self):
        with patch(MODULE + ".socket.socket") as sock:
            sock.return_value.__enter__.return_value.bind.side_effect = OSError("busy")
            with self.assertRaisesRegex(RuntimeError, "端口"):
                self.launcher.start("asr", "auto")
        self.work.asr.load.assert_not_called()
        self.assertFalse(self.work.leases)

    def test_load_failure_releases_lease(self):
        self.work.asr.load.side_effect = RuntimeError("load failed")
        with patch(MODULE + ".socket.socket"):
            with self.assertRaisesRegex(RuntimeError, "load failed"):
                self.launcher.start("asr", "auto")
        self.assertFalse(self.work.leases)
        self.assertIsNone(self.launcher.temp)

    def test_process_exit_cleans_up_and_allows_jobs(self):
        self.start()
        self.proc.poll.return_value = 0
        self.launcher._watch(self.proc)
        self.assertFalse(self.work.leases)
        self.work.reserve("next")
        self.work.release("next")

    def test_busy_workbench_rejects_launch_before_loading(self):
        self.work.reserve("busy")
        with patch(MODULE + ".socket.socket"):
            with self.assertRaisesRegex(RuntimeError, "工作台任务"):
                self.launcher.start("asr", "auto")
        self.work.asr.load.assert_not_called()

    def test_catalog_excludes_offline_and_missing_models(self):
        self.assertEqual([m["id"] for m in self.launcher.models()], ["asr"])
        with self.assertRaisesRegex(ValueError, "流式"):
            self.launcher.start("offline", "auto")

    def test_routes_validate_and_forward_start_stop(self):
        app = FastAPI()
        launcher = install_speaktype_routes(app, self.work)
        with TestClient(app) as client, patch.object(launcher, "start", return_value={"running": True}) as start:
            self.assertEqual(client.get("/api/workbench/speaktype").json()["toggle_hotkey"], "ctrl+shift+space")
            self.assertEqual(client.post("/api/workbench/speaktype/start", json={}).status_code, 422)
            self.assertEqual(client.post("/api/workbench/speaktype/start", json={"model": "asr"}).status_code, 200)
            start.assert_called_once_with("asr", "", "zh")
            client.post("/api/workbench/speaktype/start", json={"model": "asr", "language": "zh", "ui_language": "en"})
            start.assert_called_with("asr", "zh", "en")
            self.assertEqual(client.post("/api/workbench/speaktype/stop").status_code, 200)

    def test_real_model_language_contracts_exclude_invalid_auto(self):
        root = Path(__file__).resolve().parents[1] / "model_specs"
        for family, default in [("crisperwhisper", "en"), ("moonshine_asr", "")]:
            spec = json.loads((root / (family + ".json")).read_text(encoding="utf-8"))
            contract = language_contract({"family": family}, spec)
            self.assertNotIn("auto", contract["languages"])
            self.assertEqual(contract["language_default"], default)
            if family == "crisperwhisper":
                self.assertIn("zh", contract["languages"])
                self.assertEqual(set(contract["languages"]), set(spec["languages"]))
            else:
                self.assertEqual(contract["supported_languages"], ["en"])

    def test_invalid_language_is_rejected_before_loading(self):
        self.backend.MODEL_SPECS["asr"]["languages"] = ["en", "zh"]
        self.backend.MODEL_SPECS["asr"]["options"]["request"][0]["default"] = "en"
        with self.assertRaisesRegex(ValueError, "语言"):
            self.launcher.start("asr", "auto")
        self.work.asr.load.assert_not_called()

    def test_fixed_model_omits_language_in_generated_config(self):
        self.backend.MODEL_SPECS["asr"] = {"languages": ["en"]}
        with patch(MODULE + ".subprocess.Popen", return_value=self.proc) as spawn, \
             patch(MODULE + ".socket.socket"), patch(MODULE + ".requests.Session") as session, \
             patch(MODULE + ".threading.Thread"):
            session.return_value.__enter__.return_value.get.return_value.json.return_value = {"pid": 123, "ready": True}
            self.launcher.start("asr", "")
            config = json.loads(Path(spawn.call_args.args[0][3]).read_text(encoding="utf-8"))
            self.assertEqual(config["asr"]["language"], "")


if __name__ == "__main__":
    unittest.main()
