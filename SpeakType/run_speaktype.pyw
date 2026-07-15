import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def _find_pythonw() -> Path:
    for cand in (
        ROOT / ".." / "venv" / "pythonw.exe",              # portable bundle venv
        ROOT / ".." / "venv" / "Scripts" / "pythonw.exe",  # repo dev venv
        ROOT / "Python311" / "pythonw.exe",                # legacy standalone runtime
    ):
        resolved = cand.resolve()
        if resolved.exists():
            return resolved
    raise SystemExit("pythonw.exe not found (expected ../venv or Python311)")


if __name__ == "__main__":
    target = _find_pythonw()
    if Path(sys.executable).resolve() != target:
        subprocess.Popen([str(target), str(Path(__file__).resolve())], cwd=ROOT)
        raise SystemExit(0)
    from app.main import main

    raise SystemExit(main())
