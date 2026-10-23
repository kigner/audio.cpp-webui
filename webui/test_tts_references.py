import os
import tempfile
import unittest
from unittest import mock

try:
    from webui import webui as app
    from webui import workbench_metadata as metadata
except ImportError:
    import webui as app
    import workbench_metadata as metadata


class QwenTtsReferenceTests(unittest.TestCase):
    def setUp(self):
        self.output_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.output_dir.cleanup)
        for name, kwargs in (
                ("OUTPUT_DIR", {"new": self.output_dir.name}),
                ("get_language", {"return_value": "zh"}),
                ("_ui_log", {}),
                ("ensure_model_loaded", {}),
                ("_ensure_wav", {"side_effect": lambda path: path})):
            patcher = mock.patch.object(app, name, **kwargs)
            value = patcher.start()
            self.addCleanup(patcher.stop)
            setattr(self, name, value)
        response = mock.Mock(status_code=200, content=b"RIFF-demo", text="")
        patcher = mock.patch.object(app.requests, "post", return_value=response)
        self.post = patcher.start()
        self.addCleanup(patcher.stop)

    def synthesize(self, model="qwen3-tts", voice=None, builtin="(none)",
                   transcript="", options=None, raw_options=""):
        return app.do_tts(model, "你好，欢迎使用语音合成。", "chinese", voice,
                          builtin, transcript, 1234, 500, options or {}, raw_options)

    def test_real_base_metadata_requires_audio_and_transcript(self):
        for model in ("qwen3-tts", "qwen3-tts-1.7b"):
            with self.subTest(model=model):
                detail = metadata.model_detail(app, app.catalog_by_id(model))
                self.assertTrue(detail["require_voice"])
                self.assertTrue(detail["requires_reference_text"])
                self.assertEqual(detail["voice_mode"], "reference")

    def test_real_custom_and_design_metadata_do_not_require_reference(self):
        for model in ("qwen3-tts-1.7b-custom", "qwen3-tts-1.7b-vdesign"):
            with self.subTest(model=model):
                detail = metadata.model_detail(app, app.catalog_by_id(model))
                self.assertFalse(detail["require_voice"])
                self.assertFalse(detail["requires_reference_text"])
                self.assertFalse(detail["accepts_voice_reference"])
                self.assertFalse(detail["profile"]["send_reference_text"])

    def test_missing_audio_is_rejected_before_model_load_or_http_request(self):
        for options in ({}, {"x_vector_only_mode": True}):
            with self.subTest(options=options):
                output, message = self.synthesize(options=options)
                self.assertIsNone(output)
                self.assertIn("参考音色", message)
        self.ensure_model_loaded.assert_not_called()
        self.post.assert_not_called()

    def test_missing_transcript_is_rejected_for_default_and_explicit_false(self):
        for options, raw in (({}, ""), ({"x_vector_only_mode": False}, ""),
                             ({}, '{"x_vector_only_mode":"false"}')):
            with self.subTest(options=options, raw=raw):
                output, message = self.synthesize(voice="voice.wav", options=options,
                                                  raw_options=raw)
                self.assertIsNone(output)
                self.assertIn("参考文本", message)
        self.ensure_model_loaded.assert_not_called()
        self.post.assert_not_called()

    def test_x_vector_mode_accepts_audio_without_transcript(self):
        for options, raw, expected in (({"x_vector_only_mode": True}, "", True),
                                      ({}, '{"x_vector_only_mode":"true"}', "true")):
            with self.subTest(options=options, raw=raw):
                output, message = self.synthesize(voice="voice.wav", options=options,
                                                  raw_options=raw)
                self.assertTrue(output.endswith(".wav"), message)
                payload = self.post.call_args.kwargs["json"]
                self.assertEqual(payload["voice_ref"], "voice.wav")
                self.assertEqual(payload["options"]["x_vector_only_mode"], expected)
                self.assertNotIn("reference_text", payload)

    def test_library_reference_keeps_audio_and_matching_transcript(self):
        output, message = self.synthesize(builtin="saved.wav", transcript="参考原文")
        self.assertTrue(output.endswith(".wav"), message)
        payload = self.post.call_args.kwargs["json"]
        self.assertEqual(payload["voice_ref"], os.path.join(app.PROMPTS_DIR, "saved.wav"))
        self.assertEqual(payload["reference_text"], "参考原文")

    def test_uploaded_reference_keeps_audio_and_matching_transcript(self):
        output, message = self.synthesize(voice="uploaded.wav", transcript="上传原文")
        self.assertTrue(output.endswith(".wav"), message)
        payload = self.post.call_args.kwargs["json"]
        self.assertEqual(payload["voice_ref"], "uploaded.wav")
        self.assertEqual(payload["reference_text"], "上传原文")

    def test_custom_voice_sends_speaker_without_stale_reference(self):
        output, message = self.synthesize("qwen3-tts-1.7b-custom", voice="stale.wav",
                                          transcript="旧参考原文", options={"speaker": "Vivian"})
        self.assertTrue(output.endswith(".wav"), message)
        payload = self.post.call_args.kwargs["json"]
        self.assertEqual(payload["options"]["voice_id"], "Vivian")
        self.assertNotIn("speaker", payload["options"])
        self.assertNotIn("voice_ref", payload)
        self.assertNotIn("reference_text", payload)

    def test_x_vector_option_does_not_bypass_other_models_transcript_requirement(self):
        output, message = self.synthesize("habibi-tts", voice="voice.wav",
                                          options={"x_vector_only_mode": True})
        self.assertIsNone(output)
        self.assertIn("参考文本", message)
        self.ensure_model_loaded.assert_not_called()
        self.post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
