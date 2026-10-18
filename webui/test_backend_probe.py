import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

try:
    from webui import backend_probe as probe
except ImportError:
    import backend_probe as probe


class BackendProbeTests(unittest.TestCase):
    def setUp(self):
        probe.probe_devices.cache_clear()
        self.addCleanup(probe.probe_devices.cache_clear)

    def test_dedicated_and_integrated_vulkan_devices_are_recognized(self):
        with tempfile.TemporaryDirectory() as root:
            exe = Path(root) / "server.exe"
            exe.touch()
            result = subprocess.CompletedProcess([], 0, 'available_devices=3\nVulkan:0 "AMD Radeon" [GPU]\nVulkan:1 "Intel Graphics" [IGPU]\nCPU:0 "Host" [CPU]\n')
            with patch.object(probe.subprocess, "run", return_value=result):
                self.assertEqual(probe.probe_devices(str(exe)), (("Vulkan", "0", "AMD Radeon"), ("Vulkan", "1", "Intel Graphics")))

    def test_missing_driver_crash_and_timeout_do_not_break_startup(self):
        with tempfile.TemporaryDirectory() as root:
            exe = Path(root) / "server.exe"
            exe.touch()
            for failure in (OSError("missing DLL"), subprocess.TimeoutExpired("server", 15)):
                with self.subTest(failure=failure), patch.object(probe.subprocess, "run", side_effect=failure):
                    probe.probe_devices.cache_clear()
                    self.assertEqual(probe.probe_devices(str(exe)), ())
            with patch.object(probe.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, 'Vulkan:0 "Broken" [GPU]\n')):
                probe.probe_devices.cache_clear()
                self.assertEqual(probe.probe_devices(str(exe)), ())

    def test_cuda_then_vulkan_then_cpu_and_old_cuda_fallback(self):
        devices = {"cuda": (("CUDA", "0", "NVIDIA"),), "vk": (("Vulkan", "0", "GPU"),)}
        with patch.object(probe, "probe_devices", side_effect=lambda exe: devices.get(exe, ())), patch.object(probe, "cuda_arch_supported", return_value=True):
            self.assertEqual(probe.select_backend("cuda", "vk"), "cuda")
            self.assertEqual(probe.select_backend("missing", "vk"), "vulkan")
            self.assertEqual(probe.select_backend("missing", "missing"), "cpu")
        with patch.object(probe, "probe_devices", side_effect=lambda exe: devices.get(exe, ())), patch.object(probe, "cuda_arch_supported", return_value=False):
            self.assertEqual(probe.select_backend("cuda", "vk"), "vulkan")

    def test_cuda_default_device_architecture_is_checked(self):
        for output, expected in (("8.9\n", True), ("6.1\n8.9\n", False), ("12.0\n", True), ("N/A\n", False)):
            with self.subTest(output=output), patch.object(probe.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, output)):
                self.assertEqual(probe.cuda_arch_supported(), expected)


if __name__ == "__main__":
    unittest.main()
