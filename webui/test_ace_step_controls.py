"""Music request contracts; no models or services are started."""
import unittest

from ace_step_controls import normalize_options


class AceMusicControlsTests(unittest.TestCase):
    def test_waveform_editing_disables_only_audio_code_planning(self):
        for route in ("complete", "lego"):
            result = normalize_options({}, {"task_route": route, "track_name": "guitar",
                "complete_track_classes": ["drums", "bass"], "thinking": True,
                "audio_codes": "stale", "audio_code_string": "stale",
                "use_cot_metas": True, "duration_seconds": 5}, 20)
            self.assertFalse(result["thinking"])
            self.assertTrue(result["use_cot_metas"])
            self.assertNotIn("audio_codes", result)
            self.assertNotIn("audio_code_string", result)
            self.assertNotIn("duration_seconds", result)
        for route in ("text2music", "complete"):
            result = normalize_options({}, {"task_route": route, "thinking": True,
                "complete_track_classes": ["guitar"]})
            self.assertTrue(result["thinking"])

    def test_inactive_drafts_and_json_are_not_sent(self):
        result = normalize_options({}, {"task_route": "text2music", "source_caption": "old",
            "source_lyrics": "old", "flow_edit_n_min": 0.3, "repainting_start": 2,
            "track_name": "vocals", "complete_track_classes": ["bass"],
            "guidance_scale": 5, "flow_edit_morph": True})
        self.assertEqual(result, {"task_route": "text2music"})
        result = normalize_options({}, {"task_route": "cover-nofsq", "audio_cover_strength": 0.1,
            "cover_noise_strength": 0.2}, 20)
        self.assertEqual(result, {"task_route": "cover-nofsq"})

    def test_repaint_requires_a_valid_range_and_explicit_policy(self):
        for values in ({}, {"repainting_start": 4, "repainting_end": 2},
                       {"repainting_start": -1, "repainting_end": 3},
                       {"repainting_start": 0, "repainting_end": 21},
                       {"repainting_start": float("nan"), "repainting_end": 3}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                normalize_options({}, {"task_route": "repaint", **values}, 20)
        result = normalize_options({}, {"task_route": "repaint", "repainting_start": 2,
            "repainting_end": 4, "repaint_crossfade_frames": 99, "repaint_injection_ratio": 0}, 20)
        self.assertEqual(result["repaint_mode"], "balanced")
        self.assertEqual(result["repaint_strength"], 0.5)
        self.assertNotIn("repaint_crossfade_frames", result)
        for mode in ("conservative", "aggressive"):
            result = normalize_options({}, {**result, "repaint_mode": mode}, 20)
            self.assertNotIn("repaint_strength", result)
        result = normalize_options({}, {**result, "repaint_mode": "custom",
            "repaint_crossfade_frames": 7, "repaint_injection_ratio": 0.3}, 20)
        self.assertNotIn("repaint_mode", result)
        self.assertEqual(result["repaint_crossfade_frames"], 7)
        self.assertEqual(result["repaint_injection_ratio"], 0.3)

    def test_tracks_are_explicit_and_complete_retains_optional_source(self):
        for route in ("complete", "lego", "extract"):
            with self.subTest(route=route), self.assertRaises(ValueError):
                normalize_options({}, {"task_route": route}, 20)
        result = normalize_options({}, {"task_route": "complete", "complete_track_classes": "drums,bass,drums"})
        self.assertEqual(result["complete_track_classes"], ["drums", "bass"])
        self.assertNotIn("thinking", result)
        for route in ("cover", "cover-nofsq", "repaint", "remix", "lego", "extract"):
            with self.subTest(route=route), self.assertRaises(ValueError):
                normalize_options({}, {"task_route": route})

    def test_remix_window_and_model_specific_guidance(self):
        for values in ({"flow_edit_n_min": 0.8, "flow_edit_n_max": 0.2},
                       {"flow_edit_n_avg": 0}, {"flow_edit_n_avg": 1.5}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                normalize_options({}, {"task_route": "remix", **values}, 10)
        result = normalize_options({}, {"task_route": "remix", "source_caption": "old",
            "source_lyrics": "old lyrics", "guidance_scale": 5}, 10)
        self.assertEqual(result["source_lyrics"], "old lyrics")
        self.assertEqual(result["flow_edit_n_avg"], 2)
        self.assertNotIn("guidance_scale", result)
        base = {"load_options": {"ace_step.dit_model_path": "acestep-v15-base"}}
        self.assertEqual(normalize_options(base, {"guidance_scale": 5})["guidance_scale"], 5)


if __name__ == "__main__":
    unittest.main()
