"""Reference persistence and ASR ownership checks; no model inference or downloads."""
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import wave

from fastapi.testclient import TestClient

try:
    from webui import webui as legacy
    from .workbench_server import create_workbench_app
    from .workbench_metadata import task_for
except ImportError:
    import webui as legacy
    from workbench_server import create_workbench_app
    from workbench_metadata import task_for


class ReferenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.voices = root / "voice"
        self.voices.mkdir()
        patcher = patch.object(legacy, "PROMPTS_DIR", str(self.voices))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.entries = [dict(id="tts", label="TTS", family="pocket_tts", task="tts", installed=True),
                        dict(id="qwen3-asr", label="Qwen3-ASR 0.6B", family="qwen3_asr", task="asr", installed=True)]
        self.backend = SimpleNamespace(OUTPUT_DIR=str(root), APP_VERSION="test", LOCAL_VRAM_GB=None,
            SERVER_BACKEND="cpu", SPEC_PACKAGE_BY_ID={}, SERVER="http://127.0.0.1:8088", LANGS=[""],
            PROMPTS_DIR=str(self.voices), _server_proc=None, _loaded_id=None,
            catalog_by_id=lambda ident: next((e for e in self.entries if e["id"] == ident), None),
            catalog_models=lambda: self.entries, profile_for=lambda _: {}, params_for=lambda _: [],
            _webui_can_install_package=lambda _: False, server_status=lambda: "ready",
            _ensure_with_options=Mock(return_value="loaded"),
            unload_model=Mock(return_value=("已卸载", None)),
            do_asr_with_details=Mock(return_value=iter([("参考原话", "✅ 完成", None, None)])),
            **{name: getattr(legacy, name) for name in (
                "builtin_voices", "_load_voice_texts", "_builtin_voice_filename", "save_builtin_voice", "delete_builtin_voice")})
        downloads = SimpleNamespace(list=lambda: [], close=Mock())
        self.asr = SimpleNamespace(transcribe=Mock(return_value="参考原话"), cancel=Mock(), unload=Mock(), close=Mock(),
            status=Mock(return_value={"model": "qwen3-asr", "managed": True}))
        self.app = create_workbench_app(self.backend, realtime=False, download_manager=downloads, asr_manager=self.asr)
        self.client = TestClient(self.app)
        source = root / "sample.wav"
        with wave.open(str(source), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(b"\0\0" * 160)
        self.wav = source.read_bytes()

    def upload(self):
        result = self.client.post("/api/workbench/uploads", files={"file": ("sample.wav", self.wav)})
        self.assertEqual(result.status_code, 200)
        return result.json()["id"]

    def save(self, **changes):
        return self.client.post("/api/workbench/references", json={"name": "测试声音", "audio": self.upload(),
            "text": "第一行\n第二行", **changes})

    def wait_job(self, ident):
        for _ in range(100):
            result = self.client.get("/api/workbench/jobs/" + ident).json()
            if result["status"] in {"done", "error", "cancelled"}:
                return result
            time.sleep(.01)
        self.fail("reference ASR did not finish")

    def test_save_preview_edit_and_delete_use_legacy_store(self):
        saved = self.save().json()
        voice = saved["voices"][0]
        self.assertEqual((voice["name"], voice["label"], voice["text"]), ("测试声音.wav", "测试声音", "第一行 第二行"))
        self.assertEqual(self.client.get(voice["url"]).content, self.wav)
        self.assertEqual(self.client.get("/api/workbench/voices").json()["voices"], saved["voices"])
        result = self.client.post("/api/workbench/references", json={"name": "测试声音", "source": voice["name"],
            "text": "修正后的原文", "overwrite": True})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(legacy._load_voice_texts(), {"测试声音": "修正后的原文"})
        self.assertEqual(self.client.delete("/api/workbench/references/测试声音.wav").status_code, 200)
        self.assertFalse((self.voices / voice["name"]).exists())
        self.assertEqual(legacy._load_voice_texts(), {})

    def test_duplicate_requires_confirmation_and_preserves_existing_text(self):
        self.assertEqual(self.save().status_code, 200)
        self.assertEqual(self.save(text="未确认覆盖").status_code, 409)
        self.assertEqual(legacy._load_voice_texts()["测试声音"], "第一行 第二行")

    def test_paths_and_non_audio_uploads_never_reach_save_or_asr(self):
        with patch.object(self.backend, "save_builtin_voice") as save:
            self.assertEqual(self.save(name="../escape").status_code, 400)
            self.assertEqual(self.save(audio="C:/outside.wav").status_code, 400)
            self.assertEqual(self.save(audio="", source="../outside.wav").status_code, 404)
            save.assert_not_called()
        token = self.client.post("/api/workbench/uploads", files={"file": ("voice.pth", b"test")}).json()["id"]
        self.assertEqual(self.client.post("/api/workbench/reference-transcriptions", json={"audio": token}).status_code, 400)
        self.backend.do_asr_with_details.assert_not_called()
        self.asr.transcribe.assert_not_called()

    def test_transcription_uses_qwen_and_does_not_expose_paths(self):
        result = self.client.post("/api/workbench/reference-transcriptions", json={"audio": self.upload()})
        job = self.wait_job(result.json()["id"])
        self.assertEqual((job["status"], job["model"], job["text"]), ("done", "qwen3-asr", "参考原话"))
        self.assertNotIn("reference_audio", job)
        self.assertEqual(self.asr.transcribe.call_args.args[0], "qwen3-asr")
        self.backend.do_asr_with_details.assert_not_called()
        self.asr.unload.assert_not_called()
        self.assertEqual(self.client.get("/api/workbench/status").json()["asr"]["model"], "qwen3-asr")

    def test_saved_audio_can_be_retranscribed(self):
        name = self.save().json()["name"]
        result = self.client.post("/api/workbench/reference-transcriptions", json={"source": name})
        self.assertEqual(self.wait_job(result.json()["id"])["status"], "done")
        self.assertEqual(Path(self.asr.transcribe.call_args.args[1]), self.voices / name)

    def test_missing_model_realtime_and_existing_task_block_asr(self):
        token = self.upload()
        work = self.app.state.workbench
        work.lease("call", {"tts_model": "tts", "tts_server_source": "managed"})
        self.assertEqual(self.client.post("/api/workbench/reference-transcriptions", json={"audio": token}).status_code, 409)
        work.lease("call", None)
        work.reserve("other")
        self.assertEqual(self.client.post("/api/workbench/reference-transcriptions", json={"audio": token}).status_code, 409)
        work.release("other")
        self.entries[1]["installed"] = False
        self.assertEqual(self.client.post("/api/workbench/reference-transcriptions", json={"audio": token}).status_code, 400)
        self.backend.do_asr_with_details.assert_not_called()

    def test_resident_asr_holds_ownership_without_reloading_main_model(self):
        self.backend._server_proc = Mock()
        self.backend._server_proc.poll.return_value = None
        self.backend._loaded_id = "tts"
        self.backend._loaded_load_options = {"threads": "4"}
        self.backend._loaded_session_options = {"voice": "test"}
        self.backend._loaded_mode = "streaming"
        entered, finish = threading.Event(), threading.Event()
        def transcribe(*args, **kwargs):
            entered.set()
            finish.wait(3)
            return "参考原话"
        self.asr.transcribe.side_effect = transcribe
        ident = self.client.post("/api/workbench/reference-transcriptions", json={"audio": self.upload()}).json()["id"]
        try:
            self.assertTrue(entered.wait(2))
            self.assertEqual(self.client.get("/api/workbench/jobs/" + ident).json()["status"], "running")
            self.assertEqual(self.client.post("/api/workbench/models/tts/load", json={}).status_code, 409)
        finally:
            finish.set()
        self.assertEqual(self.wait_job(ident)["status"], "done")
        self.backend._ensure_with_options.assert_not_called()
        self.backend._server_proc.terminate.assert_not_called()
        self.assertEqual(self.backend._loaded_mode, "streaming")

    def test_asr_failure_releases_job_without_touching_main_model(self):
        self.backend._server_proc = Mock()
        self.backend._server_proc.poll.return_value = None
        self.backend._loaded_id = "tts"
        self.asr.transcribe.side_effect = RuntimeError("识别失败")
        ident = self.client.post("/api/workbench/reference-transcriptions", json={"audio": self.upload()}).json()["id"]
        self.assertEqual(self.wait_job(ident)["status"], "error")
        self.backend._ensure_with_options.assert_not_called()
        self.assertFalse(self.app.state.workbench.status()["busy"])

    def test_task_classification_keeps_conversion_and_processing_distinct(self):
        for family in ("builtin_audio_utils", "apollo", "audiosr", "personaplex", "universr"):
            self.assertEqual(task_for({"task": "s2s", "family": family}), "processing")
        self.assertEqual(task_for({"task": "s2s", "family": "vevo2"}), "processing")
        self.assertEqual(task_for({"task": "svc", "family": "seed_vc"}), "vc")
        self.assertEqual(task_for({"task": "s2s", "ui_task": "sep", "family": "sam_audio"}), "separation")

    def test_reference_asr_leaves_main_asrs_streaming_mode_unchanged(self):
        self.backend._server_proc = Mock()
        self.backend._server_proc.poll.return_value = None
        self.backend._loaded_id = "qwen3-asr"
        self.backend._loaded_mode = "streaming"
        ident = self.client.post("/api/workbench/reference-transcriptions", json={"audio": self.upload()}).json()["id"]
        self.assertEqual(self.wait_job(ident)["status"], "done")
        self.backend._ensure_with_options.assert_not_called()
        self.assertEqual(self.backend._loaded_mode, "streaming")

    def test_cancelling_reference_never_terminates_main_model(self):
        self.backend._server_proc = Mock()
        self.backend._server_proc.poll.return_value = None
        started, finish = threading.Event(), threading.Event()
        def transcribe(*_):
            started.set()
            finish.wait(3)
            return "参考原话"
        self.asr.transcribe.side_effect = transcribe
        ident = self.client.post("/api/workbench/reference-transcriptions", json={"audio": self.upload()}).json()["id"]
        try:
            self.assertTrue(started.wait(2))
            self.client.post(f"/api/workbench/jobs/{ident}/cancel")
            self.asr.cancel.assert_called_once()
            self.backend._server_proc.terminate.assert_not_called()
        finally:
            finish.set()
        self.assertEqual(self.wait_job(ident)["status"], "cancelled")

    def test_gpu_reference_scene_releases_main_only_when_budget_does_not_fit(self):
        self.backend.SERVER_BACKEND = "cuda"
        self.backend.LOCAL_VRAM_GB = 8
        self.backend._loaded_id = "tts"
        self.backend._server_proc = Mock()
        self.backend._server_proc.poll.return_value = None
        self.entries[0]["min_vram_gb"] = 2
        self.entries[1]["min_vram_gb"] = 3
        self.assertFalse(self.app.state.workbench.prepare_reference_memory("qwen3-asr"))
        self.backend.unload_model.assert_not_called()
        self.entries[0]["min_vram_gb"] = 6
        self.assertTrue(self.app.state.workbench.prepare_reference_memory("qwen3-asr"))
        self.backend.unload_model.assert_called_once()

    def test_other_scene_load_releases_asr_and_realtime_keeps_it(self):
        work = self.app.state.workbench
        self.backend._ensure_with_options.side_effect = lambda model, *_: work.before_load(model)
        self.backend.SERVER_BACKEND = "cuda"
        self.backend.LOCAL_VRAM_GB = 8
        self.entries[0]["min_vram_gb"] = 6
        self.entries[1]["min_vram_gb"] = 3
        self.assertEqual(self.client.post("/api/workbench/models/tts/load", json={}).status_code, 200)
        self.asr.unload.assert_called_once()
        self.asr.unload.reset_mock()
        work.lease("call", {"tts_model": "tts", "tts_server_source": "managed"})
        work.before_load("tts")
        self.asr.unload.assert_not_called()
        self.assertEqual(self.client.post("/api/workbench/unload-all", json={}).status_code, 409)
        work.lease("call", None)

    def test_small_models_and_cpu_scenes_keep_resident_asr(self):
        work = self.app.state.workbench
        self.backend.SERVER_BACKEND = "cuda"
        self.backend.LOCAL_VRAM_GB = 8
        self.entries[0]["min_vram_gb"] = 2
        self.entries[1]["min_vram_gb"] = 3
        work.before_load("tts")
        self.asr.unload.assert_not_called()
        self.entries[0]["backend"] = "cpu"
        self.entries[0].pop("min_vram_gb")
        work.before_load("tts")
        self.asr.unload.assert_not_called()

    def test_unload_all_releases_both_services_and_is_blocked_during_jobs(self):
        result = self.client.post("/api/workbench/unload-all", json={})
        self.assertEqual(result.status_code, 200)
        self.asr.unload.assert_called_once()
        self.backend.unload_model.assert_called_once()
        self.app.state.workbench.reserve("running")
        self.assertEqual(self.client.post("/api/workbench/unload-all", json={}).status_code, 409)


if __name__ == "__main__":
    unittest.main()
