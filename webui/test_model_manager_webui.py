"""The WebUI-local model manager installs packages directly from model_specs/.

The WebUI should be relatively self-contained for downloads: no legacy
tools/model_manager.py catalog, no conversion path, and no safetensors package
bridge. model_manager_webui.py is the small spec-v1 downloader copied next to the
WebUI, so these tests cover the package selection and final on-disk layout.
"""
import os
import shutil
import sys
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import model_manager_webui as mmw  # noqa: E402


class _Response:
    def __init__(self, body, headers, status):
        self._body = BytesIO(body)
        self.headers = headers
        self.status = status

    def read(self, size=-1):
        return self._body.read(size)

    def getcode(self):
        return self.status

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def _package(**overrides):
    values = {
        "family": "demo",
        "id": "demo_q8_0",
        "display_name": "Demo Q8_0",
        "target_directory": "Demo-GGUF",
        "format": "gguf",
        "precision": "q8_0",
        "files": ("Demo-GGUF/model-q8_0.gguf",),
        "strip_prefix": "Demo-GGUF/",
        "download": {"kind": "huggingface_snapshot", "repo": "audio-cpp/audio.cpp-gguf"},
        "default": True,
    }
    values.update(overrides)
    return mmw.PackageRecord(**values)


class SpecPackageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.records = mmw.flatten_packages(mmw.load_specs(mmw.DEFAULT_SPECS_DIR))
        cls.by_id = {record.id: record for record in cls.records}

    def test_webui_manager_reads_default_spec_packages(self):
        voxcpm2 = self.by_id["voxcpm2_q8_0"]
        self.assertEqual(voxcpm2.family, "voxcpm2")
        self.assertEqual(voxcpm2.format, "gguf")
        self.assertEqual(voxcpm2.target_directory, "VoxCPM2-GGUF")
        self.assertEqual(voxcpm2.download["repo"], "audio-cpp/audio.cpp-gguf")

        inflect = self.by_id["inflect_micro_v2_orig"]
        self.assertEqual(inflect.family, "inflect_v2")
        self.assertEqual(inflect.format, "gguf")
        self.assertEqual(inflect.target_directory, "Inflect-Micro-v2-GGUF")

    def test_selecting_a_family_uses_its_default_package(self):
        selected = mmw.select_package(self.records, SimpleNamespace(
            package="voxcpm2", format=None, precision=None))
        self.assertEqual(selected.id, "voxcpm2_q8_0")

    def test_non_huggingface_package_is_rejected(self):
        package = _package(download={"kind": "local"})
        with self.assertRaises(mmw.ManagerError):
            mmw.ensure_hf_package(package)


class InstallPlacementTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="audiocpp_webui_manager_test_")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.calls = []
        original = mmw.download_file
        self.addCleanup(setattr, mmw, "download_file", original)

        def fake_download(package, remote_path, output_path):
            self.calls.append((remote_path, output_path.name))
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"gguf")

        mmw.download_file = fake_download

    def _install(self, package, overwrite=False):
        args = SimpleNamespace(
            models_root=self.root,
            overwrite=overwrite,
            check=False,
            dry_run=False,
        )
        mmw.install_package(package, args)

    def test_strip_prefix_file_lands_at_its_installed_path(self):
        self._install(_package())
        self.assertTrue(os.path.isfile(os.path.join(self.root, "Demo-GGUF", "model-q8_0.gguf")))
        self.assertEqual(self.calls, [
            ("Demo-GGUF/model-q8_0.gguf", "model-q8_0.gguf"),
        ])

    def test_nested_paths_below_the_stripped_prefix_are_preserved(self):
        package = _package(files=("Demo-GGUF/tokenizer/config.json",))
        self._install(package)
        self.assertTrue(os.path.isfile(os.path.join(self.root, "Demo-GGUF", "tokenizer", "config.json")))

    def test_packages_without_a_strip_prefix_are_unchanged(self):
        package = _package(files=("config.json",), strip_prefix="")
        self._install(package)
        self.assertTrue(os.path.isfile(os.path.join(self.root, "Demo-GGUF", "config.json")))

    def test_existing_target_requires_overwrite(self):
        os.makedirs(os.path.join(self.root, "Demo-GGUF"))
        with self.assertRaises(mmw.ManagerError):
            self._install(_package(), overwrite=False)
        self._install(_package(), overwrite=True)
        self.assertTrue(os.path.isfile(os.path.join(self.root, "Demo-GGUF", "model-q8_0.gguf")))


class ResumableDownloadTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="audiocpp_webui_download_resume_test_")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.output = Path(self.root) / "model.gguf"
        self.original_urlopen = mmw.urlopen
        self.original_delay = mmw.DOWNLOAD_RETRY_DELAY_SECONDS
        self.addCleanup(setattr, mmw, "urlopen", self.original_urlopen)
        self.addCleanup(setattr, mmw, "DOWNLOAD_RETRY_DELAY_SECONDS", self.original_delay)
        mmw.DOWNLOAD_RETRY_DELAY_SECONDS = 0

    def test_truncated_response_resumes_with_range(self):
        calls = []

        def fake_urlopen(request, timeout):
            calls.append((request.get_header("Range"), timeout))
            if len(calls) == 1:
                return _Response(b"abcd", {"Content-Length": "10"}, 200)
            self.assertEqual(request.get_header("Range"), "bytes=4-")
            return _Response(
                b"efghij",
                {"Content-Length": "6", "Content-Range": "bytes 4-9/10"},
                206,
            )

        mmw.urlopen = fake_urlopen

        mmw.download_file(_package(), "Demo-GGUF/model.gguf", self.output)

        self.assertEqual(self.output.read_bytes(), b"abcdefghij")
        self.assertEqual(len(calls), 2)

    def test_ignored_range_restarts_without_appending(self):
        calls = []

        def fake_urlopen(request, timeout):
            calls.append(request.get_header("Range"))
            if len(calls) == 1:
                return _Response(b"abcd", {"Content-Length": "10"}, 200)
            self.assertEqual(request.get_header("Range"), "bytes=4-")
            return _Response(b"abcdefghij", {"Content-Length": "10"}, 200)

        mmw.urlopen = fake_urlopen

        mmw.download_file(_package(), "Demo-GGUF/model.gguf", self.output)

        self.assertEqual(self.output.read_bytes(), b"abcdefghij")
        self.assertEqual(len(calls), 2)

    def test_initial_partial_response_uses_content_range_total(self):
        calls = []

        def fake_urlopen(request, timeout):
            calls.append(request.get_header("Range"))
            if len(calls) == 1:
                return _Response(
                    b"abcd",
                    {"Content-Length": "4", "Content-Range": "bytes 0-3/10"},
                    206,
                )
            self.assertEqual(request.get_header("Range"), "bytes=4-")
            return _Response(
                b"efghij",
                {"Content-Length": "6", "Content-Range": "bytes 4-9/10"},
                206,
            )

        mmw.urlopen = fake_urlopen

        mmw.download_file(_package(), "Demo-GGUF/model.gguf", self.output)

        self.assertEqual(self.output.read_bytes(), b"abcdefghij")
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
