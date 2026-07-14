import json
import os
import tempfile
import unittest

try:
    from ui_i18n import (
        DEFAULT_LANGUAGE,
        get_language,
        load_language,
        param_spec,
        save_language,
        set_language,
        text,
    )
except ImportError:
    from webui.ui_i18n import (
        DEFAULT_LANGUAGE,
        get_language,
        load_language,
        param_spec,
        save_language,
        set_language,
        text,
    )


HERE = os.path.dirname(os.path.abspath(__file__))


class UiI18nTests(unittest.TestCase):
    def tearDown(self):
        set_language(DEFAULT_LANGUAGE)

    def test_chinese_is_the_default(self):
        set_language(DEFAULT_LANGUAGE)
        self.assertEqual(get_language(), "zh")
        self.assertEqual(text("生成语音", "Generate speech"), "生成语音")

    def test_manual_english_switch(self):
        set_language("en")
        self.assertEqual(get_language(), "en")
        self.assertEqual(text("生成语音", "Generate speech"), "Generate speech")

    def test_unknown_language_falls_back_to_chinese(self):
        self.assertEqual(set_language("fr"), "zh")

    def test_missing_language_config_defaults_to_chinese(self):
        set_language("en")
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "missing.json")
            self.assertEqual(load_language(path), "zh")
            self.assertEqual(get_language(), "zh")

    def test_saved_language_is_loaded(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "ui_language.json")
            self.assertEqual(save_language("en", path), "en")
            set_language("zh")
            self.assertEqual(load_language(path), "en")
            self.assertEqual(get_language(), "en")
            with open(path, "r", encoding="utf-8") as f:
                self.assertEqual(json.load(f), {"language": "en"})

    def test_english_param_keeps_identifier_and_drops_long_copy(self):
        localized = param_spec({
            "name": "guidance_scale",
            "label": "guidance_scale（引导强度）",
            "info": "这是一段很长的说明",
            "placeholder": "中文占位说明",
        }, "en")
        self.assertEqual(localized["label"], "guidance_scale")
        self.assertIsNone(localized["info"])
        self.assertEqual(localized["placeholder"], "")

    def test_every_config_control_has_an_english_identifier_label(self):
        path = os.path.join(HERE, "configs", "model_params.json")
        with open(path, "r", encoding="utf-8") as f:
            config = json.load(f)
        for family, specs in config.items():
            if family.startswith("_"):
                continue
            for spec in specs:
                with self.subTest(family=family, name=spec.get("name")):
                    self.assertTrue(param_spec(spec, "en").get("label"))


if __name__ == "__main__":
    unittest.main()
