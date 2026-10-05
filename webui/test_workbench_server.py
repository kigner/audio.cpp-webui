import json
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from fastapi.testclient import TestClient

try:
    from .workbench_server import create_workbench_app, JobRequest, Workbench
    from .workbench_metadata import model_detail
except ImportError:
    from workbench_server import create_workbench_app, JobRequest, Workbench
    from workbench_metadata import model_detail


class WorkbenchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = self.temp.name
        self.entry = dict(id="tts", label="Test voice", family="pocket_tts", task="tts",
                          installed=True, download_id="pocket", abs_path=root)
        self.b = SimpleNamespace(OUTPUT_DIR=root, CONFIG_DIR=root, APP_VERSION="0.6.0",
            SERVER_BACKEND="cpu", LOCAL_VRAM_GB=None, SERVER="http://127.0.0.1:8088",
            _loaded_id=None, _server_proc=None, LANGS=["", "english"], SPEC_PACKAGE_BY_ID={},
            catalog_by_id=lambda ident: self.entry if ident == self.entry["id"] else None,
            catalog_models=lambda: [self.entry], _webui_can_install_package=lambda p: False,
            profile_for=lambda e: {}, params_for=lambda ident: [], builtin_voices=lambda: [],
            server_status=lambda: "ready", _ensure_with_options=Mock(return_value="loaded"),
            unload_model=Mock(return_value=("released", "ready")))
        self.downloads = SimpleNamespace(list=lambda: [], close=Mock(), start=Mock(), control=Mock())
        self.app = create_workbench_app(self.b, realtime=False, download_manager=self.downloads)
        self.client = TestClient(self.app)

    def upload(self, name="input.wav"):
        response = self.client.post("/api/workbench/uploads", files={"file": (name, b"audio", "audio/wav")})
        self.assertEqual(response.status_code, 200)
        return response.json()["id"]

    def wait_job(self, ident):
        for _ in range(100):
            result = self.client.get(f"/api/workbench/jobs/{ident}").json()
            if result["status"] in {"done", "error", "cancelled"}:
                return result
            time.sleep(.01)
        self.fail("job did not finish")

    def test_catalog_and_static_page_without_model_or_network(self):
        response = self.client.get("/api/workbench/catalog")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["models"][0]["task"], "tts")
        self.assertEqual(len(response.json()["tasks"]), 7)
        self.assertEqual(self.client.get("/").status_code, 200)

    def test_uploaded_id_and_generated_file_are_scoped(self):
        ident = self.upload()
        seen = {}
        def generate(*args):
            seen["args"] = args
            out = Path(self.temp.name) / "result.wav"
            out.write_bytes(b"RIFF")
            return str(out), "✅ 完成"
        self.b.do_tts = generate
        response = self.client.post("/api/workbench/jobs", json={"task":"tts", "model":"tts",
                                    "inputs":{"text":"hello", "voice":ident}, "options":{"speed":1.2}})
        job = self.wait_job(response.json()["id"])
        self.assertEqual(job["status"], "done")
        self.assertTrue(Path(seen["args"][3]).is_relative_to(self.temp.name))
        self.assertEqual(seen["args"][-2], {"speed": 1.2})
        self.assertEqual(self.client.get(job["artifacts"][0]["url"]).content, b"RIFF")
        self.assertEqual(self.client.get("/api/workbench/files/arbitrary-path").status_code, 404)

    def test_untrusted_file_path_never_reaches_backend(self):
        self.b.do_tts = Mock()
        response = self.client.post("/api/workbench/jobs", json={"task":"tts", "model":"tts",
                                                   "inputs":{"text":"x", "voice":"C:/secrets.wav"}})
        self.assertEqual(self.wait_job(response.json()["id"])["status"], "error")
        self.b.do_tts.assert_not_called()

    def test_realtime_lease_blocks_switch_unload_and_job(self):
        work = self.app.state.workbench
        work.lease("call", {"tts_model":"tts", "tts_server_source":"managed"})
        self.assertEqual(self.client.post("/api/workbench/unload").status_code, 409)
        self.assertEqual(self.client.post("/api/workbench/models/tts/load", json={}).status_code, 409)
        self.assertEqual(self.client.post("/api/workbench/jobs", json={"task":"tts", "model":"tts"}).status_code, 409)
        work.lease("call", None)
        self.assertEqual(self.client.post("/api/workbench/models/tts/load", json={}).status_code, 200)

    def test_running_job_blocks_second_job_and_releases_on_error(self):
        entered, finish = threading.Event(), threading.Event()
        def fail(*args):
            entered.set()
            finish.wait(3)
            return None, "❌ 测试错误"
        self.b.do_tts = fail
        first = self.client.post("/api/workbench/jobs", json={"task":"tts", "model":"tts"}).json()
        self.assertTrue(entered.wait(2))
        try:
            self.assertEqual(self.client.post("/api/workbench/jobs", json={"task":"tts", "model":"tts"}).status_code, 409)
        finally:
            finish.set()
        self.assertEqual(self.wait_job(first["id"])["status"], "error")
        self.assertFalse(self.client.get("/api/workbench/status").json()["busy"])

    def test_analysis_retains_json_and_every_score_artifact(self):
        self.entry.update(task="midi", family="sheetsage2")
        files = []
        for name in ["data.json", "score.mid", "score.musicxml"]:
            path = Path(self.temp.name) / name
            path.write_text("test")
            files.append(str(path))
        self.b.do_analyze_with_files = Mock(return_value=("分析完成", files[0], files[1:], "✅ 完成"))
        ident = self.upload()
        response = self.client.post("/api/workbench/jobs", json={"task":"analysis", "model":"tts", "inputs":{"audio":ident}})
        job = self.wait_job(response.json()["id"])
        self.assertEqual(job["status"], "done")
        self.assertEqual({item["name"] for item in job["artifacts"]}, {"data.json", "score.mid", "score.musicxml"})

    def test_stream_audio_keeps_model_rate_and_cursor_prevents_replay(self):
        import base64
        import numpy as np
        out = Path(self.temp.name) / "stream.wav"
        out.write_bytes(b"RIFF")
        samples = np.array([10, -20], dtype=np.int16)
        self.b.do_tts_stream = lambda *args: iter([
            ((44100, samples), None, "生成中"), (None, str(out), "✅ 完成")])
        response = self.client.post("/api/workbench/jobs", json={"task":"tts", "model":"tts", "inputs":{"stream":True}})
        ident = response.json()["id"]
        result = self.wait_job(ident)
        part = result["audio_segments"][0]
        self.assertEqual(part["sample_rate"], 44100)
        self.assertEqual(base64.b64decode(part["pcm"]), samples.astype("<i2").tobytes())
        self.assertEqual(self.client.get(f"/api/workbench/jobs/{ident}?after=1").json()["audio_segments"], [])

    def test_cross_site_mutation_and_disallowed_upload_are_rejected(self):
        self.assertEqual(self.client.post("/api/workbench/unload", headers={"Origin":"https://evil.test"}).status_code, 403)
        self.assertEqual(self.client.post("/api/workbench/uploads", files={"file":("payload.exe",b"x")}).status_code, 400)

    def test_metadata_hides_unsupported_video_and_keeps_load_scope(self):
        self.entry["family"] = "sam_audio"
        self.b.params_for = lambda _: [
            {"name":"reference_image_path", "type":"text"},
            {"name":"reference_video_path", "type":"text"},
            {"name":"session_options.sam_audio.weight_type", "type":"text"}]
        detail = model_detail(self.b, self.entry)
        self.assertEqual(len(detail["parameters"]), 1)
        self.assertEqual(detail["parameters"][0]["scope"], "session")


if __name__ == "__main__":
    unittest.main()
