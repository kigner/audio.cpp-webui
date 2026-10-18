import io
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import wave

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

try:
    from . import workbench_scenarios as scenarios
    from .workbench_server import Workbench
except ImportError:
    import workbench_scenarios as scenarios
    from workbench_server import Workbench


def audio(path, duration=.4):
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\0\0" * int(duration * 16000))
    return str(path)


class ScenarioTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.entries = [dict(id="crisperwhisper", label="Whisper", family="crisperwhisper", task="asr", installed=True),
                        dict(id="qwen3-asr", label="Qwen", family="qwen3_asr", task="asr", installed=True),
                        dict(id="pocket-tts", label="Pocket", family="pocket_tts", task="tts", installed=True)]
        self.b = SimpleNamespace(OUTPUT_DIR=str(self.root), LOCAL_VRAM_GB=8,
            catalog_models=lambda: self.entries, catalog_by_id=lambda ident: next((e for e in self.entries if e["id"] == ident), None),
            profile_for=lambda e: {}, params_for=lambda i: [], _server_proc=None,
            MODEL_SPECS={"crisperwhisper": {"languages": ["zh", "en"], "capabilities": {"asr": ["word_timestamps"]},
                                          "options": {"request": [{"name": "return_timestamps"}, {"name": "language"}]}},
                         "qwen3_asr": {"languages": ["zh", "en"]}, "pocket_tts": {"languages": ["en"]}})
        self.work = Workbench(self.b)
        self.app = FastAPI()
        self.store = scenarios.install_scenario_routes(self.app, self.work)
        @self.app.exception_handler(ValueError)
        async def value_error(_request, error):
            return JSONResponse({"detail": str(error)}, status_code=400)
        self.client = TestClient(self.app)
        self.source = self.root / "input.wav"
        audio(self.source, 8)

    def create(self, subtitles=True, source_path=""):
        info = dict(duration=8, has_video=False, has_audio=True, sample_rate=16000, channels=1)
        with patch.object(scenarios.media, "probe_media", return_value=info):
            files = {"file": ("示例.wav", self.source.read_bytes(), "audio/wav")}
            if subtitles:
                files["subtitle"] = ("字幕.srt", "1\n00:00:01,000 --> 00:00:03,000\n你好\n\n2\n00:00:04,000 --> 00:00:06,000\n世界\n".encode(), "text/plain")
            response = self.client.post(scenarios.PREFIX + "/projects", files=files, data={"source_path": source_path})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def update(self, p, **changes):
        response = self.client.patch(scenarios.PREFIX + "/projects/" + p["id"], json={"revision": p["revision"], **changes})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def get(self, p):
        return self.client.get(scenarios.PREFIX + "/projects/" + p["id"]).json()

    def submit(self, p, action, **values):
        response = self.client.post(scenarios.PREFIX + "/projects/" + p["id"] + "/actions", json={"revision": p["revision"], "action": action, **values})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["id"]

    def wait(self, job):
        for _ in range(200):
            result = self.client.get(scenarios.PREFIX + "/jobs/" + job).json()
            if result["status"] in scenarios.TERMINAL:
                return result
            time.sleep(.01)
        self.fail("job did not finish")

    def test_project_copies_source_and_survives_service_restart(self):
        p = self.create()
        self.assertEqual(self.client.get(p["media"]["url"]).content, self.source.read_bytes())
        p = self.update(p, name="保存后的工程")
        recovered = scenarios.ScenarioProjects(self.work)
        self.assertEqual(recovered.read(p["id"])["name"], "保存后的工程")
        self.assertEqual(len(recovered.list()["projects"]), 1)
        self.assertNotIn("path", p["media"])
        uploaded = Path(p["media"]["uploaded_path"])
        self.assertTrue(uploaded.is_absolute())
        self.assertEqual(uploaded.read_bytes(), self.source.read_bytes())
        self.assertNotIn("source_path", p["media"])
        self.assertEqual(self.source.stat().st_size, 256044)

    def test_original_path_is_verified_and_persisted_separately_from_upload(self):
        p = self.create(False, source_path=str(self.source.resolve()))
        self.assertEqual(p["media"]["source_path"], str(self.source.resolve()))
        self.assertNotEqual(p["media"]["uploaded_path"], p["media"]["source_path"])
        self.assertEqual(self.get(p)["media"]["source_path"], p["media"]["source_path"])
        self.assertEqual(self.source.stat().st_size, 256044)

    def test_invalid_or_mismatched_original_paths_are_rejected(self):
        different = self.root / "different.wav"
        different.write_bytes(b"x" * self.source.stat().st_size)
        fake = self.root / "fakepath" / "input.wav"
        fake.parent.mkdir()
        fake.write_bytes(self.source.read_bytes())
        cases = [("input.wav", "绝对路径"), (str(fake), "fakepath"),
                 (str(self.root / "missing.wav"), "不存在"), (str(self.root), "不是文件"),
                 (str(different), "内容与上传素材不一致")]
        for path, message in cases:
            with self.subTest(path=path):
                response = self.client.post(scenarios.PREFIX + "/projects",
                    files={"file": ("素材.wav", self.source.read_bytes(), "audio/wav")}, data={"source_path": path})
                self.assertEqual(response.status_code, 400, response.text)
                self.assertIn(message, response.json()["detail"])
                self.assertEqual(self.store.list()["projects"], [])

    def test_empty_draft_patch_allows_first_recognition(self):
        p = self.update(self.create(False), segments=[], asr_model="crisperwhisper", source_language="zh",
                        confirmed_source=False, confirmed_translation=False, confirmed_audio=False)
        self.assertEqual(p["segments"], [])
        self.b.do_asr_with_details = Mock(return_value=iter([("你好", "✅", [{"result": {
            "text": "你好", "sample_rate": 16000,
            "words": [{"word": "你好", "start_sample": 16000, "end_sample": 32000}]}}], None)]))
        with patch.object(scenarios.media, "extract_audio", return_value=str(self.source)), \
                patch.object(scenarios.media, "audio_duration", return_value=8):
            result = self.wait(self.submit(p, "recognize"))
        self.assertEqual(result["status"], "done", result)
        self.assertEqual(self.get(p)["segments"][0]["text"], "你好")
        self.b.do_asr_with_details.assert_called_once()

    def test_empty_draft_requires_list_and_cannot_be_confirmed_or_exported(self):
        p = self.create(False)
        route = scenarios.PREFIX + "/projects/" + p["id"]
        for invalid in (None, {}, "", 0, False):
            with self.subTest(invalid=invalid):
                response = self.client.patch(route, json={"revision": p["revision"], "segments": invalid})
                self.assertEqual(response.status_code, 400, response.text)
                self.assertIn("列表", response.json()["detail"])
        for key in ("confirmed_source", "confirmed_translation", "confirmed_audio"):
            response = self.client.patch(route, json={"revision": p["revision"], "segments": [], key: True})
            self.assertEqual(response.status_code, 400, response.text)
        for action in ("translate", "synthesize", "mix", "export"):
            response = self.client.post(route + "/actions", json={"revision": p["revision"], "action": action})
            self.assertEqual(response.status_code, 400, response.text)
        result = self.wait(self.submit(p, "export_subtitles"))
        self.assertEqual(result["status"], "error")
        self.assertIn("没有可导出", result["message"])

    def test_clearing_cues_invalidates_review_audio_and_exports(self):
        p = self.create()
        raw = self.store.read(p["id"])
        raw.update(confirmed_source=True, confirmed_translation=True, confirmed_audio=True,
                   preview={"path": "mix.wav", "name": "预览"}, exports=[{"path": "result.srt", "name": "字幕"}])
        self.store.save(raw)
        p = self.update(p, segments=[])
        self.assertEqual(p["segments"], [])
        self.assertFalse(p["confirmed_source"])
        self.assertFalse(p["confirmed_translation"])
        self.assertFalse(p["confirmed_audio"])
        self.assertIsNone(p["preview"])
        self.assertEqual(p["exports"], [])

    def test_recommendations_require_installed_language_support_and_auto_detection(self):
        cap = self.store.capabilities("auto", "en")
        self.assertEqual(cap["recommended_asr"]["id"], "qwen3-asr")
        self.assertEqual(cap["recommended_tts"]["id"], "pocket-tts")
        self.assertIsNone(self.store.capabilities("ja", "zh")["recommended_tts"])
        self.assertEqual(self.store.capabilities("zh", "en")["recommended_asr"]["id"], "crisperwhisper")
        self.entries[2]["installed"] = False
        self.assertIsNone(self.store.capabilities()["recommended_tts"])

    def test_review_gate_and_revision_conflict(self):
        p = self.create()
        route = scenarios.PREFIX + "/projects/" + p["id"]
        response = self.client.post(route + "/actions", json={"revision": p["revision"], "action": "translate"})
        self.assertEqual(response.status_code, 400)
        updated = self.update(p, confirmed_source=True)
        self.assertEqual(self.client.patch(route, json={"revision": p["revision"], "name": "过期"}).status_code, 409)
        self.assertEqual(self.client.patch(route, json={"revision": updated["revision"], "confirmed_translation": True}).status_code, 400)

    def test_source_edit_invalidates_only_related_translation_and_audio(self):
        p = self.create()
        raw = self.store.read(p["id"])
        for c in raw["segments"]:
            c["translation"] = "Hello"
            c["audio"] = {"path": "same.wav", "duration": 1, "overflow": False}
        raw.update(confirmed_source=True, confirmed_translation=True, confirmed_audio=True,
                   preview={"path": "mix.wav", "name": "预览"})
        self.store.save(raw)
        p = self.get(p)
        p["segments"][0]["text"] = "新原文"
        updated = self.update(p, segments=p["segments"])
        self.assertEqual(updated["segments"][0]["translation"], "")
        self.assertNotIn("audio", updated["segments"][0])
        self.assertIn("audio", updated["segments"][1])
        self.assertFalse(updated["confirmed_source"])
        self.assertFalse(updated["confirmed_audio"])
        self.assertIsNone(updated["preview"])

    def test_time_edit_keeps_translation_and_raw_speech_and_rechecks_neighbors(self):
        p = self.update(self.create(), video_follows_audio=False)
        raw = self.store.read(p["id"])
        for cue in raw["segments"]:
            cue["translation"] = "Hello"
            cue["audio"] = {"path": f"speech-{cue['id']}.wav", "duration": 2.8, "overflow": .3}
        raw.update(confirmed_source=True, confirmed_translation=True, confirmed_audio=True,
                   preview={"path": "mix.wav", "name": "试听"})
        self.store.save(raw)
        p = self.get(p)
        p["segments"][0]["end"] = 3.9
        updated = self.update(p, segments=p["segments"])
        self.assertEqual(updated["segments"][0]["translation"], "Hello")
        self.assertIn("speech-1.wav", updated["segments"][0]["audio"]["url"])
        self.assertEqual(updated["segments"][0]["audio"]["overflow"], 0)
        self.assertFalse(updated["confirmed_audio"])
        self.assertIsNone(updated["preview"])
        updated["segments"][1]["start"] = 3.5
        moved = self.update(updated, segments=updated["segments"])
        self.assertGreater(moved["segments"][0]["audio"]["overlap"], 0)

    def test_translation_is_new_llm_output_and_key_never_persists(self):
        p = self.update(self.create(), confirmed_source=True)
        response = Mock(status_code=200)
        response.json.return_value = {"choices": [{"message": {"content": '{"translations":[{"id":"1","text":"Hello"},{"id":"2","text":"World"}]}'}}]}
        llm = Mock()
        llm.__enter__ = Mock(return_value=llm)
        llm.__exit__ = Mock(return_value=False)
        llm.post.return_value = response
        with patch.object(scenarios.httpx, "Client", return_value=llm):
            result = self.wait(self.submit(p, "translate", llm={"url": "https://provider.test/v1", "model": "model", "key": "secret-test-key"}))
        self.assertEqual(result["status"], "done", result)
        p = self.get(p)
        self.assertEqual([c["translation"] for c in p["segments"]], ["Hello", "World"])
        self.assertFalse(p["confirmed_translation"])
        self.assertEqual(llm.post.call_args.kwargs["headers"]["Authorization"], "Bearer secret-test-key")
        self.assertNotIn("secret-test-key", json.dumps(p) + json.dumps(result) + (self.store.directory(p["id"]) / "project.json").read_text())

    def test_translation_malformed_response_preserves_prior_data(self):
        p = self.update(self.create(), confirmed_source=True)
        response = Mock(status_code=200)
        response.json.return_value = {"choices": [{"message": {"content": '{"translations":[{"id":"wrong","text":"Hello"}]}'}}]}
        llm = Mock()
        llm.__enter__ = Mock(return_value=llm)
        llm.__exit__ = Mock(return_value=False)
        llm.post.return_value = response
        with patch.object(scenarios.httpx, "Client", return_value=llm):
            result = self.wait(self.submit(p, "translate", llm={"url": "https://provider.test/v1", "model": "model"}))
        self.assertEqual(result["status"], "error")
        self.assertEqual(self.get(p)["segments"][0]["translation"], "")

    def test_cancel_during_asr_does_not_commit_late_response(self):
        p = self.update(self.create(False), asr_model="crisperwhisper", source_language="zh")
        entered, finish = threading.Event(), threading.Event()
        def recognize(*args):
            entered.set()
            finish.wait(2)
            yield "你好", "✅", [{"result": {"sample_rate": 16000, "words": [{"word": "你好", "start_sample": 16000, "end_sample": 32000}]}}], None
        self.b.do_asr_with_details = recognize
        with patch.object(scenarios.media, "extract_audio", return_value=str(self.source)):
            job = self.submit(p, "recognize")
            self.assertTrue(entered.wait(2))
            response = self.client.post(scenarios.PREFIX + "/jobs/" + job + "/cancel")
            self.assertEqual(response.json()["status"], "cancelling")
            finish.set()
            result = self.wait(job)
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(self.get(p)["segments"], [])
        self.assertIsNone(self.work.active_job)

    def test_edit_during_asr_prevents_late_result_overwrite(self):
        p = self.update(self.create(False), asr_model="crisperwhisper", source_language="zh")
        entered, finish = threading.Event(), threading.Event()
        def recognize(*args):
            entered.set()
            finish.wait(2)
            yield "你好", "✅", [{"result": {"segments": [{"text": "你好", "start": 1, "end": 2}]}}], None
        self.b.do_asr_with_details = recognize
        with patch.object(scenarios.media, "extract_audio", return_value=str(self.source)):
            job = self.submit(p, "recognize")
            self.assertTrue(entered.wait(2))
            p = self.update(p, name="用户新名称")
            finish.set()
            result = self.wait(job)
        self.assertEqual(result["status"], "error")
        self.assertIn("过期", result["message"])
        self.assertEqual(self.get(p)["name"], "用户新名称")
        self.assertEqual(self.get(p)["segments"], [])

    def test_selected_sentence_tts_preserves_other_audio_and_uses_target_language(self):
        p = self.update(self.create(), confirmed_source=True)
        cues = p["segments"]
        for c in cues:
            c["translation"] = "Hello"
        p = self.update(p, segments=cues, confirmed_translation=True)
        generated = audio(self.root / "generated.wav")
        self.b.do_tts = Mock(return_value=(generated, "✅"))
        with patch.object(scenarios.media, "extract_audio", return_value=str(self.source)):
            result = self.wait(self.submit(p, "synthesize", segment_ids=[1]))
        self.assertEqual(result["status"], "done", result)
        p = self.get(p)
        self.assertIn("audio", p["segments"][0])
        self.assertNotIn("audio", p["segments"][1])
        self.assertEqual(self.b.do_tts.call_args.args[2], "en")
        self.assertFalse(p["confirmed_audio"])
        self.assertEqual(self.work.job(result["id"])["audio_segments"], [])

    def reference_project(self):
        self.entries.extend([
            dict(id="qwen-base", family="qwen3_tts", task="tts", installed=True),
            dict(id="qwen-custom", family="qwen3_tts", task="tts", installed=True),
            dict(id="optional", family="optional", task="tts", installed=True)])
        profiles = {"qwen-base": {"require_voice": True, "require_reference_text": True},
                    "qwen-custom": {"accepts_voice_reference": False, "send_reference_text": False}}
        self.b.profile_for = lambda entry: profiles.get(entry["id"], {})
        p = self.update(self.create(), tts_model="qwen-base", confirmed_source=True, has_background=False)
        cues = p["segments"]
        for cue in cues:
            cue["translation"] = "Hello"
        p = self.update(p, segments=cues, confirmed_translation=True)
        self.b.do_tts = Mock(return_value=(audio(self.root / "generated.wav"), "✅"))
        return p

    def test_reference_capabilities_follow_model_variant(self):
        self.reference_project()
        models = {m["id"]: m for m in self.store.capabilities()["tts_models"]}
        self.assertTrue(models["qwen-base"]["require_voice"])
        self.assertTrue(models["qwen-base"]["requires_reference_text"])
        self.assertFalse(models["qwen-custom"]["accepts_voice_reference"])
        self.assertFalse(models["qwen-custom"]["send_reference_text"])
        self.assertTrue(models["optional"]["accepts_voice_reference"])
        self.assertFalse(models["optional"]["require_voice"])

    def test_uploaded_reference_is_durable_and_used_with_its_transcript(self):
        p = self.reference_project()
        self.work.uploads["reference-upload"] = self.source
        p = self.update(p, tts_reference_upload="reference-upload", tts_reference_name="声音.wav",
                        tts_reference_mode="upload", tts_reference_text="你好世界")
        self.assertNotIn("path", p["tts_reference"])
        self.assertEqual(self.client.get(p["tts_reference"]["url"]).content, self.source.read_bytes())
        self.work.uploads.clear()
        recovered = scenarios.ScenarioProjects(self.work).read(p["id"])
        self.assertEqual(recovered["tts_reference_text"], "你好世界")
        public = self.store.public(recovered)
        self.assertEqual(public["tts_reference"]["input_id"], p["tts_reference"]["input_id"])
        self.assertEqual(Path(self.work.input_path(public["tts_reference"]["input_id"])).read_bytes(), self.source.read_bytes())
        with patch.object(scenarios.media, "extract_audio", return_value=str(self.source)):
            result = self.wait(self.submit(p, "synthesize", segment_ids=[1]))
        self.assertEqual(result["status"], "done", result)
        args = self.b.do_tts.call_args.args
        self.assertEqual(args[2], "english")
        self.assertEqual(Path(args[3]).read_bytes(), self.source.read_bytes())
        self.assertNotEqual(Path(args[3]), self.source)
        self.assertEqual(args[5], "你好世界")
        p = self.update(self.get(p), tts_reference_text="新的参考原文")
        self.assertNotIn("audio", p["segments"][0])

    def test_reference_validation_precedes_job_and_model_loading(self):
        p = self.reference_project()
        for mode, message in (("none", "必须提供参考音频"), ("upload", "请先上传")):
            p = self.update(p, tts_reference_mode=mode)
            response = self.client.post(scenarios.PREFIX + "/projects/" + p["id"] + "/actions",
                                        json={"revision": p["revision"], "action": "synthesize"})
            self.assertEqual(response.status_code, 400)
            self.assertIn(message, response.json()["detail"])
        self.work.uploads["reference-upload"] = self.source
        p = self.update(p, tts_reference_upload="reference-upload", tts_reference_text="")
        response = self.client.post(scenarios.PREFIX + "/projects/" + p["id"] + "/actions",
                                   json={"revision": p["revision"], "action": "synthesize"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("参考原文", response.json()["detail"])
        self.b.do_tts.assert_not_called()
        self.assertIsNone(self.work.active_job)

    def test_library_selection_copies_audio_and_matching_text_without_using_upload(self):
        p = self.reference_project()
        self.b.PROMPTS_DIR = str(self.root)
        self.b.builtin_voices = lambda: ["input.wav"]
        self.b._load_voice_texts = lambda: {"input": "音频库的原文"}
        p = self.update(p, tts_reference_library="input.wav", tts_reference_mode="library", tts_reference_text="未启用的上传原文")
        self.assertNotIn("path", p["tts_library_reference"])
        self.assertEqual(p["tts_library_reference"]["text"], "音频库的原文")
        self.assertEqual(self.client.get(p["tts_library_reference"]["url"]).content, self.source.read_bytes())
        # The task owns a durable snapshot even if the library changes later.
        self.b.builtin_voices = lambda: []
        self.b._load_voice_texts = lambda: {}
        with patch.object(scenarios.media, "extract_audio", return_value=str(self.source)):
            result = self.wait(self.submit(p, "synthesize", segment_ids=[1]))
        self.assertEqual(result["status"], "done", result)
        self.assertEqual(self.b.do_tts.call_args.args[5], "音频库的原文")
        self.assertIn("voice-library-", self.b.do_tts.call_args.args[3])
        p = self.update(self.get(p), tts_reference_library="", tts_reference_mode="library")
        response = self.client.post(scenarios.PREFIX + "/projects/" + p["id"] + "/actions",
                                   json={"revision": p["revision"], "action": "synthesize"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("从音频库选择", response.json()["detail"])

    def test_library_selection_rejects_paths_outside_the_library(self):
        p = self.reference_project()
        self.b.PROMPTS_DIR = str(self.root)
        self.b.builtin_voices = lambda: ["input.wav"]
        for name in ("../input.wav", str(self.source), "missing.wav"):
            response = self.client.patch(scenarios.PREFIX + "/projects/" + p["id"],
                                        json={"revision": p["revision"], "tts_reference_library": name})
            self.assertEqual(response.status_code, 404)
        self.assertNotIn("tts_library_reference", self.get(p))

    def test_reference_mode_switch_never_leaks_hidden_audio_or_text(self):
        p = self.reference_project()
        for model, mode, expected_reference in (("qwen-base", "original", True),
                                                ("optional", "original", True),
                                                ("optional", "none", False),
                                                ("qwen-custom", "upload", False)):
            with self.subTest(model=model, mode=mode):
                p = self.update(p, tts_model=model, tts_reference_mode=mode, tts_reference_text="unused")
                with patch.object(scenarios.media, "extract_audio", return_value=str(self.source)):
                    result = self.wait(self.submit(p, "synthesize", segment_ids=[1]))
                self.assertEqual(result["status"], "done", result)
                args = self.b.do_tts.call_args.args
                self.assertEqual(bool(args[3]), expected_reference)
                self.assertEqual(args[5], "你好" if expected_reference else "")
                p = self.get(p)
        p = self.update(p, tts_model="qwen-base")
        self.assertNotIn("tts_reference_mode", p)
        self.assertEqual(self.store.tts_reference_mode(p, self.b.profile_for(self.entries[-3])), "original")

    def test_reference_upload_rejects_expired_and_overlong_audio(self):
        p = self.reference_project()
        endpoint = scenarios.PREFIX + "/projects/" + p["id"]
        response = self.client.patch(endpoint, json={"revision": p["revision"], "tts_reference_upload": "expired"})
        self.assertEqual(response.status_code, 400)
        self.work.uploads["long"] = Path(audio(self.root / "long.wav", 31))
        response = self.client.patch(endpoint, json={"revision": p["revision"], "tts_reference_upload": "long"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("30秒", response.json()["detail"])
        self.assertNotIn("tts_reference", self.get(p))

    def test_subtitle_export_roundtrip_and_paths_are_scoped(self):
        p = self.create()
        result = self.wait(self.submit(p, "export_subtitles", format="vtt", layer="source"))
        self.assertEqual(result["status"], "done", result)
        p = self.get(p)
        text = self.client.get(p["exports"][0]["url"]).text
        self.assertTrue(text.startswith("WEBVTT"))
        self.assertEqual(len(scenarios.media.parse_subtitles(text)), 2)
        with self.assertRaises(HTTPException):
            self.store.file(p["id"], "../input.wav")
        self.assertEqual(self.client.get(scenarios.PREFIX + "/projects/" + p["id"] + "/files/project.json").status_code, 404)

    def scene_runtime(self, project_id, model="crisperwhisper"):
        """Simulate the same load/ready hooks used by the managed inference path."""
        proc = Mock()
        proc.poll.return_value = None
        self.b._server_proc, self.b._loaded_id = proc, model
        ident = "load-" + project_id
        self.work.reserve(ident)
        self.work.jobs[ident] = dict(id=ident, project_id=project_id, task="asr", cancel=threading.Event())
        self.work.before_load(model)
        self.work.after_load(model)
        self.work.release(ident)
        def unload():
            proc.poll.return_value = 0
            self.b._server_proc = self.b._loaded_id = None
        self.b.unload_model = Mock(side_effect=unload)
        return proc

    def test_export_releases_scene_model_and_new_material_loads_selected_model(self):
        p = self.update(self.create(), asr_model="crisperwhisper", tts_model="pocket-tts")
        self.scene_runtime(p["id"], "crisperwhisper-align")
        result = self.wait(self.submit(p, "export_subtitles", format="srt", layer="source"))
        self.assertEqual(result["status"], "done", result)
        self.b.unload_model.assert_called_once()
        exported = self.get(p)
        self.assertEqual(exported["asr_model"], "crisperwhisper")
        self.assertEqual(exported["tts_model"], "pocket-tts")
        self.assertTrue(self.client.get(exported["exports"][0]["url"]).text.startswith("1\n"))
        p = self.update(self.create(False), asr_model="crisperwhisper", source_language="zh", has_background=False)
        loaded = []
        def recognize(model, *_args, **_kwargs):
            self.work.before_load(model)
            self.assertIsNone(self.b._server_proc)
            self.b._server_proc = Mock()
            self.b._server_proc.poll.return_value = None
            self.b._loaded_id = model
            self.work.after_load(model)
            loaded.append(model)
            yield "你好", "", [{"result": {"text": "你好", "sample_rate": 16000,
                       "words": [{"word": "你好", "start_sample": 16000, "end_sample": 32000}]}}], None
        self.b.do_asr_with_details = recognize
        with patch.object(scenarios.media, "extract_audio", return_value=str(self.source)), \
                patch.object(scenarios.media, "audio_duration", return_value=8):
            result = self.wait(self.submit(p, "recognize"))
        self.assertEqual(result["status"], "done", result)
        self.assertEqual(loaded, ["crisperwhisper"])
        self.assertEqual(self.work.scenario_runtime[0], p["id"])

    def test_confirm_source_releases_audio_model_before_loading_local_translation_llm(self):
        p = self.update(self.create(), scenario="dubbing")
        self.scene_runtime(p["id"])
        p = self.update(p, confirmed_source=True)
        self.b.unload_model.assert_called_once()
        self.assertIsNone(self.b._server_proc)
        self.assertTrue(p["confirmed_source"])
        self.update(p, name="继续校对")
        self.b.unload_model.assert_called_once()

    def test_translation_action_also_releases_model_on_return_from_dubbing(self):
        p = self.update(self.create(), scenario="dubbing", confirmed_source=True)
        self.scene_runtime(p["id"], "pocket-tts")
        def translate(_job, _p, _request):
            self.assertIsNone(self.b._server_proc)
        with patch.object(self.store, "translate", side_effect=translate):
            result = self.wait(self.submit(p, "translate"))
        self.assertEqual(result["status"], "done", result)
        self.b.unload_model.assert_called_once()

    def test_final_export_releases_voice_model_but_mix_and_sentence_work_reuse_it(self):
        p = self.update(self.create(), confirmed_source=True)
        for cue in p["segments"]:
            cue["translation"] = "Hello"
        p = self.update(p, segments=p["segments"], confirmed_translation=True)
        self.scene_runtime(p["id"], "pocket-tts")
        with patch.object(self.store, "synthesize"), patch.object(self.store, "mix"), patch.object(self.store, "export"):
            for action in ("synthesize", "mix"):
                result = self.wait(self.submit(p, action))
                self.assertEqual(result["status"], "done", result)
                self.b.unload_model.assert_not_called()
                p = self.get(p)
            raw = self.store.read(p["id"])
            raw["confirmed_audio"] = True
            self.store.save(raw)
            result = self.wait(self.submit(p, "export"))
        self.assertEqual(result["status"], "done", result)
        self.b.unload_model.assert_called_once()

    def test_scene_cleanup_does_not_unload_foreign_replaced_or_borrowed_runtime(self):
        p = self.create()
        for condition in ("external", "new_process", "other_project", "manual_load", "realtime", "other_job", "busy_request_thread"):
            with self.subTest(condition=condition):
                self.work.leases.clear()
                self.work.active_job = None
                self.scene_runtime(p["id"])
                if condition == "external":
                    self.b._server_proc = None
                elif condition == "new_process":
                    self.b._server_proc = Mock()
                    self.b._server_proc.poll.return_value = None
                elif condition == "manual_load":
                    self.work.local.operation = "manual-load"
                    self.work.before_load("crisperwhisper")
                elif condition == "realtime":
                    self.work.lease("call", {"tts_server_source": "managed", "tts_model": "crisperwhisper"})
                elif condition == "other_job":
                    self.work.active_job = "another-task"
                elif condition == "busy_request_thread":
                    # reserve() also leaves a thread-local ID on the HTTP thread;
                    # it must not authorize an unrelated PATCH to stop the worker.
                    self.work.reserve("new-operation")
                self.assertFalse(self.work.release_scenario_model("other" if condition == "other_project" else p["id"]))
                self.b.unload_model.assert_not_called()

    def test_background_separation_is_bounded_and_restores_each_source_duration(self):
        p = self.create()
        raw = self.store.read(p["id"])
        raw["media"]["duration"] = 46.25
        raw["has_background"] = True
        self.store.save(raw)
        self.entries.append(dict(id="htdemucs-6stems", family="htdemucs_6stems", task="sep", installed=True))
        vocal = audio(self.root / "model_vocals.wav")
        other = audio(self.root / "model_other.wav")
        self.b.do_sep = Mock(return_value=({}, [vocal, other], "✅"))
        def extract(source, dest, **kwargs):
            return audio(dest)
        def concatenate(paths, dest, **kwargs):
            return audio(dest)
        def background(paths, dest, duration, **kwargs):
            return audio(dest)
        job = dict(id="unit-separation", project_id=p["id"], project_revision=p["revision"], cancel=threading.Event())
        with patch.object(scenarios.media, "extract_audio", side_effect=extract) as extracts, \
             patch.object(scenarios.media, "concatenate_audio", side_effect=concatenate) as concatenates, \
             patch.object(scenarios.media, "mix_background", side_effect=background):
            result = self.store.ensure_audio(job, raw)
        self.assertEqual(self.b.do_sep.call_count, 3)
        self.assertEqual([call.kwargs["duration"] for call in extracts.call_args_list[1:]], [20, 20, 6.25])
        self.assertEqual([call.kwargs["durations"] for call in concatenates.call_args_list], [[20, 20, 6.25]] * 2)
        self.assertTrue(Path(result).is_file())
        self.assertTrue(raw["separated"])
        self.assertEqual(self.source.stat().st_size, 256044)

    def test_background_separation_recovers_only_one_confirmed_managed_crash(self):
        self.entries.append(dict(id="htdemucs-6stems", family="htdemucs_6stems", task="sep", installed=True))
        vocal = audio(self.root / "model_vocals.wav")
        other = audio(self.root / "model_other.wav")
        cases = [
            ("recover", {2}, [0, 1, 1, 2], None),
            ("delayed_exit", {2}, [0, 1, 1, 2], None),
            ("repeat_crash", {2, 3}, [0, 1, 1], "0xC0000005.*片段 2 / 3"),
            ("later_crash", {1, 3}, [0, 0, 1], "0xC0000005.*片段 2 / 3"),
            ("still_alive", {1}, [0], "连接中断"),
            ("clean_exit", {1}, [0], "连接中断"),
            ("external_server", {1}, [0], "连接中断"),
            ("different_model", {1}, [0], "连接中断"),
            ("cancelled", {1}, [0], "任务已停止"),
        ]
        for mode, failures, expected_chunks, error in cases:
            with self.subTest(mode=mode):
                p = self.create()
                raw = self.store.read(p["id"])
                raw["media"]["duration"] = 46.25
                raw["has_background"] = True
                self.store.save(raw)
                job = dict(id="recovery-" + mode, project_id=p["id"], project_revision=p["revision"], cancel=threading.Event())
                chunks = []
                self.b._ui_log = Mock()

                def separate(model, chunk, *_args):
                    chunks.append(int(Path(chunk).stem.rsplit("-", 1)[-1]))
                    failed = len(chunks) in failures
                    self.b._loaded_id = "another-model" if mode == "different_model" else model
                    self.b._server_proc = None if mode == "external_server" else Mock()
                    if self.b._server_proc is not None:
                        code = 0 if mode == "clean_exit" else -1073741819
                        self.b._server_proc.poll.return_value = code if failed and mode not in {"still_alive", "delayed_exit"} else None
                        if mode == "delayed_exit":
                            self.b._server_proc.wait.return_value = code
                        else:
                            self.b._server_proc.wait.side_effect = subprocess.TimeoutExpired("server", .5)
                    if failed and mode == "cancelled":
                        job["cancel"].set()
                    return ({}, None, "连接中断") if failed else ({}, [vocal, other], "✅")

                self.b.do_sep = Mock(side_effect=separate)
                with patch.object(scenarios.media, "extract_audio", side_effect=lambda _src, dest, **_kw: audio(dest)), \
                     patch.object(scenarios.media, "mix_background", side_effect=lambda _src, dest, _duration, **_kw: audio(dest)), \
                     patch.object(scenarios.media, "concatenate_audio", side_effect=lambda _src, dest, **_kw: audio(dest)) as concatenate:
                    if error:
                        with self.assertRaisesRegex((ValueError, RuntimeError), error):
                            self.store.ensure_audio(job, raw)
                        self.assertFalse(raw.get("separated"))
                        concatenate.assert_not_called()
                    else:
                        result = self.store.ensure_audio(job, raw)
                        self.assertTrue(raw["separated"])
                        self.assertTrue(Path(result).is_file())
                        self.assertEqual([c.kwargs["durations"] for c in concatenate.call_args_list], [[20, 20, 6.25]] * 2)
                self.assertEqual(chunks, expected_chunks)
                self.assertEqual(self.b._ui_log.call_count, 1 if mode in {"recover", "delayed_exit", "repeat_crash", "later_crash"} else 0)

    def test_bilingual_export_contains_new_translation(self):
        p = self.update(self.create(), confirmed_source=True)
        for cue in p["segments"]:
            cue["translation"] = "New English translation"
        p = self.update(p, segments=p["segments"])
        result = self.wait(self.submit(p, "export_subtitles", format="vtt", layer="bilingual"))
        self.assertEqual(result["status"], "done", result)
        exported = self.get(p)["exports"][0]
        text = self.client.get(exported["url"]).text
        self.assertIn("你好\nNew English translation", text)

    def ready_dubbing(self, durations=(4., 5.), video=False):
        p = self.create()
        raw = self.store.read(p["id"])
        raw.update(scenario="dubbing", confirmed_source=True, confirmed_translation=True)
        raw["media"]["has_video"] = video
        root = self.store.directory(p["id"])
        for cue, duration in zip(raw["segments"], durations):
            path = Path(audio(root / f"speech-{cue['id']}.wav", duration))
            cue.update(translation="English " + str(cue["id"]), speed=1.5,
                       audio={"path": path.name, "duration": duration})
        self.store.refresh_audio_checks(raw)
        self.store.save(raw)
        return self.get(p)

    def test_follow_default_and_legacy_missing_flag(self):
        p = self.create()
        self.assertTrue(p["video_follows_audio"])
        raw = self.store.read(p["id"])
        raw.pop("video_follows_audio")
        self.store.save(raw)
        self.assertFalse(self.get(p)["video_follows_audio"])
        for invalid in (1, 0, "false", None, []):
            response = self.client.patch(scenarios.PREFIX + "/projects/" + p["id"],
                json={"revision": p["revision"], "video_follows_audio": invalid})
            self.assertEqual(response.status_code, 400, response.text)

    def test_switch_reuses_raw_audio_and_invalidates_only_outputs(self):
        p = self.ready_dubbing()
        raw = self.store.read(p["id"])
        raw.update(confirmed_audio=True, preview={"path": "preview.wav", "name": "试听"},
                   output_timeline={"duration": 10}, exports=[{"path": "result.mp4", "name": "视频"}])
        self.store.save(raw)
        paths = [c["audio"]["url"] for c in p["segments"]]
        switched = self.update(p, video_follows_audio=False)
        self.assertEqual(paths, [c["audio"]["url"] for c in switched["segments"]])
        self.assertTrue(switched["confirmed_source"])
        self.assertTrue(switched["confirmed_translation"])
        self.assertFalse(switched["confirmed_audio"])
        self.assertIsNone(switched["preview"])
        self.assertEqual(switched["exports"], [])
        self.assertNotIn("output_timeline", switched)
        self.assertEqual(switched["segments"][0]["audio"]["speed"], 1.5)
        restored = self.update(switched, video_follows_audio=True)
        self.assertEqual(restored["segments"][0]["audio"]["speed"], 1)
        self.assertFalse(self.store.audio_issues(restored))

    def test_legacy_default_save_preserves_existing_confirmed_preview(self):
        p = self.ready_dubbing(durations=(1., 1.))
        raw = self.store.read(p["id"])
        raw.pop("video_follows_audio")
        raw.update(confirmed_audio=True, preview={"path": "preview.wav", "name": "试听"})
        self.store.save(raw)
        p = self.get(p)
        p = self.update(p, video_follows_audio=False, segments=p["segments"], confirmed_audio=True)
        self.assertTrue(p["confirmed_audio"])
        self.assertIsNotNone(p["preview"])

    def test_legacy_one_speed_sentinel_preserves_auto_fit_and_preview(self):
        p = self.ready_dubbing(durations=(2.2, 2.2))
        raw = self.store.read(p["id"])
        raw.pop("video_follows_audio")
        for cue in raw["segments"]:
            cue["speed"] = 1
            cue["audio"]["speed"] = 1.1
        raw.update(confirmed_audio=True, preview={"path": "preview.wav", "name": "试听"})
        self.store.save(raw)
        p = self.get(p)
        self.assertNotIn("speed", p["segments"][0])
        self.assertEqual(p["segments"][0]["audio"]["speed"], 1.1)
        p = self.update(p, segments=p["segments"], video_follows_audio=False, confirmed_audio=True)
        self.assertTrue(p["confirmed_audio"])
        self.assertIsNotNone(p["preview"])

    def test_follow_output_subtitles_require_rendered_timeline(self):
        p = self.ready_dubbing()
        for layer in ("translation", "bilingual"):
            result = self.wait(self.submit(p, "export_subtitles", layer=layer))
            self.assertEqual(result["status"], "error", result)
            self.assertIn("先生成混音", result["message"])
            p = self.get(p)
        result = self.wait(self.submit(p, "export_subtitles", layer="source"))
        self.assertEqual(result["status"], "done", result)

    def test_explicit_one_is_original_speed_and_missing_speed_keeps_legacy_auto(self):
        p = self.update(self.create(), video_follows_audio=False)
        raw = self.store.read(p["id"])
        raw["segments"][0]["audio"] = {"path": "speech.wav", "duration": 2.4}
        self.store.refresh_audio_checks(raw)
        self.assertEqual(raw["segments"][0]["audio"]["speed"], 1.2)
        self.store.save(raw)
        p = self.get(p)
        p = self.update(p, segments=p["segments"])
        self.assertNotIn("speed", p["segments"][0])
        p["segments"][0]["speed"] = 1
        p = self.update(p, segments=p["segments"])
        self.assertEqual(p["segments"][0]["audio"]["speed"], 1)
        self.assertAlmostEqual(p["segments"][0]["audio"]["overflow"], .4)

    def test_follow_mix_and_exports_use_output_timing_without_editing_source(self):
        p = self.ready_dubbing()
        original_times = [(c["start"], c["end"]) for c in p["segments"]]
        with patch.object(self.store, "ensure_audio", return_value=self.source):
            result = self.wait(self.submit(p, "mix"))
        self.assertEqual(result["status"], "done", result)
        p = self.get(p)
        self.assertEqual(p["preview"]["duration"], 10)
        self.assertFalse(p["preview"]["has_video"])
        self.assertEqual([(c["start"], c["end"]) for c in p["segments"]], original_times)
        self.assertEqual([(c["start"], c["end"], c["speed"]) for c in p["output_timeline"]["segments"]], [(1, 5, 1), (5, 10, 1)])
        self.assertAlmostEqual(scenarios.media.audio_duration(self.store.directory(p["id"]) / self.store.read(p["id"])["preview"]["path"]), 10)
        for layer in ("translation", "bilingual", "source"):
            result = self.wait(self.submit(p, "export_subtitles", layer=layer))
            self.assertEqual(result["status"], "done", result)
            p = self.get(p)
            cues = scenarios.media.parse_subtitles(self.client.get(p["exports"][-1]["url"]).text)
            self.assertEqual([(c["start"], c["end"]) for c in cues], [(1, 5), (5, 10)])
        p = self.update(p, confirmed_audio=True)
        result = self.wait(self.submit(p, "export", options={"subtitle_mode": "bilingual"}))
        self.assertEqual(result["status"], "done", result)
        p = self.get(p)
        cues = scenarios.media.parse_subtitles(self.client.get(p["exports"][-1]["url"]).text)
        self.assertEqual(cues[1]["start"], 5)
        self.assertIn("世界\nEnglish 2", cues[1]["text"])

    def test_follow_video_preview_and_export_share_plan_and_keep_mix_audio_private(self):
        p = self.ready_dubbing(video=True)
        def render(_source, _audio, destination, **_kwargs):
            Path(destination).write_bytes(b"video")
            return str(destination)
        with patch.object(self.store, "ensure_audio", return_value=self.source), \
                patch.object(scenarios.media, "export_video", side_effect=render) as exporter:
            result = self.wait(self.submit(p, "mix"))
            self.assertEqual(result["status"], "done", result)
            p = self.get(p)
            self.assertTrue(p["preview"]["has_video"])
            self.assertTrue(p["preview"]["url"].endswith(".mp4"))
            self.assertNotIn("audio_path", p["preview"])
            plan = exporter.call_args.kwargs["timeline"]
            p = self.update(p, confirmed_audio=True)
            result = self.wait(self.submit(p, "export"))
            self.assertEqual(result["status"], "done", result)
            self.assertEqual(exporter.call_args.kwargs["timeline"], plan)
            self.assertTrue(str(exporter.call_args.args[1]).endswith(".wav"))

    def test_fixed_video_timing_still_blocks_long_original_speed_audio(self):
        p = self.ready_dubbing()
        p = self.update(p, video_follows_audio=False)
        for cue in p["segments"]:
            cue["speed"] = 1
        p = self.update(p, segments=p["segments"])
        with patch.object(self.store, "ensure_audio", return_value=self.source):
            result = self.wait(self.submit(p, "mix"))
        self.assertEqual(result["status"], "error", result)
        self.assertIn("超时", result["message"])
        self.assertIsNone(self.get(p)["preview"])

    def test_download_header_uses_project_export_name(self):
        p = self.create()
        result = self.wait(self.submit(p, "export_subtitles", format="srt", layer="source"))
        self.assertEqual(result["status"], "done", result)
        exported = self.get(p)["exports"][0]
        response = self.client.get(exported["url"] + "?download=true")
        from urllib.parse import unquote
        self.assertIn(exported["name"], unquote(response.headers["content-disposition"]))

    def test_subtitle_export_options_keep_confirmed_mix_preview(self):
        p = self.create()
        raw = self.store.read(p["id"])
        raw.update(confirmed_source=True, confirmed_translation=True, confirmed_audio=True,
                   preview={"path": "preview.wav", "name": "试听.wav"})
        for cue in raw["segments"]:
            cue["translation"] = "Hello"
            cue["audio"] = {"path": "speech.wav", "duration": 1, "overflow": 0}
        self.store.save(raw)
        p = self.update(p, options={"subtitle_mode": "bilingual", "translation_instructions": "自然"})
        self.assertTrue(p["confirmed_audio"])
        self.assertIsNotNone(p["preview"])

    def test_model_loading_keeps_the_actual_scenario_stage(self):
        ident = "scenario-stage-test"
        self.work.active_job = ident
        self.work.local.operation = ident
        self.work.jobs[ident] = dict(id=ident, task="asr", stage="separate", project_id="project", cancel=threading.Event())
        self.work.before_load("htdemucs-6stems")
        self.assertIn("分离", self.work.jobs[ident]["message"])
        self.work.after_load("htdemucs-6stems")
        self.assertIn("分离", self.work.jobs[ident]["message"])
        self.work.jobs[ident]["stage"] = "align"
        self.work.after_load("crisperwhisper-align")
        self.assertIn("对齐", self.work.jobs[ident]["message"])

    def test_saved_translation_instructions_are_used_by_new_llm_request(self):
        p = self.update(self.create(), confirmed_source=True,
                        options={"subtitle_mode": "bilingual", "translation_instructions": "保持产品名字 DLC-Pro 不变"})
        response = Mock(status_code=200)
        response.json.return_value = {"choices": [{"message": {"content": '{"translations":[{"id":"1","text":"Hello"},{"id":"2","text":"World"}]}'}}]}
        llm = Mock()
        llm.__enter__ = Mock(return_value=llm)
        llm.__exit__ = Mock(return_value=False)
        llm.post.return_value = response
        with patch.object(scenarios.httpx, "Client", return_value=llm):
            result = self.wait(self.submit(p, "translate", llm={"url": "https://provider.test/v1", "model": "model"}))
        self.assertEqual(result["status"], "done", result)
        self.assertIn("保持产品名字 DLC-Pro 不变", llm.post.call_args.kwargs["json"]["messages"][0]["content"])


class TimestampTests(unittest.TestCase):
    def test_chinese_phrase_boundary_uses_transcript_punctuation_without_splitting_word(self):
        text = "今天介绍高清视频，然后演示。"
        chars = "今天介绍高清视频然后演示"
        words = [{"word": char, "start": index, "end": index + .9} for index, char in enumerate(chars)]
        cues = scenarios.asr_segments({"text": text, "words": words})
        self.assertEqual([c["text"] for c in cues], ["今天介绍高清视频，", "然后演示。"])
        self.assertEqual(cues[0]["end"], 7.9)

    def test_internal_character_gap_does_not_split_chinese_words(self):
        cues = scenarios.asr_segments({"text": "今天用的是，我们从照片开始，输出先保持默认。", "words": [
            {"word": "今", "start": 0, "end": .02}, {"word": "天用的是，", "start": 1, "end": 2.5},
            {"word": "我", "start": 2.5, "end": 2.52}, {"word": "们从照片开始，", "start": 3.3, "end": 5},
            {"word": "输", "start": 5.2, "end": 5.34}, {"word": "出先保持默认。", "start": 6.2, "end": 8}]})
        self.assertEqual([c["text"] for c in cues], ["今天用的是，", "我们从照片开始，", "输出先保持默认。"])

    def test_chinese_aligner_input_matches_character_hypothesis(self):
        self.assertEqual(scenarios.alignment_text("实时 AI 换脸，1080p 高清。"), "实 时 AI 换 脸， 1080p 高 清。")
        self.assertEqual(scenarios.alignment_text("实时AI换脸。"), "实 时 AI 换 脸。")

    def test_word_spans_take_precedence_over_large_segment(self):
        cues = scenarios.asr_segments({"text": "第一句。第二句。", "segments": [{"text": "第一句。第二句。", "start": 0, "end": 8}],
            "words": [{"word": "第一句。", "start": 0, "end": 2}, {"word": "第二句。", "start": 3, "end": 5}]})
        self.assertEqual(len(cues), 2)
        self.assertEqual(cues[1]["start"], 3)

    def test_zero_word_point_keeps_text_with_neighbor_measured_span(self):
        cues = scenarios.asr_segments({"text": "切换画面。", "words": [
            {"word": "切", "start": 0, "end": .3}, {"word": "换", "start": .3, "end": .3},
            {"word": "画", "start": .3, "end": .6}, {"word": "面。", "start": .6, "end": 1}]})
        self.assertEqual(cues[0]["text"], "切换画面。")
        self.assertEqual(cues[0]["start"], 0)
        self.assertEqual(cues[0]["end"], 1)
        leading = scenarios.asr_segments({"text": "对方", "words": [
            {"word": "对", "start": .2, "end": .2}, {"word": "方", "start": .2, "end": .8}]})
        self.assertEqual(leading[0]["text"], "对方")
        self.assertEqual((leading[0]["start"], leading[0]["end"]), (.2, .8))

    def test_word_without_any_time_still_fails_instead_of_getting_invented_time(self):
        with self.assertRaises(ValueError):
            scenarios.asr_segments({"text": "你好世界", "words": [{"word": "你好", "start": 0, "end": 1}, {"word": "世界"}]})

    def test_new_backend_modules_affect_launcher_runtime_identity(self):
        try:
            from . import workbench_launcher
        except ImportError:
            import workbench_launcher
        with tempfile.TemporaryDirectory() as directory, patch.object(workbench_launcher, "WEBUI_DIR", Path(directory)):
            original = workbench_launcher.runtime_revision()
            (Path(directory) / "workbench_scenarios.py").write_text("first", encoding="utf-8")
            updated = workbench_launcher.runtime_revision()
            (Path(directory) / "scenario_media.py").write_text("second", encoding="utf-8")
            self.assertNotEqual(original, updated)
            self.assertNotEqual(updated, workbench_launcher.runtime_revision())

    def test_project_iso_language_reaches_supertonic_friendly_dropdown_contract(self):
        backend = SimpleNamespace(profile_for=lambda entry: {"lang_map": {"english": "en", "french": "fr", "portuguese": "pt"}})
        self.assertEqual(scenarios.backend_language(backend, {"family": "supertonic"}, "en"), "english")
        self.assertEqual(scenarios.backend_language(backend, {"family": "supertonic"}, "fr"), "french")
        self.assertEqual(scenarios.backend_language(backend, {"family": "supertonic"}, "auto"), "")

    def test_qwen_tts_iso_languages_use_codec_language_names(self):
        backend = SimpleNamespace(profile_for=lambda entry: {})
        for code, name in {"en": "english", "zh": "chinese", "ja": "japanese", "ko": "korean",
                           "fr": "french", "de": "german", "es": "spanish", "it": "italian",
                           "pt": "portuguese", "ru": "russian"}.items():
            with self.subTest(code=code):
                self.assertEqual(scenarios.backend_language(backend, {"family": "qwen3_tts"}, code), name)
        self.assertEqual(scenarios.backend_language(backend, {"family": "qwen3_tts"}, "auto"), "")
        self.assertEqual(scenarios.backend_language(backend, {"family": "pocket_tts"}, "en"), "en")

    def test_real_sample_spans_have_input_rate_and_chunk_offset(self):
        cues = scenarios.asr_segments([{"offset_seconds": 12.5, "result": {"sample_rate": 48000,
            "words": [{"word": "你", "start_sample": 48000, "end_sample": 72000},
                      {"word": "好。", "start_sample": 72000, "end_sample": 96000}]}}])
        self.assertEqual(cues[0]["start"], 13.5)
        self.assertEqual(cues[0]["end"], 14.5)
        self.assertEqual(cues[0]["text"], "你好。")

    def test_timestamp_free_transcript_never_gets_invented_time(self):
        with self.assertRaises(ValueError):
            scenarios.asr_segments([{"offset_seconds": 5, "result": {"text": "hello world"}}])
        with self.assertRaises(ValueError):
            scenarios.asr_segments({"words": [{"word": "hi", "start_sample": 10, "end_sample": 20}]})


if __name__ == "__main__":
    unittest.main()
