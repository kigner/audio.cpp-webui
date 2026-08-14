import base64
import json
import os
import tempfile
import unittest
from unittest import mock

try:
    from webui import webui as app
except ImportError:
    import webui as app


class ModelManagerBoundaryTests(unittest.TestCase):
    def test_local_webui_never_falls_back_to_upstream_manager(self):
        with tempfile.TemporaryDirectory() as root:
            here = os.path.join(root, "webui-local")
            bundle = os.path.join(root, "bundle")
            project = os.path.join(root, "project")
            os.makedirs(here)
            for parent in (bundle, project):
                tools_dir = os.path.join(parent, "tools")
                os.makedirs(tools_dir)
                open(os.path.join(tools_dir, "model_manager_v2.py"), "wb").close()

            with mock.patch.dict(os.environ, {}, clear=True), \
                    mock.patch.object(app, "HERE", here), \
                    mock.patch.object(app, "BUNDLE_ROOT", bundle), \
                    mock.patch.object(app, "PROJECT_ROOT", project):
                self.assertIsNone(app._find_spec_model_manager())

    def test_local_manager_and_explicit_override_are_supported(self):
        with tempfile.TemporaryDirectory() as root:
            here = os.path.join(root, "webui")
            os.makedirs(here)
            local = os.path.join(here, "model_manager_webui.py")
            explicit = os.path.join(root, "custom_webui_manager.py")
            open(local, "wb").close()
            open(explicit, "wb").close()

            with mock.patch.object(app, "HERE", here), \
                    mock.patch.object(app, "BUNDLE_ROOT", root), \
                    mock.patch.dict(os.environ, {}, clear=True):
                self.assertEqual(app._find_spec_model_manager(), local)
                os.environ["AUDIOCPP_WEBUI_MODEL_MANAGER"] = explicit
                self.assertEqual(app._find_spec_model_manager(), explicit)


