import os
import tempfile
import unittest
from unittest import mock

try:
    from webui import webui as app
except ImportError:
    import webui as app


class V070LocalWebUICompatibilityTests(unittest.TestCase):
    def test_new_backend_models_are_visible_in_their_local_tabs(self):
        expected = {
            "dots-tts-edit": app.TTS_TASKS,
            "habibi-tts": app.TTS_TASKS,
            "magpie-tts": app.TTS_TASKS,
            "minimax-music3": app.GEN_TASKS,
            "meanvc2": app.VC_TASKS,
            "personaplex": app.VC_TASKS,
            "mms-forced-aligner": app.ANALYZE_TASKS,
            "moss-voicegen": app.VDES_TASKS,
        }
        for model_id, tasks in expected.items():
            with self.subTest(model_id=model_id):
                visible = {choice_id for _label, choice_id in app.choices_for_tasks(tasks)}
                self.assertIn(model_id, visible)

    def test_new_model_profiles_preserve_local_request_contracts(self):
        profiles = {
            model_id: app.profile_for(app.catalog_by_id(model_id))
            for model_id in (
                "dots-tts-edit", "habibi-tts", "magpie-tts", "minimax-music3",
                "meanvc2", "mms-forced-aligner", "moss-voicegen",
            )
        }
        self.assertEqual(profiles["dots-tts-edit"]["voice_input_role"], "source_audio")
        self.assertTrue(profiles["dots-tts-edit"]["require_voice"])
        self.assertTrue(profiles["habibi-tts"]["require_reference_text"])
        self.assertFalse(profiles["magpie-tts"]["accepts_voice_reference"])
        self.assertTrue(profiles["minimax-music3"]["require_lyrics"])
        self.assertTrue(profiles["meanvc2"]["require_vc_target"])
        self.assertTrue(profiles["mms-forced-aligner"]["require_analysis_language"])
        self.assertFalse(profiles["moss-voicegen"]["send_max_tokens"])

    def test_dottts_edit_maps_shared_audio_input_to_source_audio(self):
        response = mock.Mock(status_code=200, content=b"RIFF-demo", text="")
        with tempfile.TemporaryDirectory() as output_dir, \
                mock.patch.object(app, "OUTPUT_DIR", output_dir), \
                mock.patch.object(app, "ensure_model_loaded") as ensure_loaded, \
                mock.patch.object(app, "_ensure_wav", side_effect=lambda path: path), \
                mock.patch.object(app.requests, "post", return_value=response) as post:
            output, message = app.do_tts(
                "dots-tts-edit", "<edit>replace this sentence</edit>", "",
                "source.wav", "(none)", "must not be sent", 1234, 500,
                {"source_text": "old", "target_text": "new"}, "")

        self.assertTrue(output.endswith(".wav"))
        self.assertIn("✅", message)
        ensure_loaded.assert_called_once_with("dots-tts-edit", app.TTS_TASKS)
        payload = post.call_args.kwargs["json"]
        self.assertNotIn("voice_ref", payload)
        self.assertNotIn("reference_text", payload)
        self.assertEqual(payload["options"]["source_audio"], "source.wav")
        self.assertEqual(payload["options"]["template_name"], "edit")
        self.assertEqual(payload["options"]["source_text"], "old")
        self.assertEqual(payload["options"]["target_text"], "new")

    def test_dottts_edit_rejects_streaming_before_loading_or_posting(self):
        with mock.patch.object(app, "ensure_model_loaded") as ensure_loaded, \
                mock.patch.object(app.requests, "post") as post:
            with self.assertRaises(app.gr.Error):
                list(app.do_tts_stream(
                    "dots-tts-edit", "<edit>replace this sentence</edit>", "",
                    "source.wav", "(none)", "", 1234, 500, {}, ""))
        ensure_loaded.assert_not_called()
        post.assert_not_called()

    def test_habibi_requires_matching_reference_text_before_loading(self):
        with mock.patch.object(app, "ensure_model_loaded") as ensure_loaded:
            output, message = app.do_tts(
                "habibi-tts", "مرحبا", "", "voice.wav", "(none)", "",
                1234, 500, {}, "")
        self.assertIsNone(output)
        self.assertIn("参考文本", message)
        ensure_loaded.assert_not_called()

    def test_meanvc2_requires_target_voice_before_loading(self):
        with mock.patch.object(app, "ensure_model_loaded") as ensure_loaded:
            output, message = app.do_vc(
                "meanvc2", "source.wav", None, "(none)", None, None,
                1234, {}, "")
        self.assertIsNone(output)
        self.assertIn("目标音色", message)
        ensure_loaded.assert_not_called()

    def test_minimax_music3_requires_lyrics_before_loading(self):
        with mock.patch.object(app, "ensure_model_loaded") as ensure_loaded:
            output, message = app.do_music_gen(
                "minimax-music3", "bright pop", "", None, -1, 1234, {}, "")
        self.assertIsNone(output)
        self.assertIn("歌词", message)
        ensure_loaded.assert_not_called()

    def test_mms_aligner_passes_advanced_options_to_generic_task(self):
        result = {"words": [{"word": "hello", "start_sample": 0, "end_sample": 1600}]}
        with tempfile.TemporaryDirectory() as output_dir, \
                mock.patch.object(app, "OUTPUT_DIR", output_dir), \
                mock.patch.object(app, "_ensure_wav", side_effect=lambda path: path), \
                mock.patch.object(app, "_to_16k_mono_wav", side_effect=lambda path: path), \
                mock.patch.object(app, "_audio_duration_seconds", return_value=1.0), \
                mock.patch.object(app, "ensure_model_loaded") as ensure_loaded, \
                mock.patch.object(app, "_run_task", return_value=result) as run_task:
            text, json_path, artifact, message = app.do_analyze(
                "mms-forced-aligner", "speech.wav", "hello", "eng",
                {"text_normalization": "latin", "star_frequency": "edges"}, "")

        self.assertIn("hello", text)
        self.assertTrue(json_path.endswith(".json"))
        self.assertIsNone(artifact)
        self.assertIn("✅", message)
        ensure_loaded.assert_called_once()
        request = run_task.call_args.args[2]
        self.assertEqual(request["language"], "eng")
        self.assertEqual(request["options"]["star_frequency"], "edges")

    def test_mms_aligner_requires_language_before_loading(self):
        with mock.patch.object(app, "_ensure_wav", side_effect=lambda path: path), \
                mock.patch.object(app, "_to_16k_mono_wav", side_effect=lambda path: path), \
                mock.patch.object(app, "ensure_model_loaded") as ensure_loaded:
            _text, _json_path, _artifact, message = app.do_analyze(
                "mms-forced-aligner", "speech.wav", "hello", "")
        self.assertIn("语言", message)
        ensure_loaded.assert_not_called()


if __name__ == "__main__":
    unittest.main()
