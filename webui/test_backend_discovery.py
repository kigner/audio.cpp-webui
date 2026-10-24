import os
import shutil
import tempfile
import unittest
from unittest import mock

try:
    from webui import webui as app
except ImportError:
    import webui as app

try:
    from webui import backend_probe
except ImportError:
    import backend_probe


class BackendDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="audiocpp_webui_backend_test_")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.original_project_root = app.PROJECT_ROOT
        self.original_here = app.HERE
        self.addCleanup(setattr, app, "PROJECT_ROOT", self.original_project_root)
        self.addCleanup(setattr, app, "HERE", self.original_here)

    def _touch_server(self, *parts):
        bin_dir = os.path.join(self.root, *parts)
        os.makedirs(bin_dir, exist_ok=True)
        server = os.path.join(bin_dir, app.SERVER_EXE_NAME)
        open(server, "w").close()
        return bin_dir

    def test_macos_metal_build_dir_is_discovered(self):
        bin_dir = self._touch_server("build", "macos-metal-release", "bin")
        app.PROJECT_ROOT = self.root

        self.assertEqual(app._discover_dev_bin_dirs().get("metal"), bin_dir)

    def test_plain_build_cache_detects_metal_backend(self):
        bin_dir = self._touch_server("build", "bin")
        with open(os.path.join(self.root, "build", "CMakeCache.txt"), "w", encoding="utf-8") as f:
            f.write("ENGINE_ENABLE_METAL:BOOL=ON\nGGML_CUDA:BOOL=OFF\n")

        self.assertEqual(app._cmake_cache_backend(bin_dir), "metal")

    def test_metal_only_bundle_root_is_found(self):
        os.makedirs(os.path.join(self.root, "metal"), exist_ok=True)
        app.HERE = os.path.join(self.root, "webui")
        app.PROJECT_ROOT = self.root

        self.assertEqual(app._find_bundle_root(), self.root)

    def test_vulkan_build_and_vulkan_only_bundle_are_discovered(self):
        bin_dir = self._touch_server("build", "windows-vulkan-release", "bin")
        app.PROJECT_ROOT = self.root
        app.HERE = os.path.join(self.root, "webui")
        self.assertEqual(app._discover_dev_bin_dirs().get("vulkan"), bin_dir)
        os.makedirs(os.path.join(self.root, "vulkan"))
        self.assertEqual(app._find_bundle_root(), self.root)

    def test_vulkan_cache_is_not_misclassified_as_cpu(self):
        bin_dir = self._touch_server("build", "bin")
        with open(os.path.join(self.root, "build", "CMakeCache.txt"), "w", encoding="utf-8") as f:
            f.write("GGML_CUDA:BOOL=OFF\nENGINE_ENABLE_VULKAN:BOOL=ON\n")
        self.assertEqual(app._cmake_cache_backend(bin_dir), "vulkan")


class ServerSelectionTests(unittest.TestCase):
    def setUp(self):
        tree = tempfile.TemporaryDirectory(prefix="audiocpp_server_selection_")
        self.addCleanup(tree.cleanup)
        self.root = tree.name
        self.bundle = os.path.join(self.root, "audiocpp-portable")
        self.development = os.path.join(self.root, "build", "windows-cuda-release", "bin", app.SERVER_EXE_NAME)
        self.bundled = os.path.join(self.bundle, "gpu", app.SERVER_EXE_NAME)
        for path in (self.development, self.bundled):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            open(path, "w").close()
        globals_patch = mock.patch.multiple(app, PROJECT_ROOT=self.root, BUNDLE_ROOT=self.bundle,
                                           DEV_BIN_DIRS={"gpu": os.path.dirname(self.development)})
        globals_patch.start()
        self.addCleanup(globals_patch.stop)
        environment = mock.patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop("AUDIOCPP_BUNDLE", None)
        os.environ.pop("AUDIOCPP_BACKEND", None)

    def test_checkout_uses_its_build_with_models_in_a_portable_tree(self):
        os.mkdir(os.path.join(self.root, ".git"))
        self.assertEqual(app._server_exe_for_backend("gpu"), self.development)
        self.assertEqual(app.BUNDLE_ROOT, self.bundle)

    def test_worktree_git_file_also_selects_the_development_build(self):
        with open(os.path.join(self.root, ".git"), "w", encoding="utf-8") as handle:
            handle.write("gitdir: ../main/.git/worktrees/test\n")
        self.assertEqual(app._server_exe_for_backend("gpu"), self.development)

    def test_portable_application_keeps_its_own_runtime(self):
        self.assertEqual(app._server_exe_for_backend("gpu"), self.bundled)

    def test_explicit_bundle_override_keeps_the_selected_runtime(self):
        os.mkdir(os.path.join(self.root, ".git"))
        os.environ["AUDIOCPP_BUNDLE"] = self.bundle
        self.assertEqual(app._server_exe_for_backend("gpu"), self.bundled)

    def test_checkout_without_a_build_can_use_the_bundle(self):
        os.mkdir(os.path.join(self.root, ".git"))
        os.remove(self.development)
        self.assertEqual(app._server_exe_for_backend("gpu"), self.bundled)

    def test_development_build_remains_the_fallback_when_bundle_runtime_is_absent(self):
        os.remove(self.bundled)
        self.assertEqual(app._server_exe_for_backend("gpu"), self.development)

    def test_backend_probe_checks_the_runtime_that_will_be_started(self):
        os.mkdir(os.path.join(self.root, ".git"))
        with mock.patch.object(app.os, "name", "nt"), \
                mock.patch.object(backend_probe, "select_backend", return_value="cuda") as select:
            self.assertEqual(app._detect_backend(), "gpu")
        select.assert_called_once_with(
            self.development, os.path.join(self.bundle, "vulkan", app.SERVER_EXE_NAME))


if __name__ == "__main__":
    unittest.main()
