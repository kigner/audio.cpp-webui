"""A finished download has to update the model lists by itself.

Install state is rendered into the dropdown labels ("· not installed") when the page
is built, so it goes stale the moment a download completes. Only the Refresh button
used to rebuild those labels, which made a model that had just downloaded and loaded
fine keep reading as not installed. download_status_tick() now refreshes the choices
on the tick that observes the download process exit.
"""
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))

try:
    from webui import webui as app
except ImportError:
    import webui as app


class DownloadTickContractTests(unittest.TestCase):
    """The tick's return arity must match the outputs it is wired to:
    [dl_status, timer, *one dropdown per tab]. Gradio only fails on this at run time."""

    def test_tick_returns_status_timer_and_one_update_per_tab(self):
        expected = 2 + len(app.TAB_SPECS)
        for model_id in ("vevo2", "qwen3-tts"):
            with self.subTest(model_id=model_id):
                self.assertEqual(len(app.download_status_tick(model_id)), expected)

    def test_tick_returns_one_update_per_tab_while_a_download_runs(self):
        original = app._download_running
        app._download_running = lambda model_id: True
        self.addCleanup(setattr, app, "_download_running", original)
        self.assertEqual(len(app.download_status_tick("vevo2")), 2 + len(app.TAB_SPECS))

    def test_model_choice_updates_covers_every_tab(self):
        self.assertEqual(len(app._model_choice_updates()), len(app.TAB_SPECS))


class InstallStateLabelTests(unittest.TestCase):
    """The label text the refresh actually has to correct."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="audiocpp_webui_install_label_test_")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.entry = {
            "id": "vevo2", "family": "vevo2", "task": "vc", "mode": "offline",
            "display_name": "Vevo2", "display_name_en": "Vevo2",
            "download_id": "vevo2_gguf", "path": os.path.join(self.root, "Vevo2-GGUF"),
        }
        original = app.CATALOG
        app.CATALOG = {"models": [self.entry]}
        self.addCleanup(setattr, app, "CATALOG", original)

    def _label(self):
        return dict((v, k) for k, v in app.choices_for_tasks(("vc",), "en"))["vevo2"]

    def test_label_flips_once_the_package_files_are_on_disk(self):
        self.assertIn("not installed", self._label())
        os.makedirs(self.entry["path"])
        # The name model_manager installs, i.e. what required_files.json lists.
        open(os.path.join(self.entry["path"], "vevo2-q8_0.gguf"), "w").close()
        self.assertNotIn("not installed", self._label())
        self.assertNotIn("incomplete", self._label())

    def test_a_directory_missing_the_package_file_reads_as_incomplete(self):
        os.makedirs(self.entry["path"])
        self.assertIn("incomplete", self._label())


class LoadPathSelectionTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="audiocpp_webui_load_path_test_")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.legacy = os.path.join(self.root, "VoxCPM2")
        self.package = os.path.join(self.root, "VoxCPM2-GGUF")
        self.entry = {
            "id": "voxcpm2", "family": "voxcpm2", "task": "tts", "mode": "offline",
            "display_name": "VoxCPM2", "display_name_en": "VoxCPM2",
            "path": self.legacy, "download_path": self.package,
            "download_id": "voxcpm2_q8_0", "legacy_download_id": "voxcpm2",
        }
        self.original_catalog = app.CATALOG
        self.original_required = app.REQUIRED_FILES
        app.CATALOG = {"models": [self.entry]}
        app.REQUIRED_FILES = {
            "voxcpm2": ["config.json", "model.safetensors"],
            "voxcpm2_q8_0": ["voxcpm2-q8_0.gguf"],
        }
        self.addCleanup(setattr, app, "CATALOG", self.original_catalog)
        self.addCleanup(setattr, app, "REQUIRED_FILES", self.original_required)

    def _touch(self, root, *names):
        os.makedirs(root, exist_ok=True)
        for name in names:
            open(os.path.join(root, name), "w").close()

    def test_existing_tensor_install_is_still_loadable(self):
        self._touch(self.legacy, "config.json", "model.safetensors")
        entry = app.catalog_by_id("voxcpm2")
        self.assertTrue(entry["installed"])
        self.assertFalse(entry["download_installed"])
        self.assertEqual(entry["abs_path"], os.path.normpath(self.legacy).replace("\\", "/"))

    def test_gguf_package_wins_when_both_are_installed(self):
        self._touch(self.legacy, "config.json", "model.safetensors")
        self._touch(self.package, "voxcpm2-q8_0.gguf")
        entry = app.catalog_by_id("voxcpm2")
        self.assertTrue(entry["installed"])
        self.assertTrue(entry["download_installed"])
        self.assertEqual(entry["abs_path"], os.path.normpath(self.package).replace("\\", "/"))


if __name__ == "__main__":
    unittest.main()
