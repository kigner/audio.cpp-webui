import os
import shutil
import tempfile
import unittest

try:
    from webui import webui as app
except ImportError:
    import webui as app


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


if __name__ == "__main__":
    unittest.main()
