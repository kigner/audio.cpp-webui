import json
import io
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
import wave
from unittest.mock import Mock

from fastapi.testclient import TestClient

try:
    from .workbench_server import create_workbench_app, JobRequest, Workbench, clean_message
    from .workbench_metadata import model_detail
except ImportError:
    from workbench_server import create_workbench_app, JobRequest, Workbench, clean_message
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
        stream = io.BytesIO()
        with wave.open(stream, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(b"\0\0" * 160)
        response = self.client.post("/api/workbench/uploads", files={"file": (name, stream.getvalue(), "audio/wav")})
        self.assertEqual(response.status_code, 200)
        return response.json()["id"]

    def test_blank_speech_limit_reaches_shared_handler_as_none(self):
        self.b.do_tts = Mock(return_value=(None, "✅"))
        response = self.client.post("/api/workbench/jobs", json={
            "task": "tts", "model": "tts", "inputs": {"text": "Hello"}})
        self.assertEqual(response.status_code, 200)
        self.wait_job(response.json()["id"])
        self.assertIsNone(self.b.do_tts.call_args.args[7])
        self.assertIsNone(self.b.do_tts.call_args.args[6])

    def test_speech_seed_keeps_default_zero_fixed_and_random_distinct(self):
        output = Path(self.temp.name) / 'speech.wav'
        output.write_bytes(b'RIFF-test')
        self.b.do_tts = Mock(return_value=(str(output), '✅'))
        for seed, expected in [(None, None), ('', None), (0, 0), (-1, -1), (42, 42)]:
            response = self.client.post('/api/workbench/jobs', json={
                'task': 'tts', 'model': 'tts', 'inputs': {'text': 'Hello', 'seed': seed}})
            self.assertEqual(self.wait_job(response.json()['id'])['status'], 'done')
            self.assertEqual(self.b.do_tts.call_args.args[6], expected)

    def test_dialogue_references_preserve_slots_and_replace_single_audio(self):
        self.entry.update(family='moss_ttsd')
        output = Path(self.temp.name) / 'dialogue.wav'
        output.write_bytes(b'RIFF-test')
        self.b.do_tts = Mock(return_value=(str(output), '✅'))
        self.b._ensure_wav = lambda path: path
        voice = self.upload('second.wav')
        response = self.client.post('/api/workbench/jobs', json={
            'task': 'tts', 'model': 'tts', 'inputs': {'text': '[S1] Hello [S2] There',
                'voice': 'ignored-stale-upload', 'builtin_voice': 'ignored-stale.wav', 'reference_text': 'stale', 'speaker_references': [
                    {}, {'voice': voice, 'reference_text': '第二个人的参考'}]},
            'options': {'moss_ttsd.voice_samples': 'stale.wav', 'reference_text': 'stale'}})
        job = self.wait_job(response.json()['id'])
        self.assertEqual(job['status'], 'done', job)
        args = self.b.do_tts.call_args.args
        self.assertIsNone(args[3])
        self.assertEqual(args[4], '(none)')
        self.assertEqual(args[5], '[S2] 第二个人的参考')
        self.assertTrue(args[8]['voice_samples'].startswith(','))
        self.assertNotIn('moss_ttsd.voice_samples', args[8])
        self.assertNotIn('reference_text', args[8])

    def test_vibevoice_rejects_gaps_and_trims_only_trailing_empty_slots(self):
        self.entry.update(family='vibevoice')
        output = Path(self.temp.name) / 'dialogue.wav'
        output.write_bytes(b'RIFF-test')
        self.b.do_tts = Mock(return_value=(str(output), '✅'))
        self.b._ensure_wav = lambda path: path
        voice = self.upload()
        for slots, status in [([{}, {'voice': voice}], 'error'), ([{'voice': voice}, {}], 'done')]:
            response = self.client.post('/api/workbench/jobs', json={
                'task': 'tts', 'model': 'tts', 'inputs': {'text': 'Speaker 0: Hi', 'speaker_references': slots}})
            job = self.wait_job(response.json()['id'])
            self.assertEqual(job['status'], status, job)
        self.assertNotIn(',', self.b.do_tts.call_args.args[8]['voice_samples'])

    def test_speaker_references_validate_library_names_and_upload_identifiers(self):
        self.entry.update(family='moss_ttsd')
        self.b.do_tts = Mock()
        for slot in [{'builtin_voice': '../missing.wav'}, {'voice': 'missing'},
                     {'voice': 'anything', 'builtin_voice': 'other.wav'}]:
            response = self.client.post('/api/workbench/jobs', json={
                'task': 'tts', 'model': 'tts', 'inputs': {'text': '[S1] Hello', 'speaker_references': [slot]}})
            self.assertEqual(self.wait_job(response.json()['id'])['status'], 'error')
        self.b.do_tts.assert_not_called()

    def test_conversion_seed_keeps_blank_distinct_from_zero_and_random(self):
        self.entry.update(task='vc', family='meanvc2')
        output = Path(self.temp.name) / 'converted.wav'
        output.write_bytes(b'RIFF-test')
        self.b.do_vc = Mock(return_value=(str(output), '✅'))
        for seed, expected in [(None, None), ('', None), (0, 0), (-1, -1), (42, 42)]:
            inputs = {'audio': self.upload()}
            if seed is not None:
                inputs['seed'] = seed
            response = self.client.post('/api/workbench/jobs', json={
                'task': 'vc', 'model': 'tts', 'inputs': inputs})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(self.wait_job(response.json()['id'])['status'], 'done')
            self.assertEqual(self.b.do_vc.call_args.args[6], expected)

    def test_rvc_checkboxes_control_files_and_json_options_before_conversion(self):
        self.entry.update(task='vc', family='rvc')
        output = Path(self.temp.name) / 'rvc.wav'
        output.write_bytes(b'RIFF-test')
        self.b.do_vc = Mock(return_value=(str(output), '✅'))
        audio = self.upload()
        voice, index = self.upload('custom.pth'), self.upload('custom.index')
        for use_builtin, no_index in [(True, True), (False, False), (False, True), (True, False)]:
            with self.subTest(builtin=use_builtin, no_index=no_index):
                response = self.client.post('/api/workbench/jobs', json={
                    'task': 'vc', 'model': 'tts',
                    'inputs': {'audio': audio, 'rvc_use_builtin': use_builtin, 'rvc_no_index': no_index,
                               'rvc_voice_model': 'ignored-invalid-id' if use_builtin else voice,
                               'rvc_retrieval_index': 'ignored-invalid-id' if no_index else index},
                    'options': {'voice_id': 'manthos', 'voice_model_path': 'advanced.pth',
                                'retrieval_index_path': 'advanced.index', 'retrieval_blend': 0.7}})
                job = self.wait_job(response.json()['id'])
                self.assertEqual(job['status'], 'done', job)
                args = self.b.do_vc.call_args.args
                self.assertEqual(args[4] is None, use_builtin)
                self.assertEqual(args[5] is None, no_index)
                self.assertEqual('voice_model_path' not in args[7], use_builtin)
                self.assertEqual('retrieval_index_path' not in args[7], no_index)
                self.assertEqual(args[7]['retrieval_blend'], 0 if no_index else 0.7)
                self.assertEqual(args[7]['voice_id'], 'manthos')

    def test_rvc_requires_custom_files_only_when_the_selection_uses_them(self):
        self.entry.update(task='vc', family='rvc')
        output = Path(self.temp.name) / 'rvc.wav'
        output.write_bytes(b'RIFF-test')
        self.b.do_vc = Mock(return_value=(str(output), '✅'))
        audio = self.upload()
        for inputs, options, message in [
            ({'rvc_use_builtin': False, 'rvc_no_index': True}, {}, '请选择 RVC 文件'),
            ({'rvc_use_builtin': False, 'rvc_no_index': False},
             {'voice_model_path': 'custom.pth', 'retrieval_blend': 0.7}, '选择索引文件'),
        ]:
            response = self.client.post('/api/workbench/jobs', json={
                'task': 'vc', 'model': 'tts', 'inputs': {'audio': audio, **inputs}, 'options': options})
            job = self.wait_job(response.json()['id'])
            self.assertEqual(job['status'], 'error')
            self.assertIn(message, job['message'])
            self.b.do_vc.assert_not_called()
        for inputs, options in [
            ({'rvc_use_builtin': True, 'rvc_no_index': True}, {}),
            ({'rvc_use_builtin': True, 'rvc_no_index': False}, {'retrieval_blend': 0.7}),
            ({}, {'voice_model_path': 'legacy.pth', 'retrieval_index_path': 'legacy.index', 'retrieval_blend': 0.5}),
        ]:
            self.b.do_vc.reset_mock()
            response = self.client.post('/api/workbench/jobs', json={
                'task': 'vc', 'model': 'tts', 'inputs': {'audio': audio, **inputs}, 'options': options})
            self.assertEqual(self.wait_job(response.json()['id'])['status'], 'done')
            self.b.do_vc.assert_called_once()

    def test_system_messages_are_plain_text_without_filtering_names(self):
        message = "❌ 转写失败：音频✅.wav\n💡 请重试。\nℹ️ 点击『📥 加载模型』。\n⚠️ 显存不足。"
        self.assertEqual(clean_message(message),
                         "转写失败：音频✅.wav\n请重试。\n点击『加载模型』。\n显存不足。")
        for icon in "🧠🎵🌐⏱📏🔀🎤🗒🧹📦🎛🧊":
            with self.subTest(icon=icon):
                self.assertEqual(clean_message(f"💡 {icon} 请重试。"), "请重试。")
        self.assertEqual(clean_message("已生成：语音🧠.wav"), "已生成：语音🧠.wav")
        self.b.do_tts = Mock(return_value=(None, message))
        ident = self.client.post("/api/workbench/jobs", json={"task": "tts", "model": "tts"}).json()["id"]
        result = self.wait_job(ident)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["message"], clean_message(message))

    def test_api_exception_messages_are_plain_text(self):
        from fastapi import HTTPException
        for exception, code in ((ValueError("⚠️ 请检查设置。"), 400),
                                (RuntimeError("ℹ️ 资源被占用。"), 409),
                                (HTTPException(400, "❌ 模型未就绪。", headers={"X-Reason": "model"}), 400)):
            with self.subTest(exception=type(exception).__name__):
                self.b._ensure_with_options.side_effect = exception
                response = self.client.post("/api/workbench/models/tts/load", json={})
                self.assertEqual(response.status_code, code)
                self.assertEqual(response.json()["detail"], clean_message(getattr(exception, "detail", None) or exception))
                if isinstance(exception, HTTPException):
                    self.assertEqual(response.headers["X-Reason"], "model")

    def test_music_analysis_validates_family_and_returns_only_analysis_parameters(self):
        request = {"task": "tts", "model": "tts", "action": "analyze_source"}
        self.assertEqual(self.client.post("/api/workbench/jobs", json=request).status_code, 400)
        self.entry.update(family="ace_step", task="gen")
        request["task"] = "music"
        self.assertEqual(self.client.post("/api/workbench/jobs", json=request).status_code, 400)
        self.b.do_music_analyze = Mock(return_value=({}, {
            "source_caption": "Warm piano", "bpm": 90, "num_inference_steps": 8}, "✅ 分析完成"))
        self.b.do_music_gen_with_files = Mock()
        request["inputs"] = {"audio": self.upload()}
        request["options"] = {"session_options.ace_step.weight_type": "f16"}
        response = self.client.post("/api/workbench/jobs", json=request)
        self.assertEqual(response.status_code, 200)
        result = self.wait_job(response.json()["id"])
        self.assertEqual(result["status"], "done")
        self.assertEqual(result["parameter_updates"], {"source_caption": "Warm piano", "bpm": 90})
        self.assertEqual(result["artifacts"], [])
        self.assertEqual(self.b.do_music_analyze.call_args.args[3], request["options"])
        self.b.do_music_gen_with_files.assert_not_called()

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
        self.assertEqual(len(response.json()["tasks"]), 8)
        self.assertEqual(next(t["types"] for t in response.json()["tasks"] if t["id"] == "asr"), ["asr"])
        self.assertEqual(self.client.get("/").status_code, 200)

    def test_runtime_configuration_only_reports_a_live_managed_process(self):
        self.b._loaded_id = "tts"
        self.b._server_proc = Mock()
        self.b._server_proc.poll.return_value = None
        self.b._loaded_load_options = {"threads": "8"}
        self.b._loaded_session_options = {"voice": "warm"}
        self.b._loaded_mode = "streaming"
        server = self.client.get("/api/workbench/status").json()["server"]
        self.assertEqual(server["model"], "tts")
        self.assertEqual(server["configuration"], {
            "managed": True, "load_options": {"threads": "8"},
            "session_options": {"voice": "warm"}, "mode": "streaming"})
        self.b._server_proc.poll.return_value = 1
        server = self.client.get("/api/workbench/status").json()["server"]
        self.assertIsNone(server["model"])
        self.assertFalse(server["configuration"]["managed"])
        self.assertEqual(server["configuration"]["load_options"], {})

    def test_external_api_model_is_reported_after_reuse_and_disappears_when_stopped(self):
        self.b.loaded_ids = Mock(return_value=["other-api-model", "tts"])
        response = self.client.post("/api/workbench/models/tts/load", json={})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["server"]["model"], "tts")
        self.assertFalse(response.json()["busy"])
        self.assertFalse(response.json()["server"]["configuration"]["managed"])
        self.assertEqual(self.client.get("/api/workbench/status").json()["server"]["model"], "tts")
        self.b.loaded_ids.return_value = []
        self.assertIsNone(self.client.get("/api/workbench/status").json()["server"]["model"])

    def test_managed_status_and_catalog_do_not_probe_inference_servers(self):
        self.b._loaded_id = "tts"
        self.b._server_proc = Mock()
        self.b._server_proc.poll.return_value = None
        self.b.loaded_ids = Mock(side_effect=AssertionError("unexpected model probe"))
        self.b.server_status = Mock(side_effect=AssertionError("unexpected health probe"))
        self.app.state.workbench.asr = SimpleNamespace(
            status=lambda: {"model": "qwen3-asr", "managed": True})
        for path in ("status", "catalog"):
            with self.subTest(path=path):
                data = self.client.get("/api/workbench/" + path).json()
                self.assertEqual(data["server"]["model"], "tts")
                self.assertEqual(data["asr"]["model"], "qwen3-asr")
        self.b.loaded_ids.assert_not_called()
        self.b.server_status.assert_not_called()

    def test_idle_status_checks_external_models_once_with_bounded_timeout(self):
        self.b.loaded_ids = Mock(return_value=[])
        self.b.server_status = Mock(side_effect=AssertionError("duplicate probe"))
        self.app.state.workbench.asr = SimpleNamespace(
            status=lambda: {"model": "qwen3-asr", "managed": True})
        data = self.client.get("/api/workbench/status").json()
        self.assertIsNone(data["server"]["model"])
        self.assertEqual(data["asr"]["model"], "qwen3-asr")
        self.b.loaded_ids.assert_called_once_with(timeout=(0.3, 1))
        self.b.server_status.assert_not_called()

    def test_unload_responses_release_the_operation_before_reporting_status(self):
        for path in ("unload", "unload-all"):
            with self.subTest(path=path):
                data = self.client.post("/api/workbench/" + path, json={}).json()
                self.assertFalse(data["busy"])
                self.assertIsNone(data["job"])

    def test_loader_error_has_readable_json_and_releases_the_operation(self):
        class LoaderError(Exception):
            pass
        self.b.gr = SimpleNamespace(Error=LoaderError)
        self.b._ensure_with_options.side_effect = LoaderError("8088 被外部模型服务占用，请先关闭。")
        response = self.client.post("/api/workbench/models/tts/load", json={})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "8088 被外部模型服务占用，请先关闭。")
        self.assertFalse(self.client.get("/api/workbench/status").json()["busy"])

    def test_uploaded_id_and_generated_file_are_scoped(self):
        ident = self.upload()
        seen = {}
        def generate(*args, progress=None):
            seen["args"] = args
            out = Path(self.temp.name) / "result.wav"
            out.write_bytes(b"RIFF")
            return str(out), "✅ 完成"
        self.b.do_tts = generate
        response = self.client.post("/api/workbench/jobs", json={"task":"tts", "model":"tts",
                                    "inputs":{"text":"hello", "voice":ident}, "options":{"speed":1.2}})
        job = self.wait_job(response.json()["id"])
        self.assertEqual(job["status"], "done")
        self.assertEqual((job["task"], job["model"]), ("tts", "tts"))
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
        def fail(*args, progress=None):
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

    def test_offline_tts_reports_live_chunk_progress_and_cancel_does_not_resume(self):
        entered, finish = threading.Event(), threading.Event()
        def generate(*args, progress):
            self.b._workbench_runtime_guard("tts")
            self.b._workbench_runtime_ready("tts")
            work = self.app.state.workbench
            self.assertEqual(work.job(work.active_job)["message"], "声音合成中…")
            progress((1, 3), desc="声音合成中… 第 2/3 段 · 已完成 1 段")
            entered.set()
            finish.wait(3)
            progress((2, 3), desc="声音合成中… 第 3/3 段")
            self.fail("Cancelled task continued to the next chunk")
        self.b.do_tts = generate
        ident = self.client.post("/api/workbench/jobs", json={"task":"tts", "model":"tts"}).json()["id"]
        try:
            self.assertTrue(entered.wait(2))
            job = self.client.get(f"/api/workbench/jobs/{ident}").json()
            self.assertEqual(job["status"], "running")
            self.assertIn("第 2/3 段", job["message"])
            self.client.post(f"/api/workbench/jobs/{ident}/cancel")
        finally:
            finish.set()
        self.assertEqual(self.wait_job(ident)["status"], "cancelled")

    def test_other_tasks_report_their_working_stage_after_model_is_ready(self):
        for task, message in (("asr", "语音识别中…"), ("music", "音乐与音效生成中…"),
                              ("vc", "声音转换中…"), ("design", "声音设计中…")):
            with self.subTest(task=task):
                work = self.app.state.workbench
                work.reserve("test-stage")
                work.jobs["test-stage"] = {"id":"test-stage", "task":task, "cancel":threading.Event()}
                try:
                    self.b._workbench_runtime_guard("tts")
                    self.assertEqual(work.jobs["test-stage"]["message"], "正在准备模型…")
                    self.b._workbench_runtime_ready("tts")
                    self.assertEqual(work.jobs["test-stage"]["message"], message)
                finally:
                    work.release("test-stage")

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
