"""Regression contracts for issues observed by the real October functional QA."""
import json
from pathlib import Path
import re
from types import SimpleNamespace
import unittest

try:
    from . import workbench_metadata as metadata
except ImportError:
    import workbench_metadata as metadata


ROOT = Path(__file__).resolve().parents[1]


class WorkbenchQaRepairMetadataTests(unittest.TestCase):
    def detail(self, family, task="tts", ident=None, parameters=None):
        entry = {"id": ident or family, "label": "QA", "family": family, "task": task}
        backend = SimpleNamespace(
            SPEC_PACKAGE_BY_ID={}, SERVER_BACKEND="cpu", MODEL_SPECS={},
            profile_for=lambda _: {}, params_for=lambda _: parameters or [],
            _webui_can_install_package=lambda _: False)
        return metadata.model_detail(backend, entry)

    def test_omnivoice_shipped_choices_match_the_native_language_table(self):
        source = (ROOT / "src/models/omnivoice/language_map.inc").read_text(encoding="utf-8")
        native = re.findall(r'\{"([^"\\]+)",\s*"([^"\\]+)"\}', source)
        shipped = json.loads((ROOT / "webui/configs/omnivoice_languages.json").read_text(encoding="utf-8"))
        self.assertEqual(shipped["languages"], [[name, code] for code, name in native])
        self.assertEqual(len(native), 646)
        self.assertEqual(len({code for code, _ in native}), len(native))
        visible = metadata.model_languages({"family": "omnivoice"}, {"languages": ["600+ languages"]}, {}, [])
        self.assertIn(["English", "en"], visible)
        self.assertIn(["Chinese", "zh"], visible)
        self.assertNotIn("600+ languages", [choice[1] for choice in visible])

    def test_seed_routes_match_the_fixed_backend_task_and_default(self):
        choices = ["v2_vc", "v1_svc", "v1_whisper_bigvgan_vc", "v1_xlsr_hift_vc"]
        for task, default, expected in (
                ("vc", "v2_vc", [choices[0], *choices[2:]]),
                ("svc", "v1_svc", [choices[1]])):
            with self.subTest(task=task):
                detail = self.detail("seed_vc", task, parameters=[{"name": "route", "type": "choice", "choices": choices, "default": "v2_vc"}])
                route = detail["parameters"][0]
                self.assertEqual(route["choices"], expected)
                self.assertEqual(route["default"], default)

    def test_dot_instruction_is_only_present_for_edit_and_never_duplicates_alias(self):
        for ident in ("dots-tts-soar", "dots-tts-meanflow", "dots-tts-edit"):
            entry = {"id": ident, "family": "dots_tts", "task": "tts"}
            self.assertEqual(metadata.parameter_applies(entry, "instruct"), ident.endswith("edit"))
            self.assertFalse(metadata.parameter_applies(entry, "instruction"))
        # An explicitly declared editing template is also an editing contract.
        self.assertTrue(metadata.parameter_applies({"id": "edit-variant", "family": "dots_tts", "task": "tts", "default_options": {"template_name": "edit"}}, "instruct"))

    def test_voxcpm_loader_precision_is_hidden_but_consumed_session_precision_remains(self):
        entry = {"id": "voxcpm1", "family": "voxcpm1", "task": "tts"}
        for key in ("weight_type", "audiovae_weight_type"):
            self.assertFalse(metadata.parameter_applies(entry, "load_options.voxcpm1." + key))
            self.assertTrue(metadata.parameter_applies(entry, "session_options.voxcpm1." + key))
        self.assertTrue(metadata.parameter_applies(entry, "session_options.voxcpm1.mem_saver"))
        self.assertTrue(metadata.parameter_applies({"id": "other", "family": "other", "task": "tts"}, "load_options.other.weight_type"))


if __name__ == "__main__":
    unittest.main()
