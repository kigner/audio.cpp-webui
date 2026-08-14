import unittest

try:
    from webui import webui as app
except ImportError:
    import webui as app


class AudioOutputResetTests(unittest.TestCase):
    def test_clear_update_resets_value_and_playback_position(self):
        update = app._clear_audio_output(visible=False)
        self.assertIsNone(update["value"])
        self.assertEqual(update["playback_position"], 0)
        self.assertFalse(update["visible"])
        self.assertEqual(update["__type__"], "update")

    def test_position_update_preserves_current_audio_value(self):
        update = app._reset_audio_output_position()
        self.assertNotIn("value", update)
        self.assertEqual(update["playback_position"], 0)
        self.assertEqual(update["__type__"], "update")

    def test_all_output_players_opt_into_reset_behavior(self):
        components = app.demo.get_config_file()["components"]
        outputs = [
            component for component in components
            if component["type"] == "audio"
            and "audio-output" in (component["props"].get("elem_classes") or [])
        ]
        self.assertEqual(len(outputs), 2 + 1 + 1 + app.MAX_SEP_STEMS + 1)
        self.assertTrue(all(
            component["props"].get("playback_position") == 0
            for component in outputs
        ))

    def test_browser_fallback_is_scoped_and_resets_waveform_scroll(self):
        script = app._RESET_AUDIO_SEEK_JS
        self.assertIn(".audio-output #waveform > div", script)
        self.assertIn("[part=\"scroll\"]", script)
        self.assertIn("scroll.scrollLeft = 0", script)


if __name__ == "__main__":
    unittest.main()
