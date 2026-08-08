"""The WebUI must agree with the C++ loader about which GGUF a model directory means.

find_directory_gguf() in src/framework/assets/tensor_source.cpp resolves a model
directory to model.gguf, or to the sole *.gguf in it. The WebUI used to match only
model.gguf, so an installed GGUF package that keeps its release name
(vevo2-q8_0.gguf, voxtral-mini-4b-realtime-2602-q8_0.gguf) read as "no GGUF yet" and
the GGUF inspector missed the file that would actually load (issue #113).
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)

try:
    from webui import webui as app
except ImportError:
    import webui as app


def _entry(path, download_id=None):
    return {"abs_path": path, "download_id": download_id, "family": "vevo2",
            "id": "vevo2", "label": "Vevo2", "installed": True, "incomplete": False}


class ExistingGgufPathTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="audiocpp_webui_gguf_test_")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.model_dir = os.path.join(self.root, "Vevo2-GGUF")
        os.makedirs(self.model_dir)

    def _touch(self, name):
        path = os.path.join(self.model_dir, name)
        open(path, "w").close()
        return path

    def test_release_named_package_gguf_is_found(self):
        expected = self._touch("vevo2-q8_0.gguf")
        self.assertEqual(app._existing_gguf_path(_entry(self.model_dir)), expected)

    def test_model_gguf_wins_over_a_release_named_sibling(self):
        self._touch("vevo2-q8_0.gguf")
        expected = self._touch("model.gguf")
        self.assertEqual(app._existing_gguf_path(_entry(self.model_dir)), expected)

    def test_several_release_named_ggufs_are_ambiguous(self):
        # The loader refuses to guess between them, so neither may be advertised.
        self._touch("vevo2-q8_0.gguf")
        self._touch("vevo2-f16.gguf")
        self.assertIsNone(app._existing_gguf_path(_entry(self.model_dir)))

    def test_directory_without_a_gguf_has_none(self):
        self._touch("model.safetensors")
        self.assertIsNone(app._existing_gguf_path(_entry(self.model_dir)))

    def test_declared_nested_package_gguf_is_found(self):
        nested_dir = os.path.join(self.model_dir, "turbo")
        os.makedirs(nested_dir)
        expected = os.path.join(nested_dir, "ace-step-1.5-turbo-q8_0.gguf")
        open(expected, "w").close()
        entry = _entry(self.model_dir, download_id="ace_step_turbo_q8_0")
        self.original_required_files = app.REQUIRED_FILES
        app.REQUIRED_FILES = {"ace_step_turbo_q8_0": ["turbo/ace-step-1.5-turbo-q8_0.gguf"]}
        self.addCleanup(setattr, app, "REQUIRED_FILES", self.original_required_files)

        self.assertEqual(app._existing_gguf_path(entry), expected)

    def test_explicit_gguf_model_path_is_itself(self):
        path = os.path.join(self.root, "direct.gguf")
        open(path, "w").close()
        self.assertEqual(app._existing_gguf_path(_entry(path)), path)


class GgufStatusTests(unittest.TestCase):
    def test_downloaded_package_reports_the_gguf_it_will_load(self):
        # vevo2 is not WebUI-convertible; before the fix this returned the
        # "cannot be converted automatically" warning even with a GGUF installed.
        root = tempfile.mkdtemp(prefix="audiocpp_webui_gguf_status_test_")
        self.addCleanup(shutil.rmtree, root, True)
        name = "vevo2-q8_0.gguf"
        open(os.path.join(root, name), "w").close()
        entry = _entry(root, download_id="vevo2_gguf")
        original = app.catalog_by_id
        app.catalog_by_id = lambda model_id: entry
        self.addCleanup(setattr, app, "catalog_by_id", original)
        self.assertIn(name, app.gguf_status("vevo2"))


class ServerConfigGgufPathTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="audiocpp_webui_gguf_config_test_")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.original_required_files = app.REQUIRED_FILES
        self.addCleanup(setattr, app, "REQUIRED_FILES", self.original_required_files)

    def _read_temp_config(self, entry):
        path = app._write_temp_config(entry)
        self.addCleanup(lambda: os.path.exists(path) and os.remove(path))
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def test_downloaded_gguf_package_writes_explicit_gguf_path(self):
        name = "fish-audio-s2-pro-q8_0.gguf"
        target = os.path.join(self.root, name)
        open(target, "w").close()
        entry = _entry(self.root, download_id="fish_audio_s2_pro")
        app.REQUIRED_FILES = {"fish_audio_s2_pro": [name]}

        cfg = self._read_temp_config(entry)

        self.assertEqual(cfg["models"][0]["path"], target)

    def test_downloaded_nested_gguf_package_writes_explicit_gguf_path(self):
        name = "turbo/ace-step-1.5-turbo-q8_0.gguf"
        target = os.path.join(self.root, "turbo", "ace-step-1.5-turbo-q8_0.gguf")
        os.makedirs(os.path.dirname(target))
        open(target, "w").close()
        entry = _entry(self.root, download_id="ace_step_turbo_q8_0")
        app.REQUIRED_FILES = {"ace_step_turbo_q8_0": [name]}

        cfg = self._read_temp_config(entry)

        self.assertEqual(cfg["models"][0]["path"], target)

    def test_safetensors_package_keeps_directory_path(self):
        open(os.path.join(self.root, "model.gguf"), "w").close()
        entry = _entry(self.root, download_id="fish_audio_s2_pro_hf")
        app.REQUIRED_FILES = {"fish_audio_s2_pro_hf": ["config.json", "model.safetensors"]}

        cfg = self._read_temp_config(entry)

        self.assertEqual(cfg["models"][0]["path"], self.root)


if __name__ == "__main__":
    unittest.main()
