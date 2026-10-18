"""Windows launcher and local-instance identity for the workbench.

No model is loaded here. The operating-system file lock survives slow imports,
and is released automatically when this Python process exits.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import socket
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
import webbrowser

WEBUI_DIR = Path(__file__).resolve().parent
APPLICATION = "audio.cpp.workbench"
INSTALL_ID = hashlib.sha256(os.path.normcase(str(WEBUI_DIR)).encode("utf-8")).hexdigest()[:20]
LOG_DIR = WEBUI_DIR / "logs"
STARTUP_LOG = LOG_DIR / "startup.log"


def runtime_revision():
    """Identify Python code loaded into a service, separately from live UI assets."""
    digest = hashlib.sha256()
    for name in ("webui.py", "workbench_launcher.py", "workbench_server.py", "workbench_metadata.py",
                 "workbench_references.py", "workbench_asr.py", "workbench_downloads.py",
                 "workbench_scenarios.py", "scenario_media.py", "workbench_speaktype.py",
                 "realtime_server.py", "realtime_pipeline.py"):
        path = WEBUI_DIR / name
        digest.update(name.encode("utf-8") + b"\0")
        digest.update(path.read_bytes() if path.is_file() else b"missing")
    return digest.hexdigest()


def instance_idle(port):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(f"http://127.0.0.1:{port}/api/workbench/status", timeout=3) as response:
        status = json.loads(response.read(16384))
    return (isinstance(status, dict) and status.get("busy") is False
            and status.get("realtime_active") is False)


def ui_port():
    port = int(os.environ.get("AUDIOCPP_UI_PORT", "7860"))
    if not 1 <= port <= 65535:
        raise ValueError("AUDIOCPP_UI_PORT must be between 1 and 65535.")
    return port


def existing_health(port):
    # Local requests must not inherit HTTP proxy settings.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"http://127.0.0.1:{port}/api/workbench/health", timeout=1) as response:
            info = json.loads(response.read(16384))
        if (isinstance(info, dict) and info.get("application") == APPLICATION
                and info.get("install_id") == INSTALL_ID and not info.get("shutting_down")):
            return info
    except (OSError, ValueError, urllib.error.URLError):
        pass
    return None


def port_in_use(port):
    with socket.socket() as probe:
        probe.settimeout(.3)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def open_existing(port):
    print(f"[webui] Using the running workbench: http://127.0.0.1:{port}/", flush=True)
    if os.environ.get("AUDIOCPP_NO_BROWSER") != "1":
        webbrowser.open(f"http://127.0.0.1:{port}/")


def lock_instance(port):
    """Return a locked file, or None after reopening a healthy instance."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    handle = (LOG_DIR / f"workbench-{port}.lock").open("a+b")
    handle.seek(0, 2)
    if handle.tell() == 0:
        handle.write(b"0")
        handle.flush()
    deadline = time.monotonic() + 180
    revision = runtime_revision()
    while True:
        info = existing_health(port)
        if info:
            if info.get("runtime_revision") == revision:
                handle.close()
                open_existing(port)
                return None
            try:
                idle = instance_idle(port)
            except BaseException:
                handle.close()
                raise
            if not idle:
                handle.close()
                raise RuntimeError("Workbench updated. Run run_webui.bat again after the current task or voice call ends.")
            print("[webui] Workbench updated. Restarting the service...", flush=True)
            try:
                stop_instance(port)
            except BaseException:
                handle.close()
                raise
            time.sleep(.3)
            continue
        try:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return handle
        except OSError:
            if time.monotonic() >= deadline:
                handle.close()
                raise RuntimeError("Workbench is still starting or stopping. Check the startup log and try again.")
            time.sleep(.3)


class Tee:
    encoding = "utf-8"

    def __init__(self, log, console=None):
        self.log, self.console = log, console

    def write(self, value):
        self.log.write(value)
        if self.console is not None:
            self.console.write(value)
        return len(value)

    def flush(self):
        self.log.flush()
        if self.console is not None:
            self.console.flush()

    def isatty(self):
        return False


def report_failure(error, diagnostic=False):
    print(f"[webui] {error}\nStartup log: {STARTUP_LOG}\nDiagnostics: run_webui.bat --diagnostic", file=sys.stderr, flush=True)
    if os.name == "nt" and not diagnostic and os.environ.get("AUDIOCPP_NO_DIALOG") != "1":
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, f"{error}\n\nStartup log: {STARTUP_LOG}\n\nRun run_webui.bat --diagnostic for details.", "Aixora Studio startup failed", 0x10)


def stop_instance(port):
    info = existing_health(port)
    if not info or not info.get("shutdown_available"):
        raise RuntimeError("No running workbench found for this installation.")
    request = urllib.request.Request(f"http://127.0.0.1:{port}/api/workbench/shutdown",
        data=b"{}", headers={"Content-Type": "application/json", "X-Workbench-Shutdown": info["shutdown_token"]})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=5) as response:
        print(response.read(16384).decode("utf-8"), flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Aixora Studio launcher")
    parser.add_argument("--diagnostic", action="store_true", help="Show the console and save the startup log")
    parser.add_argument("--detach", action="store_true", help="Launch in a separate console window")
    parser.add_argument("--stop", action="store_true", help="Stop the workbench for this installation")
    args = parser.parse_args(argv)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    if args.detach and not args.diagnostic and not args.stop:
        # Use the interpreter selected by the existing environment scripts.
        command = [sys.executable, str(Path(__file__).resolve()), "--diagnostic"]
        if os.name == "nt":
            subprocess.Popen(command, cwd=WEBUI_DIR, creationflags=subprocess.CREATE_NEW_CONSOLE)
        else:
            with STARTUP_LOG.open("a", encoding="utf-8") as log:
                subprocess.Popen(command, cwd=WEBUI_DIR, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=log, start_new_session=True)
        return 0

    # Keep the stream open through atexit so backend cleanup cannot lose stderr.
    log = STARTUP_LOG.open("a", encoding="utf-8", buffering=1)
    sys.stdout = Tee(log, sys.stdout if args.diagnostic else None)
    sys.stderr = Tee(log, sys.stderr if args.diagnostic else None)
    lock = None
    try:
        print(f"\n[webui] {time.strftime('%Y-%m-%d %H:%M:%S')} Python: {sys.executable}", flush=True)
        port = ui_port()
        if args.stop:
            stop_instance(port)
            return 0
        if os.environ.get("AUDIOCPP_WEBUI_LEGACY") != "1":
            lock = lock_instance(port)
            if lock is None:
                return 0
            if port_in_use(port):
                raise RuntimeError(f"Port {port} is in use. Set AUDIOCPP_UI_PORT to another port and try again.")
        sys.path.insert(0, str(WEBUI_DIR))
        runpy.run_path(str(WEBUI_DIR / "webui.py"), run_name="__main__")
        return 0
    except SystemExit as error:
        if error.code in (None, 0):
            return 0
        traceback.print_exc()
        report_failure(f"Workbench startup exited with code {error.code}.", args.diagnostic)
        return 1
    except Exception as error:
        traceback.print_exc()
        report_failure(error, args.diagnostic)
        return 1
    finally:
        if lock is not None:
            lock.close()


if __name__ == "__main__":
    raise SystemExit(main())
