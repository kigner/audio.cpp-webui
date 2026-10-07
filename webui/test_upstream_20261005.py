"""Downstream contracts for the 3cf21614 backend merge; no model downloads."""
import base64
from contextlib import ExitStack
from dataclasses import replace
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import wave

try:
    from webui import webui as app
    from webui import model_manager_webui as manager
except ImportError:
    import webui as app
    import model_manager_webui as manager


class UpstreamWebUIContractTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.output = self.stack.enter_context(tempfile.TemporaryDirectory())
        for name, replacement in (
                ("OUTPUT_DIR", self.output), ("_ui_log", mock.Mock()),
                ("_ensure_wav", mock.Mock(side_effect=lambda path, **kwargs: path)),
                ("_to_16k_mono_wav", mock.Mock(side_effect=lambda path: path)),
                ("_audio_duration_seconds", mock.Mock(return_value=1.0))):
            self.stack.enter_context(mock.patch.object(app, name, replacement))
        self.loaded = self.stack.enter_context(mock.patch.object(app, "ensure_model_loaded"))

    def test_new_routes_and_task_specific_streaming(self):
        cases = {"lfm2-audio": app.ASR_TASKS, "lfm2-audio-tts": app.TTS_TASKS,
                 "sam-audio": app.SEP_TASKS, "smart-turn": app.ANALYZE_TASKS,
                 "sheetsage2": app.ANALYZE_TASKS, "htdemucs-6stems": app.SEP_TASKS,
                 "yue2": app.GEN_TASKS, "auk-edit": app.GEN_TASKS,
                 "firered-audio-edit": app.GEN_TASKS}
        for model_id, tasks in cases.items():
            with self.subTest(model=model_id):
                self.assertIn(model_id, {key for _label, key in app.choices_for_tasks(tasks)})
        self.assertFalse(app.supports_streaming("lfm2-audio"))
        self.assertTrue(app.supports_streaming("lfm2-audio-tts"))
        self.assertTrue(app.supports_streaming("qwen3-asr"))
        self.assertTrue(app.supports_streaming("kroko-asr"))
        self.assertEqual(app.catalog_by_id("sam-audio")["task"], "s2s")

    def test_renamed_family_preserves_legacy_ui_id_and_model_path(self):
        entry = app.catalog_by_id("vietneu-tts")
        self.assertEqual(entry["family"], "vieneu_v3_turbo")
        self.assertIn(entry["download_id"], app.SPEC_PACKAGE_BY_ID)
        self.assertTrue(entry["download_path"].startswith("models/"))

    def test_manual_packages_never_start_a_download_process(self):
        with mock.patch.object(app.subprocess, "Popen") as popen:
            for model in ("mira-tts", "sortformer-diar-v2"):
                self.assertTrue(app.catalog_by_id(model)["manual_install"])
                self.assertIn("手动", app.download_model(model))
        popen.assert_not_called()

    def test_new_parameters_keep_scopes_and_qwen_chunk_guard(self):
        controls = {p["name"]: p for p in app.params_for("yue2")}
        self.assertIn("stop_after", controls)
        self.assertIn("session_options.yue2.ar_lora", controls)
        self.assertIn("session_options.yue2.nar_lora", controls)
        qwen_controls = {p["name"] for p in app.params_for("qwen3-tts")}
        self.assertTrue(qwen_controls)
        self.assertNotIn("text_chunk_size", qwen_controls)
        controls = {p["name"] for p in app.params_for("sopro-tts")}
        self.assertIn("load_options.sopro_tts.matmul_weight_type", controls)

    def test_generated_advanced_controls_construct_for_every_catalog_entry(self):
        seen = set()
        with app.gr.Blocks():
            for entry in app.CATALOG["models"]:
                for spec in app.params_for(entry["id"]):
                    signature = json.dumps(spec, sort_keys=True)
                    if signature in seen:
                        continue
                    seen.add(signature)
                    with self.subTest(model=entry["id"], option=spec["name"]):
                        component = app._make_param_component(spec, "zh-Hans")
                        self.assertIsNotNone(component)

    def test_phoneme_array_control_retains_json_types_and_can_be_cleared(self):
        update = app._adv_updater("phonemes", json_list=True)
        state = update({}, '["həloʊ", "wɜːld"]')
        self.assertEqual(state["phonemes"], ["həloʊ", "wɜːld"])
        self.assertEqual(update(state, ""), {})
        with self.assertRaises(app.gr.Error):
            update({}, '{"text": "not an array"}')

    def test_runtime_options_are_removed_from_requests_and_serialized_for_config(self):
        options = {"stop_after": "abc", "semantic_prefix": [1, 2],
                   "session_options.yue2.ar_lora": "D:/adapter.safetensors",
                   "load_options": {"mem_saver": True}}
        app._ensure_with_options("yue2", app.GEN_TASKS, options)
        self.assertEqual(options, {"stop_after": "abc", "semantic_prefix": [1, 2]})
        self.loaded.assert_called_once_with(
            "yue2", app.GEN_TASKS,
            session_options={"yue2.ar_lora": "D:/adapter.safetensors"},
            load_options={"mem_saver": "true"})

    def test_tts_progress_follows_loading_actual_chunks_and_merge(self):
        response = mock.Mock(status_code=200, content=b"RIFF")
        events = []
        def progress(value, desc=None):
            events.append((value, desc))
        def post(*args, **kwargs):
            self.assertIn("声音合成中", events[-1][1])
            self.assertEqual(events[-1][0], (len(requests_seen), 3))
            requests_seen.append(kwargs["json"]["input"])
            return response
        requests_seen = []
        with mock.patch.object(app, "_split_tts_chunks", return_value=["第一段", "第二段", "第三段"]), \
                mock.patch.object(app.requests, "post", side_effect=post), \
                mock.patch.object(app, "_concat_wavs") as merge:
            _, message = app.do_tts("pocket-tts", "测试长文本", "", "reference.wav", "(none)", "参考文本", 1234, 1200, {}, "", progress)
        self.assertIn("✅", message)
        self.assertIn("准备模型", events[0][1])
        self.assertEqual(requests_seen, ["第一段", "第二段", "第三段"])
        self.assertEqual(events[-1][0], (3, 3))
        self.assertIn("合并音频", events[-1][1])
        merge.assert_called_once()

    def test_stream_tts_reports_working_stage_before_waiting_for_first_audio(self):
        with mock.patch.object(app, "_split_tts_chunks", return_value=["第一段", "第二段"]), \
                mock.patch.object(app.requests, "post") as post:
            stream = app.do_tts_stream("pocket-tts", "你好，长文本合成。", "", "reference.wav", "(none)", "参考文本", 1234, 1200, {}, "")
            try:
                self.assertIn("准备模型", next(stream)[2])
                self.loaded.assert_not_called()
                self.assertIn("声音合成中", next(stream)[2])
                self.loaded.assert_called_once()
                self.assertIn("1/2", next(stream)[2])
                post.assert_not_called()
            finally:
                stream.close()

    def test_asr_context_options_and_detail_route(self):
        response = mock.Mock(status_code=200, text="")
        result = {"text": "hello", "words": [{"word": "hello", "start_sample": 0, "end_sample": 16000}],
                  "speaker_turns": [{"speaker_id": "speaker_0", "start_sample": 0, "end_sample": 16000}]}
        response.json.return_value = result
        with mock.patch.object(app.requests, "post", return_value=response) as post:
            outputs = list(app.do_asr_with_details(
                "qwen3-asr", "speech.wav", "English", "a proper name", False, False,
                {"preserve_punctuation": True}, "", True))
        self.assertTrue(post.called, outputs)
        self.assertTrue(post.call_args.args[0].endswith("/v1/audio/transcriptions/details"))
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["text"], "a proper name")
        self.assertNotIn("context", payload)
        self.assertTrue(payload["options"]["preserve_punctuation"])
        self.assertEqual(outputs[-1][2][0]["result"]["words"], result["words"])
        self.assertTrue(Path(outputs[-1][3]).is_file())

    def test_resident_asr_offline_and_details_keep_language_context_and_options(self):
        runtime = mock.Mock(server_url="http://127.0.0.1:8081")
        response = mock.Mock(status_code=200)
        response.json.return_value = {"text": "Aixora", "words": [{"word": "Aixora"}]}
        for detailed in (False, True):
            with self.subTest(detailed=detailed), mock.patch.object(app.requests, "post", return_value=response) as post:
                outputs = list(app.do_asr_with_details("qwen3-asr", "speech.wav", "English", "Aixora",
                    False, False, {"max_tokens": 700, "load_options.use_gpu": True}, "", detailed, asr_runtime=runtime))
                self.assertEqual(outputs[-1][0], "Aixora")
                suffix = "/details" if detailed else ""
                self.assertEqual(post.call_args.args[0], runtime.server_url + "/v1/audio/transcriptions" + suffix)
                payload = post.call_args.kwargs["json"]
                self.assertEqual(payload["language"], "English")
                self.assertEqual(payload["text"], "Aixora")
                self.assertEqual(payload["options"], {"max_tokens": 700})
                runtime.load.assert_called_with("qwen3-asr", cancel=None, load_options={"use_gpu": "true"})
                if detailed:
                    self.assertTrue(Path(outputs[-1][3]).is_file())
        self.loaded.assert_not_called()

    def test_resident_asr_stream_uses_dedicated_server(self):
        runtime = mock.Mock(server_url="http://127.0.0.1:8081")
        response = mock.MagicMock(status_code=200)
        events = [{"type": "transcript.text.delta", "delta": "hello"},
                  {"type": "transcript.text.done", "text": "hello world"}]
        with mock.patch.object(app.requests, "post", return_value=response) as post, \
                mock.patch.object(app, "_iter_sse_events", return_value=iter(events)):
            outputs = list(app.do_asr("qwen3-asr", "speech.wav", stream=True, asr_runtime=runtime))
        self.assertEqual(outputs[-1][0], "hello world")
        runtime.load.assert_called_once_with("qwen3-asr", mode="streaming", cancel=None)
        self.assertEqual(post.call_args.args[0], runtime.server_url + "/v1/audio/transcriptions")
        self.assertTrue(post.call_args.kwargs["stream"])
        self.loaded.assert_not_called()

    def test_resident_asr_dialogue_only_loads_diarization_on_main_server(self):
        runtime = mock.Mock(server_url="http://127.0.0.1:8081")
        source = str(Path(self.output) / "dialogue.wav")
        with wave.open(source, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(b"\0\0" * 16000)
        diar = {"id": "sortformer", "family": "sortformer_diar"}
        turns = {"speaker_turns": [{"speaker_id": "0", "start_sample": 0, "end_sample": 16000}]}
        response = mock.Mock(status_code=200)
        response.json.return_value = {"text": "dialogue text"}
        with mock.patch.object(app, "_first_installed_model", return_value=diar), \
                mock.patch.object(app, "_run_task", return_value=turns), \
                mock.patch.object(app.requests, "post", return_value=response) as post:
            outputs = list(app.do_asr("qwen3-asr", source, dialogue=True, asr_runtime=runtime))
        self.assertIn("dialogue text", outputs[-1][0])
        self.loaded.assert_called_once_with("sortformer", ("diar",), session_options=None)
        runtime.load.assert_called_once_with("qwen3-asr", cancel=None)
        self.assertEqual(post.call_args.args[0], runtime.server_url + "/v1/audio/transcriptions")
        Path(post.call_args.kwargs["json"]["audio"]).unlink()

    def test_lfm2_asr_language_matches_selected_checkpoint(self):
        response = mock.Mock(status_code=200, text="")
        response.json.return_value = {"text": "hello"}
        with mock.patch.object(app.requests, "post", return_value=response) as post:
            list(app.do_asr("lfm2-audio", "speech.wav", "English"))
        self.assertEqual(post.call_args.kwargs["json"]["language"], "en")
        self.loaded.reset_mock()
        outputs = list(app.do_asr("lfm2-audio-jp", "speech.wav", "English"))
        self.assertIn("不支持语言", outputs[-1][1])
        self.loaded.assert_not_called()

    def test_new_streaming_families_use_correct_pcm_rate_and_voice(self):
        response = mock.MagicMock(status_code=200, text="")
        response.__enter__.return_value = response
        events = [
            {"type": "speech.audio.delta", "audio": "AQACAA=="},
            {"type": "speech.audio.done", "timing": {}},
        ]
        rates = {"audio8-tts": 44100, "breeze-tts": 24000, "kugelaudio": 24000,
                 "lfm2-audio-tts": 24000, "lfm2-audio-tts-jp": 24000,
                 "mira-tts": 48000, "pocket-tts": 24000, "soprano-tts": 32000,
                 "sopro-tts": 24000, "voxcpm1": 16000, "zipvoice": 24000}
        for model, rate in rates.items():
            with self.subTest(model=model), \
                    mock.patch.object(app, "_iter_sse_events", return_value=events), \
                    mock.patch.object(app.requests, "post", return_value=response) as post:
                outputs = list(app.do_tts_stream(
                    model, "A streaming test.", "", "reference.wav", "(none)",
                    "Reference transcript.", 1234, 500, {}, ""))
                chunk = next(item[0] for item in outputs if item[0] is not None)
                self.assertEqual(chunk[0], rate)
                with wave.open(outputs[-1][1], "rb") as wav:
                    self.assertEqual(wav.getframerate(), rate)
                    self.assertEqual(wav.getnframes(), 2)
                payload = post.call_args.kwargs["json"]
                self.assertTrue(payload["stream"])
                if model == "lfm2-audio-tts-jp":
                    self.assertNotIn("voice", payload)
                    self.assertNotIn("voice_ref", payload)
                elif model == "lfm2-audio-tts":
                    self.assertEqual(payload["voice"], "us_male")

    def test_cpu_only_model_overrides_gpu_config_without_changing_other_models(self):
        with mock.patch.object(app, "SERVER_BACKEND", "cuda"), \
                mock.patch.object(app, "THREADS", 1), \
                mock.patch.object(app, "_default_cpu_threads", return_value=8), \
                mock.patch.dict(os.environ, {}, clear=True):
            for model, backend, threads in (("vibeasr", "cpu", 8), ("qwen3-asr", "cuda", 1)):
                path = app._write_temp_config(app.catalog_by_id(model))
                try:
                    config = json.loads(Path(path).read_text(encoding="utf-8"))
                finally:
                    Path(path).unlink()
                self.assertEqual(config["backend"], backend)
                self.assertEqual(config["threads"], threads)

    def test_audio_utilities_hide_voice_controls_and_bind_the_correct_weights(self):
        for entry in app.CATALOG["models"]:
            if entry["family"] != "builtin_audio_utils":
                continue
            with self.subTest(model=entry["id"]):
                controls = app.vc_voice_input_updates(entry["id"])
                self.assertFalse(controls[0]["visible"])
                self.assertFalse(controls[3]["visible"])
                self.assertNotIn("load_options.builtin_audio_utils.utility",
                                 {p["name"] for p in app.params_for(entry["id"])})
                utility = entry["load_options"]["utility"]
                self.assertIn(utility.split("_")[0], entry["path"])

    def test_detail_mode_does_not_silently_drop_metadata_in_streaming(self):
        outputs = list(app.do_asr("lfm2-audio", "speech.wav", stream=True, detail_results=[]))
        self.assertIn("离线", outputs[-1][1])
        self.loaded.assert_not_called()

    def test_asr_detail_chunks_keep_their_original_time_offsets(self):
        response = mock.Mock(status_code=200, text="")
        response.json.return_value = {"text": "word", "words": [{"start_sample": 0, "end_sample": 1600}]}
        durations = {"long.wav": 75.0, "part1.wav": 45.0, "part2.wav": 30.0}
        details = []
        with mock.patch.object(app, "_audio_duration_seconds", side_effect=durations.get), \
                mock.patch.object(app, "_split_wav_chunks", return_value=[("part1.wav", 45), ("part2.wav", 30)]), \
                mock.patch.object(app.requests, "post", return_value=response):
            text, duration, count = app._asr_transcribe_wav(
                "qwen3-asr", app.catalog_by_id("qwen3-asr"), {"max_input_seconds": 60},
                "long.wav", {}, details=details)
        self.assertEqual((text, duration, count), ("word\nword", 75, 2))
        self.assertEqual([result["offset_seconds"] for result in details], [0, 45])
        self.assertEqual(details[1]["result"]["words"][0]["start_sample"], 0)

    def test_qwen_asr_stream_prepares_pcm_and_separates_session_settings(self):
        with mock.patch.object(app, "_asr_transcribe_stream", return_value=[("hello", True, 10)]) as stream:
            outputs = list(app.do_asr(
                "qwen3-asr", "speech.wav", "English", "proper noun", stream=True,
                adv_values={"max_tokens": 700, "session_options.qwen3_asr.vad_path": "vad"}))
        self.assertEqual(outputs[-1][0], "hello")
        app._to_16k_mono_wav.assert_called_once_with("speech.wav")
        self.loaded.assert_called_once_with(
            "qwen3-asr", app.ASR_TASKS, mode="streaming", session_options={"qwen3_asr.vad_path": "vad"})
        self.assertEqual(stream.call_args.args[3],
                         {"language": "English", "text": "proper noun", "options": {"max_tokens": 700}})

    def test_sam_audio_prompt_and_two_outputs(self):
        wav = base64.b64encode(b"RIFF-example").decode()
        result = {"named_audio_outputs": [{"id": name, "audio": wav} for name in ("target", "residual")]}
        with mock.patch.object(app, "_run_task", return_value=result) as run:
            outputs = app.do_sep("sam-audio", "mixture.wav", "a dog barking", {"num_inference_steps": 8})
        self.assertEqual(run.call_args.args[2]["text"], "a dog barking")
        self.assertEqual(run.call_args.args[2]["options"]["num_inference_steps"], 8)
        app._ensure_wav.assert_called_with("mixture.wav", target_sr=48000)
        self.assertEqual(len(outputs[-2]), 2)
        self.assertTrue(all(Path(p).is_file() for p in outputs[-2]))

    def test_sam_audio_rejects_missing_prompt_before_loading(self):
        result = app.do_sep("sam-audio", "mixture.wav")
        self.assertIn("描述", result[-1])
        self.loaded.assert_not_called()

    def test_six_stems_have_players_and_downloads(self):
        names = ("vocals", "drums", "bass", "other", "guitar", "piano")
        result = {"named_audio_outputs": [{"id": name, "audio": "UklGRg=="} for name in names]}
        with mock.patch.object(app, "_run_task", return_value=result):
            outputs = app.do_sep("htdemucs-6stems", "song.wav")
        self.assertEqual(len(outputs), 8)
        self.assertEqual(len(outputs[-2]), 6)
        self.assertTrue(all(update["visible"] for update in outputs[:6]))

    def test_smart_turn_structured_result_is_displayed(self):
        result = {"custom_schema_output": {"schema": "smart_turn.v1",
                  "data": {"complete": True, "probability": 0.91}}}
        with mock.patch.object(app, "_run_task", return_value=result):
            text, path, _artifacts, message = app.do_analyze_with_files("smart-turn", "speech.wav", "", "")
        self.assertIn("91.0%", text)
        self.assertIn("发言已结束", text)
        self.assertEqual(json.loads(Path(path).read_text(encoding="utf-8")), result)
        self.assertIn("✅", message)
        self.assertIsNone(self.loaded.call_args.kwargs.get("session_options"))

    @staticmethod
    def artifact(identifier, text, extension):
        return {"id": identifier, "payload": base64.b64encode(text.encode()).decode(),
                "meta": {"extension": extension}}

    def test_sheetsage_keeps_abc_text_and_all_artifacts(self):
        result = {"text": "X:1\nK:C\nCDEF|", "artifacts": [
            self.artifact("score", "X:1\nK:C\nCDEF|", "abc"),
            self.artifact("details", "{}", "json")]}
        with mock.patch.object(app, "_run_task", return_value=result):
            text, _json, artifacts, message = app.do_analyze_with_files("sheetsage2", "song.wav", "", "")
        self.assertIn("K:C", text)
        self.assertEqual({Path(p).suffix for p in artifacts}, {".abc", ".json"})
        self.assertIn("✅", message)
        app._to_16k_mono_wav.assert_not_called()

    def test_yue2_instrumental_and_artifact_only_generation(self):
        result = {"artifacts": [self.artifact("score", "X:1", "abc"),
                                 self.artifact("semantic", "[1,2]", "json")]}
        with mock.patch.object(app, "_run_task", return_value=result) as run:
            audio, files, message = app.do_music_gen_with_files(
                "yue2", "piano solo", "", None, 30, 1234, {"stop_after": "semantic"}, "")
        self.assertIsNone(audio)
        self.assertEqual(len(files), 2)
        req = run.call_args.args[2]
        self.assertEqual(req["text"], "")
        self.assertEqual(req["lyrics"], "")
        self.assertEqual(req["options"]["style"], "piano solo")
        self.assertNotIn("duration_seconds", req)
        self.assertIn("✅", message)

    def test_primary_audio_does_not_hide_the_first_named_output(self):
        result = {"audio": "UklGRg==", "named_audio_outputs": [
            {"id": "vocals", "audio": "dm9jYWxz"},
            {"id": "instrumental", "audio": "aW5zdA=="}]}
        with mock.patch.object(app, "_run_task", return_value=result):
            audio, files, _message = app.do_music_gen_with_files(
                "yue2", "piano solo", "", None, 30, 1234, {}, "")
        self.assertEqual(files[0], audio)
        self.assertEqual([Path(p).read_bytes() for p in files], [b"RIFF", b"vocals", b"inst"])

    def test_fireredtts3_design_selects_design_template_without_reference(self):
        response = mock.Mock(status_code=200, content=b"RIFF-demo", text="")
        with mock.patch.object(app.requests, "post", return_value=response) as post:
            output, message = app.do_vdes(
                "fireredtts3-design", "Hello.", "A calm voice.", 1234, 500, {}, "")
        self.assertIsNotNone(output, message)
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["options"]["template_name"], "voice_design")
        self.assertEqual(payload["options"]["instruction"], "A calm voice.")
        self.assertNotIn("voice_ref", payload)
        self.loaded.reset_mock()
        output, message = app.do_tts(
            "fireredtts3", "Hello.", "", None, "(none)", "", 1234, 500, {}, "")
        self.assertIsNone(output)
        self.assertIn("参考音色", message)
        self.loaded.assert_not_called()

    def test_yue2_is_not_ready_with_only_its_main_gguf(self):
        entry = next(e for e in app.CATALOG["models"] if e["id"] == "yue2")
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "Yue2-3B-GGUF"
            target.mkdir()
            for relative in app.REQUIRED_FILES[entry["download_id"]]:
                path = target / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"data")
            with mock.patch.object(app, "MODEL_SEARCH_ROOTS", (root,)):
                state = app.catalog_by_id("yue2")
                self.assertFalse(state["installed"])
                self.assertTrue(state["incomplete"])
                (target / "yue2-vae-f16.gguf").write_bytes(b"data")
                state = app.catalog_by_id("yue2")
                self.assertTrue(state["installed"])
                self.assertEqual(app._server_model_path(state), state["abs_path"])

    def test_composite_downloads_form_one_compatible_plan(self):
        records = manager.flatten_packages(manager.load_specs(manager.DEFAULT_SPECS_DIR))
        by_id = {record.id: record for record in records}
        for entry in app.CATALOG["models"]:
            extras = entry.get("additional_download_ids")
            if not extras:
                continue
            with self.subTest(model=entry["id"]):
                combined = manager.combine_packages(by_id[entry["download_id"]], records, extras)
                expected = set(by_id[entry["download_id"]].files)
                for package_id in extras:
                    expected.update(by_id[package_id].files)
                self.assertEqual(set(combined.files), expected)
                self.assertEqual(len(combined.files), len(expected))


