"""Verify the workbench's visible inputs against the shipped music contracts."""
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

try:
    from .workbench_metadata import music_inputs
except ImportError:
    from workbench_metadata import music_inputs


ROOT = Path(__file__).resolve().parents[1]


class MusicInputMetadataTests(unittest.TestCase):
    def inputs(self, family, profile=None):
        specs = json.loads((ROOT / "model_specs" / (family + ".json")).read_text(encoding="utf-8"))
        params = json.loads((ROOT / "webui/configs/model_params.json").read_text(encoding="utf-8"))
        backend = SimpleNamespace(MODEL_SPECS={family: specs})
        return music_inputs(backend, {"family": family}, profile or {}, params.get(family, []))

    def test_stable_audio_ignores_broad_lyrics_tag_and_accepts_optional_source(self):
        fields = self.inputs("stable_audio")
        self.assertFalse(fields["lyrics"])
        self.assertTrue(fields["source_audio"])
        self.assertFalse(fields["require_source_audio"])
        self.assertIsNone(fields["source_audio_routes"])
        self.assertTrue(fields["duration"])
        self.assertGreater(fields["duration_min"], 0)

    def test_legacy_routes_only_enable_matching_source_input(self):
        fields = self.inputs("ace_step")
        self.assertTrue(fields["lyrics"])
        self.assertNotIn("text2music", fields["source_audio_routes"])
        self.assertIn("complete", fields["source_audio_routes"])
        self.assertNotIn("complete", fields["source_required_routes"])
        self.assertIn("cover", fields["source_required_routes"])
        self.assertIn("remix", fields["source_required_routes"])
        self.assertTrue(fields["duration"])

    def test_instrumental_and_effect_models_do_not_offer_lyrics_or_source(self):
        for family in ("midashenglm_gen", "controlfoley", "minimax_h3"):
            with self.subTest(family=family):
                fields = self.inputs(family)
                self.assertFalse(fields["lyrics"])
                self.assertFalse(fields["source_audio"])
                self.assertEqual(fields["text_role"], "prompt")
                self.assertEqual(fields["duration"], family != "minimax_h3")
        self.assertEqual(self.inputs("controlfoley")["duration_default"], 8.0)
        self.assertIsNone(self.inputs("controlfoley")["duration_max"])

    def test_lyrics_contract_distinguishes_required_optional_and_text_fallback(self):
        music3 = self.inputs("minimax_music3")
        self.assertTrue(music3["lyrics"])
        self.assertTrue(music3["require_lyrics"])
        yue = self.inputs("yue2")
        self.assertTrue(yue["lyrics"])
        self.assertFalse(yue["require_lyrics"])
        self.assertFalse(yue["duration"])
        self.assertFalse(yue["source_audio"])
        heart = self.inputs("heartmula")
        self.assertEqual(heart["text_role"], "lyrics")
        self.assertEqual(heart["text_label"], "歌词")
        self.assertFalse(heart["lyrics"])
        self.assertFalse(heart["source_audio"])
        self.assertEqual(heart["duration_default"], 120.0)

    def test_catalog_edit_profile_requires_source_without_adding_lyrics(self):
        for family in ("auk", "firered_audio"):
            with self.subTest(family=family):
                fields = self.inputs(family, {"require_source_audio": True, "omit_nonpositive_duration": True})
                self.assertEqual(fields["text_role"], "instruction")
                self.assertTrue(fields["source_audio"])
                self.assertTrue(fields["require_source_audio"])
                self.assertFalse(fields["lyrics"])
                self.assertEqual(fields["duration"], family == "auk")

    def test_unknown_contract_does_not_invent_optional_inputs(self):
        fields = music_inputs(SimpleNamespace(), {"family": "unknown"}, {}, [])
        self.assertFalse(fields["lyrics"])
        self.assertFalse(fields["source_audio"])
        self.assertFalse(fields["duration"])


if __name__ == "__main__":
    unittest.main()
