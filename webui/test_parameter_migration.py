"""Regression for legacy-to-workbench model parameter contracts; no inference."""
import copy
import json
import tempfile
import unittest
from unittest import mock

try:
    from webui import webui as app
    from webui.workbench_metadata import model_detail
except ImportError:
    import webui as app
    from workbench_metadata import model_detail


class ParameterMigrationTests(unittest.TestCase):
    def detail(self, ident):
        return model_detail(app, app.catalog_by_id(ident))

    def test_entry_defaults_match_the_request_profile_without_mutating_catalog(self):
        original = copy.deepcopy(app.MODEL_PARAMS)
        for ident, expected in (
                ("minimax-h3", {"height": 32, "width": 32, "num_inference_steps": 12}),
                ("dots-tts-edit", {"template_name": "edit"})):
            controls = {p["name"]: p for p in self.detail(ident)["parameters"]}
            for name, value in expected.items():
                self.assertEqual(controls[name]["default"], value)
        self.assertEqual(app.MODEL_PARAMS, original)
        ace = {p["name"]: p for p in self.detail("ace-step")["parameters"]}
        self.assertEqual(ace["num_inference_steps"]["route_defaults"]["remix"], 16)
        self.assertEqual(ace["guidance_scale"]["route_defaults"]["extract"], 7)
        self.assertGreaterEqual(ace["guidance_scale"]["maximum"], 7)

    def test_backend_bounds_and_choices_update_legacy_controls(self):
        heart = {p["name"]: p for p in app.params_for("heartmula")}
        self.assertEqual(heart["top_k"]["minimum"], 1)
        dots = {p["name"]: p for p in app.params_for("dots-tts-soar")}
        self.assertNotIn("edit", dots["template_name"]["choices"])
        edit = {p["name"]: p for p in app.params_for("dots-tts-edit")}
        self.assertIn("edit", edit["template_name"]["choices"])
        habibi = {p["name"]: p for p in app.params_for("habibi-tts")}
        self.assertIn("MSA", habibi["dialect"]["choices"])
        minimax = {p["name"]: p for p in app.params_for("minimax-h3")}
        self.assertEqual(minimax["dit_acceleration"]["choices"], ["none", "spectrum", "first_block_cache"])
        self.assertEqual(self.detail("neutts-2e")["max_tokens_min"], 0)
        self.assertEqual(self.detail("glm-tts")["max_tokens_min"], 1)

    def test_context_and_edit_route_controls_match_the_models(self):
        for ident in ("higgs-audio-stt", "confucius4-r2t2"):
            self.assertTrue(self.detail(ident)["asr_inputs"]["context"])
        self.assertFalse(self.detail("citrinet-asr")["asr_inputs"]["context"])
        edit = {p["name"]: p for p in self.detail("firered-audio-edit")["parameters"]}
        self.assertEqual([item[1] for item in edit["template_name"]["choices"]],
                         ["acoustic_edit", "semantic_edit"])
        self.assertEqual(edit["template_name"]["default"], "acoustic_edit")
        self.assertNotIn("instruction", edit)  # main edit text supplies it
        for ident in ("firered-audio", "firered-audio-tts", "firered-audio-design"):
            self.assertNotIn("template_name", {p["name"] for p in self.detail(ident)["parameters"]})

    def test_speech_limits_preserve_blank_zero_and_json_priority_for_all_routes(self):
        response = mock.MagicMock(status_code=200, content=b"RIFF-test", text="")
        response.__enter__.return_value = response
        events = [{"type": "speech.audio.delta", "audio": "AQACAA=="},
                  {"type": "speech.audio.done", "timing": {}}]
        with tempfile.TemporaryDirectory() as output, \
                mock.patch.object(app, "OUTPUT_DIR", output), \
                mock.patch.object(app, "_ensure_with_options"), \
                mock.patch.object(app, "_ui_log"), \
                mock.patch.object(app, "_iter_sse_events", return_value=events), \
                mock.patch.object(app.requests, "post", return_value=response) as post:
            for limit, options, raw, expected in (
                    (None, {}, "", None), (0, {}, "", 0), (500, {}, "", 500),
                    (None, {"max_tokens": 2000}, "", 2000),
                    (500, {"max_tokens": 800}, '{"max_tokens":1800}', 1800)):
                for route in ("offline", "streaming", "design"):
                    with self.subTest(limit=limit, route=route, expected=expected):
                        args = ("qwen3-tts-1.7b-custom", "Hello.", "", None,
                                "(none)", "", 1234, limit, options, raw)
                        if route == "offline":
                            path, message = app.do_tts(*args)
                        elif route == "streaming":
                            _, path, message = list(app.do_tts_stream("breeze-tts", *args[1:]))[-1]
                        else:
                            path, message = app.do_vdes("breeze-tts-design", "Hello.",
                                                       "Calm voice", 1234, limit, options, raw)
                        self.assertTrue(path, message)
                        payload = post.call_args.kwargs["json"]
                        if expected is None:
                            self.assertNotIn("max_tokens", payload)
                        else:
                            self.assertEqual(payload["max_tokens"], expected)
                        self.assertNotIn("max_tokens", payload.get("options", {}))

    def test_vibevoice_keeps_automatic_budget_with_a_blank_limit(self):
        text = "A sufficiently long narration about a quiet landscape and the changing seasons. " * 4
        response = mock.Mock(status_code=200, content=b"RIFF-test")
        with tempfile.TemporaryDirectory() as output, \
                mock.patch.object(app, "OUTPUT_DIR", output), \
                mock.patch.object(app, "_ensure_with_options"), \
                mock.patch.object(app, "_ui_log"), \
                mock.patch.object(app.requests, "post", return_value=response) as post:
            path, message = app.do_tts("vibevoice", text, "", None, "(none)", "", 1234, None, {}, "")
        self.assertTrue(path, message)
        self.assertGreater(post.call_args.kwargs["json"]["max_tokens"], 0)
        self.assertLessEqual(post.call_args.kwargs["json"]["max_tokens"], 1200)

    def test_music_analysis_preserves_runtime_settings_and_maps_results(self):
        options = {"num_inference_steps": 8, "session_options.ace_step.weight_type": "f16", "lm_temperature": 0.5}
        result = {"text": json.dumps({"caption": "Warm piano", "lyrics": "Hello",
                                      "bpm": 90, "keyscale": "C major", "timesignature": "4/4"})}
        with mock.patch.object(app, "_ensure_with_options") as ensure, \
                mock.patch.object(app, "_ensure_wav", side_effect=lambda p: p), \
                mock.patch.object(app, "_audio_duration_seconds", return_value=2), \
                mock.patch.object(app, "_ui_log"), \
                mock.patch.object(app, "_run_task", return_value=result) as run:
            values, prefill, message = app.do_music_analyze("ace-step", "source.wav", -1, options)
        self.assertIn("✅", message)
        self.assertEqual(prefill["source_caption"], "Warm piano")
        self.assertEqual(prefill["source_lyrics"], "Hello")
        self.assertEqual(values["num_inference_steps"], 8)
        self.assertEqual(ensure.call_args.args[2]["session_options.ace_step.weight_type"], "f16")
        self.assertEqual(run.call_args.args[2]["task_route"], "analyze")
        self.assertEqual(run.call_args.args[2]["seed"], 1234)
        self.assertEqual(run.call_args.args[2]["options"], {"lm_temperature": 0.5})
        self.assertNotIn("source_caption", options)

    def test_analysis_explains_an_existing_binary_without_the_restored_route(self):
        with mock.patch.object(app, "_ensure_with_options"), \
                mock.patch.object(app, "_ensure_wav", side_effect=lambda p: p), \
                mock.patch.object(app, "_audio_duration_seconds", return_value=2), \
                mock.patch.object(app, "_ui_log"), \
                mock.patch.object(app, "_run_task", side_effect=app.gr.Error("Unsupported ACE-Step route: analyze")):
            _, prefill, message = app.do_music_analyze("ace-step", "source.wav", 1234, {})
        self.assertIn("❌", message)
        self.assertIn("audiocpp_server", message)
        self.assertEqual(prefill.get("__type__"), "update")


if __name__ == "__main__":
    unittest.main()