class ModelReloadTests(unittest.TestCase):
    def test_changed_load_and_session_options_reload_but_identical_options_reuse(self):
        entry = {"id": "model", "family": "yue2", "task": "gen", "mode": "offline",
                 "installed": True, "label": "Demo", "load_options": {"catalog": "kept"}}
        proc = mock.Mock()
        proc.poll.return_value = None

        def stop():
            app._server_proc = None
            app._loaded_id = None

        def start(_entry):
            app._server_proc = proc
            app._loaded_id = "model"

        with ExitStack() as stack:
            for name in ("_server_proc", "_loaded_id", "_loaded_session_options",
                         "_loaded_load_options", "_loaded_mode"):
                stack.enter_context(mock.patch.object(app, name, None))
            stack.enter_context(mock.patch.object(app, "catalog_by_id", return_value=entry))
            stack.enter_context(mock.patch.object(app, "server_alive", side_effect=lambda: app._server_proc is not None))
            stack.enter_context(mock.patch.object(app, "_wait_health", return_value=True))
            stack.enter_context(mock.patch.object(app, "_ui_log"))
            stack.enter_context(mock.patch.object(app, "_stop_server", side_effect=stop))
            started = stack.enter_context(mock.patch.object(app, "_start_server", side_effect=start))
            for expected_starts, load_options, session_options in (
                    (1, {"weight": "q8_0"}, {}), (1, {"weight": "q8_0"}, {}),
                    (2, {"weight": "f16"}, {}), (3, {"weight": "f16"}, {"ar_lora": "adapter"}),
                    (4, {}, {})):
                app.ensure_model_loaded("model", app.GEN_TASKS, load_options=load_options,
                                        session_options=session_options)
                self.assertEqual(started.call_count, expected_starts)
                loaded_entry = started.call_args.args[0]
                self.assertEqual(loaded_entry["load_options"], {"catalog": "kept", **load_options})


