import json
import os
import re
import tempfile
import unittest

try:
    from ui_i18n import (
        DEFAULT_LANGUAGE,
        LANGUAGE_CHOICES,
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
        LANGUAGE_CHOICES,
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

    def test_language_choices_are_in_requested_order(self):
        self.assertEqual(LANGUAGE_CHOICES, [
            ("中文", "zh"),
            ("中文繁體", "zh-Hant"),
            ("English", "en"),
        ])

    def test_manual_traditional_chinese_switch(self):
        set_language("zh-Hant")
        self.assertEqual(get_language(), "zh-Hant")
        self.assertEqual(text("生成语音", "Generate speech"), "生成語音")

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

    def test_saved_traditional_chinese_is_loaded(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "ui_language.json")
            self.assertEqual(save_language("zh-Hant", path), "zh-Hant")
            set_language("zh")
            self.assertEqual(load_language(path), "zh-Hant")
            self.assertEqual(get_language(), "zh-Hant")

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

    def test_traditional_param_converts_visible_copy_only(self):
        localized = param_spec({
            "name": "guidance_scale",
            "label": "引导强度",
            "info": "加载模型后生效",
            "placeholder": "请输入文件路径",
            "value": "保持不变",
        }, "zh-Hant")
        self.assertEqual(localized["name"], "guidance_scale")
        self.assertEqual(localized["label"], "引導強度")
        self.assertEqual(localized["info"], "加載模型後生效")
        self.assertEqual(localized["placeholder"], "請輸入文件路徑")
        self.assertEqual(localized["value"], "保持不变")

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

    def test_streaming_tts_explanatory_copy_has_explicit_english(self):
        path = os.path.join(HERE, "configs", "model_params.json")
        with open(path, "r", encoding="utf-8") as f:
            config = json.load(f)
        streaming_families = {
            "confucius4_tts", "dots_tts", "neutts",
            "omnivoice", "supertonic", "voxcpm2",
        }
        han = re.compile(r"[\u3400-\u9fff]")
        for family in streaming_families:
            for spec in config.get(family, []):
                for field in ("label", "info", "placeholder"):
                    source = spec.get(field)
                    if not isinstance(source, str) or not han.search(source):
                        continue
                    with self.subTest(family=family, name=spec.get("name"), field=field):
                        self.assertTrue(spec.get(f"{field}_en"))
                        self.assertFalse(han.search(param_spec(spec, "en").get(field) or ""))


if __name__ == "__main__":
    unittest.main()
