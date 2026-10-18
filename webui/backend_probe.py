"""Dependency-free backend selection shared by the Windows launchers and WebUI."""
import argparse
import os
import re
import subprocess
from functools import lru_cache


@lru_cache(maxsize=8)
def probe_devices(executable):
    """Ask the actual build/driver which GPUs it can enumerate; never load a model."""
    if not executable or not os.path.isfile(executable):
        return ()
    try:
        result = subprocess.run(
            [executable, "--list-devices"], capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if result.returncode:
            return ()
        return tuple(re.findall(
            r'^([A-Za-z]+):(\d+) "(.*)" \[(?:I?GPU)\]$',
            result.stdout, re.MULTILINE,
        ))
    except (OSError, subprocess.SubprocessError):
        return ()


def cuda_arch_supported():
    """The portable CUDA build targets compute capability 7.5 and newer."""
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=compute_cap", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        # The application uses device 0 by default, so don't select on another card.
        return result.returncode == 0 and float(result.stdout.splitlines()[0]) >= 7.5
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return False


def select_backend(cuda_exe, vulkan_exe):
    if cuda_arch_supported() and any(d[0].lower() == "cuda" for d in probe_devices(cuda_exe)):
        return "cuda"
    if any(d[0].lower() == "vulkan" for d in probe_devices(vulkan_exe)):
        return "vulkan"
    return "cpu"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cuda", default="")
    parser.add_argument("--vulkan", default="")
    args = parser.parse_args()
    print(select_backend(args.cuda, args.vulkan))