class CompositeInstallTests(unittest.TestCase):
    def test_failed_component_preserves_old_install_then_retry_installs_all_files(self):
        records = manager.flatten_packages(manager.load_specs(manager.DEFAULT_SPECS_DIR))
        main = next(record for record in records if record.id == "yue2_main_q8_0")
        combined = manager.combine_packages(main, records, ["yue2_vae_f16"])
        with tempfile.TemporaryDirectory() as root:
            args = manager.make_parser().parse_args([
                "install", main.id, "--models-root", root, "--overwrite"])
            target = Path(root) / main.target_directory
            target.mkdir()
            previous = target / "previous.gguf"
            previous.write_bytes(b"previous")

            def fetch(_package, remote, output):
                output.parent.mkdir(parents=True, exist_ok=True)
                if remote.endswith("yue2-vae-f16.gguf"):
                    raise manager.ManagerError("component transfer interrupted")
                output.write_bytes(remote.encode())

            with mock.patch.object(manager, "download_file", side_effect=fetch), \
                    mock.patch("sys.stdout", new=io.StringIO()), \
                    mock.patch("sys.stderr", new=io.StringIO()), \
                    self.assertRaises(manager.ManagerError):
                manager.install_package(combined, args)
            self.assertEqual(previous.read_bytes(), b"previous")
            staging, _lock = manager.package_staging_paths(combined, Path(root))
            self.assertTrue(any(staging.rglob("*.gguf")))

            def complete(_package, remote, output):
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(remote.encode())

            with mock.patch.object(manager, "download_file", side_effect=complete), \
                    mock.patch("sys.stdout", new=io.StringIO()):
                manager.install_package(combined, args)
            for remote in combined.files:
                installed = target / manager.stripped_path(remote, combined.strip_prefix)
                self.assertEqual(installed.read_bytes(), remote.encode())
            self.assertFalse(staging.exists())

    def test_components_from_another_repository_are_rejected(self):
        records = manager.flatten_packages(manager.load_specs(manager.DEFAULT_SPECS_DIR))
        main = next(record for record in records if record.id == "yue2_main_q8_0")
        other = replace(main, id="other", download={**main.download, "repo": "other/repo"})
        with self.assertRaisesRegex(manager.ManagerError, "incompatible install layout"):
            manager.combine_packages(main, [main, other], [other.id])


if __name__ == "__main__":
    unittest.main()
