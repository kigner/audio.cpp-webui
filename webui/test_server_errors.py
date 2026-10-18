"""Server error diagnostics without importing the application or model runtime."""

import ast
import json
from pathlib import Path
import re
from types import SimpleNamespace
import unittest
from unittest.mock import Mock


class UiError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


def error_functions(language="zh", profile=None):
    source = Path(__file__).with_name("webui.py")
    tree = ast.parse(source.read_text(encoding="utf-8-sig"), filename=str(source))
    names = {"_extract_server_message", "server_error"}
    constants = {"ERROR_HINTS", "ERROR_HINTS_EN"}
    definitions = [
        item for item in tree.body
        if isinstance(item, ast.FunctionDef) and item.name in names
        or isinstance(item, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id in constants
                for target in item.targets)
    ]
    namespace = {
        "json": json,
        "re": re,
        "gr": SimpleNamespace(Error=UiError),
        "get_language": Mock(return_value=language),
        "profile_for": Mock(return_value=profile or {}),
        "_ui_log": Mock(),
        "_t": lambda zh, en, language=None: en if language == "en" else zh,
    }
    exec(compile(ast.Module(body=definitions, type_ignores=[]), str(source), "exec"),
         namespace)
    return namespace


class ServerErrorTests(unittest.TestCase):
    def test_json_message_is_preserved_when_a_known_hint_matches(self):
        functions = error_functions()
        original = "Qwen3TTS requires a session voice via --voice-ref"
        body = json.dumps({"error": {"message": original, "type": "server_error"}})

        error = functions["server_error"]({"family": "qwen3_tts"}, 500, body)

        self.assertIn(original, error.message)
        self.assertIn("该模型需要参考音色", error.message)
        functions["_ui_log"].assert_called_once_with(f"server 500: {original}")
        functions["profile_for"].assert_not_called()

    def test_plain_unknown_error_keeps_model_and_extra_guidance(self):
        functions = error_functions(profile={"input_hint": "请检查当前模型的输入格式。"})

        error = functions["server_error"](
            {"family": "example"}, 422, "  decoder returned invalid tensor dimensions  ",
            extra="第 2 段生成失败。")

        self.assertIn("server 422：decoder returned invalid tensor dimensions", error.message)
        self.assertIn("第 2 段生成失败。", error.message)
        self.assertIn("请检查当前模型的输入格式。", error.message)
        functions["_ui_log"].assert_called_once_with(
            "server 422: decoder returned invalid tensor dimensions")

    def test_english_known_hint_retains_original_diagnostics(self):
        functions = error_functions(language="en")
        original = "cudaMalloc failed: out of memory while allocating 8192 bytes"

        error = functions["server_error"](None, 500, original)

        self.assertIn(original, error.message)
        self.assertIn("Not enough VRAM. Shorten or split the input.", error.message)
        self.assertNotIn("显存不足", error.message)
        functions["_ui_log"].assert_called_once_with(f"server 500: {original}")

    def test_english_unknown_error_uses_english_model_guidance(self):
        functions = error_functions(language="en", profile={
            "input_hint": "中文提示", "input_hint_en": "Check the input format.",
        })

        error = functions["server_error"]({"family": "example"}, 503, "backend unavailable")

        self.assertIn("backend unavailable", error.message)
        self.assertIn("Check the input format.", error.message)
        self.assertNotIn("中文提示", error.message)

    def test_message_extraction_handles_json_variants_and_plain_text(self):
        extract = error_functions()["_extract_server_message"]
        cases = [
            ('{"error":{"message":"  nested error  "}}', "nested error"),
            ('{"error":"string error"}', "string error"),
            ('{"message":"top-level error"}', "top-level error"),
            ("  plain backend failure\n", "plain backend failure"),
            ('{"error":{"message":null}}', '{"error":{"message":null}}'),
            ('{"error":{"message":{"code":7}}}', '{"error":{"message":{"code":7}}}'),
            ("  {broken JSON\n", "{broken JSON"),
            (None, ""),
        ]
        for body, expected in cases:
            with self.subTest(body=body):
                self.assertEqual(extract(body), expected)

    def test_log_contains_error_message_without_response_metadata_or_request_data(self):
        functions = error_functions()
        original = "unexpected backend shape"
        body = json.dumps({
            "error": {"message": original},
            "request": {"payload": "private input", "api_key": "private key"},
        })

        error = functions["server_error"](None, 500, body, extra="User-facing context")

        self.assertIn(original, error.message)
        functions["_ui_log"].assert_called_once_with(f"server 500: {original}")
        self.assertNotIn("private input", error.message)
        self.assertNotIn("private key", error.message)
        self.assertNotIn("User-facing context", functions["_ui_log"].call_args.args[0])

    def test_long_error_is_bounded_in_popup_and_log(self):
        functions = error_functions()
        original = "backend trace " + "x" * 9000 + "not logged tail"

        error = functions["server_error"](None, 500, original)

        self.assertEqual(error.message, f"❌ server 500：{original[:400]}…")
        functions["_ui_log"].assert_called_once_with(f"server 500: {original[:2000]}…")
        self.assertNotIn("not logged tail", error.message)

    def test_empty_response_still_logs_the_status(self):
        functions = error_functions()

        error = functions["server_error"](None, 500, " \n")

        self.assertIn("server 500", error.message)
        functions["_ui_log"].assert_called_once_with("server 500: (empty response)")


if __name__ == "__main__":
    unittest.main()