class V060BackendCompatibilityTests(unittest.TestCase):
    def test_new_catalog_models_are_visible_in_their_local_tabs(self):
        expected = {
            "dots-tts-soar": app.TTS_TASKS,
            "dots-tts-meanflow": app.TTS_TASKS,
            "neutts-2e": app.TTS_TASKS,
            "index-tts2.5": app.TTS_TASKS,
            "minimax-h3": app.GEN_TASKS,
            "sense-asr": app.ASR_TASKS,
            "muscriptor-small": app.ANALYZE_TASKS,
        }
        for model_id, tasks in expected.items():
            visible = {choice_id for _label, choice_id in app.choices_for_tasks(tasks)}
            self.assertIn(model_id, visible)

    def test_midi_models_are_routed_to_audio_analysis(self):
        self.assertIn("midi", app.ANALYZE_TASKS)

    def test_sensevoice_exposes_streaming_capability(self):
        profile = app.profile_for({"family": "sense_asr"})
        self.assertTrue(profile["supports_streaming"])
        self.assertTrue(profile["input_16k_mono"])

    def test_all_backend_streaming_tts_families_are_exposed(self):
        expected_rates = {
            "confucius4_tts": 22050,
            "dots_tts": 48000,
            "neutts": 24000,
            "omnivoice": 24000,
            "supertonic": 44100,
            "voxcpm2": 48000,
        }
        spec_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "model_specs")
        backend_families = set()
        for name in os.listdir(spec_dir):
            if not name.endswith(".json"):
                continue
            with open(os.path.join(spec_dir, name), "r", encoding="utf-8") as handle:
                spec = json.load(handle)
            if spec.get("category") == "tts" and "streaming" in spec.get("modes", []):
                backend_families.add(spec["family"])

        self.assertEqual(backend_families, set(expected_rates))
        for family, sample_rate in expected_rates.items():
            with self.subTest(family=family):
                profile = app.profile_for({"family": family})
                self.assertTrue(profile["supports_streaming"])
                self.assertEqual(profile["stream_sample_rate"], sample_rate)

    def test_streaming_tts_hints_and_mode_choices_are_localized(self):
        model_ids = {
            "confucius4-tts", "dots-tts-soar", "dots-tts-meanflow",
            "neutts-2e", "omnivoice", "supertonic", "voxcpm2",
        }
        for model_id in model_ids:
            with self.subTest(model_id=model_id):
                zh_hint = app.model_hint_for(model_id, "zh")
                en_hint = app.model_hint_for(model_id, "en")
                hant_hint = app.model_hint_for(model_id, "zh-Hant")
                self.assertIn("流式", zh_hint)
                self.assertIn("stream", en_hint.lower())
                self.assertIn("流式", hant_hint)
                self.assertNotEqual(zh_hint, en_hint)

        mode_choices = (
            [("离线", "离线"), ("流式", "流式")],
            [("Offline", "离线"), ("Streaming", "流式")],
        )
        self.assertEqual(app._localized_prop_value("choices", mode_choices, "en"),
                         mode_choices[1])
        self.assertEqual(
            app._localized_prop_value("choices", mode_choices, "zh-Hant"),
            [("離線", "离线"), ("流式", "流式")])

    def test_streaming_tts_request_contract_for_every_exposed_family(self):
        class FakeResponse:
            status_code = 200
            text = ""

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

        pcm = base64.b64encode(b"\x01\x00\x02\x00").decode("ascii")
        events = [
            {"type": "speech.audio.delta", "audio": pcm},
            {"type": "speech.audio.done", "timing": {"ttft_ms": 25.0}},
        ]
        cases = [
            ("confucius4-tts", "confucius4_tts", "voice.wav", {}, 22050),
            ("dots-tts-meanflow", "dots_tts", "voice.wav",
             {"vocoder_merge_steps": 4}, 48000),
            ("neutts-2e", "neutts", None, {"voice_id": "emily"}, 24000),
            ("omnivoice", "omnivoice", None, {}, 24000),
            # A stale reference selected for a previous model must not hide the
            # Supertonic preset voice from the request.
            ("supertonic", "supertonic", "stale.wav", {"voice": "F1"}, 44100),
            ("voxcpm2", "voxcpm2", "voice.wav", {}, 48000),
        ]
        with tempfile.TemporaryDirectory() as output_dir:
            for model_id, family, uploaded_voice, adv_values, sample_rate in cases:
                entry = {"id": model_id, "family": family, "task": "tts"}
                with self.subTest(family=family), \
                        mock.patch.object(app, "OUTPUT_DIR", output_dir), \
                        mock.patch.object(app, "catalog_by_id", return_value=entry), \
                        mock.patch.object(app, "ensure_model_loaded") as ensure_loaded, \
                        mock.patch.object(app, "_ensure_wav", side_effect=lambda path: path), \
                        mock.patch.object(app, "_iter_sse_events", return_value=events), \
                        mock.patch.object(app.requests, "post", return_value=FakeResponse()) as post:
                    outputs = list(app.do_tts_stream(
                        model_id, "Streaming test.", "english", uploaded_voice,
                        "(none)", "Reference transcript." if uploaded_voice else "",
                        1234, 500, adv_values, ""))

                ensure_loaded.assert_called_once_with(model_id, app.TTS_TASKS, mode="streaming")
                payload = post.call_args.kwargs["json"]
                self.assertTrue(payload["stream"])
                self.assertEqual(payload["stream_format"], "sse")
                self.assertEqual(payload["response_format"], "pcm")
                streamed_audio = next(value[0] for value in outputs if value[0] is not None)
                self.assertEqual(streamed_audio[0], sample_rate)
                if family == "supertonic":
                    self.assertEqual(payload["voice"], "F1")
                    self.assertNotIn("voice_ref", payload)
                if family == "voxcpm2":
                    self.assertFalse(payload["options"]["retry_badcase"])

    def test_generic_midi_artifact_is_saved_and_json_is_redacted(self):
        artifact = {
            "id": "result",
            "kind": "midi",
            "payload": base64.b64encode(b"MThd-demo").decode("ascii"),
            "meta": {"mime": "audio/midi", "format": "midi", "extension": "mid"},
        }
        data = {"text": "[]", "artifacts": [artifact]}
        with tempfile.TemporaryDirectory() as output_dir, \
                mock.patch.object(app, "OUTPUT_DIR", output_dir):
            path = app._save_task_artifact(artifact, "audiocpp_test")
            self.assertTrue(path.endswith(".mid"))
            with open(path, "rb") as handle:
                self.assertEqual(handle.read(), b"MThd-demo")

        redacted = app._redact_task_artifacts(data)
        self.assertIn("payload omitted", redacted["artifacts"][0]["payload"])
        self.assertEqual(data["artifacts"][0]["payload"], artifact["payload"])

    def test_managed_server_config_includes_voice_directory(self):
        entry = {
            "id": "demo",
            "family": "demo",
            "abs_path": os.path.join(tempfile.gettempdir(), "demo-model"),
            "task": "tts",
            "mode": "offline",
        }
        path = app._write_temp_config(entry)
        self.addCleanup(lambda: os.path.isfile(path) and os.unlink(path))
        with open(path, "r", encoding="utf-8") as handle:
            config = json.load(handle)
        self.assertEqual(config["voice_dir"], app.VOICE_DIR)

    def test_minimax_video_artifact_is_not_silently_discarded(self):
        entry = {"family": "minimax_h3"}
        with mock.patch.object(app, "ensure_model_loaded") as load_model, \
                mock.patch.object(app, "catalog_by_id", return_value=entry):
            audio, message = app.do_music_gen(
                "minimax-h3", "prompt", "", None, 0, 1,
                {"return_video": True}, "")
        self.assertIsNone(audio)
        self.assertIn("MiniMax-H3", message)
        load_model.assert_not_called()


if __name__ == "__main__":
    unittest.main()
