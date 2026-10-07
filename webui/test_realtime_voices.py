import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock

from realtime_voices import voice_metadata
from realtime_pipeline import RealtimePipeline, _TTSStage
from workbench_references import ReferenceLibrary


class RealtimeVoiceTests(unittest.TestCase):
    def test_parameter_choices_keep_labels_and_request_key(self):
        result = voice_metadata({"id": "tts", "family": "tts"}, {}, [
            {"name": "voice_id", "choices": [["女声", "female"], "male"]}], {})
        self.assertEqual(result["voices"], [
            {"label": "女声", "value": "female"}, {"label": "male", "value": "male"}])
        self.assertEqual(result["voice_parameter"], "voice_id")

    def test_spec_presets_and_reference_capabilities(self):
        result = voice_metadata({"id": "pocket", "family": "pocket_tts"},
            {"require_reference_text_with_voice": True}, [], {"ui": {"builtin_voices": ["alba"]}})
        self.assertEqual(result["voices"][0]["value"], "alba")
        self.assertEqual(result["voice_parameter"], "")
        self.assertTrue(result["accepts_voice_reference"])
        self.assertTrue(result["requires_reference_text"])

    def test_variant_without_presets_does_not_inherit_family_voices(self):
        for ident, family in [("lfm2-audio-tts-jp", "lfm2_audio"), ("qwen3-tts", "qwen3_tts")]:
            result = voice_metadata({"id": ident, "family": family}, {"accepts_voice_reference": False},
                [{"name": "voice", "choices": ["english"]}], {"ui": {"builtin_voices": ["english"]}})
            self.assertEqual(result["voices"], [])
            self.assertEqual(result["voice_parameter"], "")
            self.assertFalse(result["accepts_voice_reference"])

    def test_customvoice_reads_installed_checkpoint_speakers(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / "config.json").write_text(json.dumps({
                "talker_config": {"spk_id": {"vivian": 1, "ryan": 2}}}), encoding="utf-8")
            result = voice_metadata({"id": "qwen-customvoice", "family": "qwen3_tts", "abs_path": root},
                {}, [{"name": "speaker", "type": "text"}], {})
        self.assertEqual([v["value"] for v in result["voices"]], ["vivian", "ryan"])
        self.assertEqual(result["voice_parameter"], "speaker")

    def test_library_returns_backend_path_transcript_and_preview_together(self):
        with tempfile.TemporaryDirectory() as root:
            backend = Mock(PROMPTS_DIR=root)
            backend.builtin_voices.return_value = ["(none)", "女声.wav"]
            backend._load_voice_texts.return_value = {"女声": "你好，欢迎回来。"}
            voice = ReferenceLibrary(backend).list()[0]
            self.assertEqual(voice["voice_ref"], str((Path(root) / "女声.wav").resolve()))
            self.assertEqual(voice["text"], "你好，欢迎回来。")
            self.assertIn("%E5%A5%B3%E5%A3%B0.wav/audio", voice["url"])

    def test_explicit_clear_removes_previous_voice_and_transcript(self):
        pipeline = RealtimePipeline.__new__(RealtimePipeline)
        pipeline._cfg_lock = threading.Lock()
        pipeline._stt = Mock()
        pipeline._tts = Mock()
        pipeline._llm = Mock()
        pipeline._tts_voice, pipeline._tts_voice_ref, pipeline._tts_reference_text = "old", "old.wav", "old text"
        pipeline.configure({})
        self.assertEqual(pipeline._tts_voice_ref, "old.wav")
        pipeline.configure({"tts_voice": "", "tts_voice_ref": "", "tts_reference_text": "",
                            "tts_options": {"voice_id": "Aria"}})
        payload = _TTSStage._payload("hello", "tts", pipeline._tts_voice,
            pipeline._tts_voice_ref, pipeline._tts_reference_text, pipeline._tts_options)
        self.assertNotIn("voice_ref", payload)
        self.assertNotIn("reference_text", payload)
        self.assertNotIn("voice", payload)
        self.assertEqual(payload["options"]["voice_id"], "Aria")


if __name__ == "__main__":
    unittest.main()
