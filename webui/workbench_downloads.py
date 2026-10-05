"""One resumable download at a time, using the downstream model manager."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import uuid


TERMINAL = {"done", "error", "cancelled"}


def pid_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return ctypes.get_last_error() == 5
        try:
            code = wintypes.DWORD()
            return not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


class DownloadJobs:
    def __init__(self, backend):
        self.b = backend
        self.lock = threading.RLock()
        self.state_path = Path(backend.CONFIG_DIR) / "workbench_downloads.json"
        self.control_dir = Path(backend.OUTPUT_DIR) / "workbench-downloads"
        self.control_dir.mkdir(parents=True, exist_ok=True)
        self.current = None
        self.proc = None
        self.worker = None
        self.token = ""
        self.closed = False
        self.last_save = 0.0
        try:
            saved = json.loads(self.state_path.read_text(encoding="utf-8"))
            if isinstance(saved, dict) and backend.catalog_by_id(saved.get("model")):
                self.current = {k: saved.get(k) for k in (
                    "id", "model", "label", "status", "message", "bytes", "total_bytes", "route", "pid")}
                self.current.update(speed=0, eta=None)
                if self.current["status"] not in TERMINAL:
                    self.current["status"] = "pausing" if pid_alive(saved.get("pid")) else "paused"
                    self.current["message"] = "上次下载已保留，等待暂停后可继续。"
                    if self.current["status"] == "pausing":
                        self._write_control("pause")
        except (OSError, ValueError, TypeError):
            self.current = None

    def _control_path(self):
        # State is never allowed to introduce a filesystem path.
        ident = str(self.current["id"])
        if len(ident) != 32 or any(c not in "0123456789abcdef" for c in ident):
            raise ValueError("下载记录无效，请重新启动下载。")
        return self.control_dir / (ident + ".json")

    def _write_control(self, action):
        self._control_path().write_text(json.dumps({"action": action}), encoding="utf-8")

    def _save(self, force=False):
        if not self.current or (not force and time.monotonic() - self.last_save < 1):
            return
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.state_path.with_suffix(".json.tmp")
        temp.write_text(json.dumps(self.current, ensure_ascii=False), encoding="utf-8")
        temp.replace(self.state_path)
        self.last_save = time.monotonic()

    def _refresh(self):
        if (self.current and self.proc is None and self.current.get("pid")
                and self.current["status"] not in TERMINAL
                and not pid_alive(self.current["pid"])):
            self.current.update(status="paused", pid=None, message="已保留下载进度，可以继续。", speed=0, eta=None)
            self._save(True)

    def list(self):
        with self.lock:
            self._refresh()
            return [self._public()] if self.current else []

    def _public(self):
        return {k: v for k, v in self.current.items() if k != "pid"}

    def start(self, model_id, token=""):
        with self.lock:
            if self.closed:
                raise RuntimeError("下载服务正在关闭。")
            self._refresh()
            if self.current and self.current["status"] not in TERMINAL:
                if self.current["model"] != model_id:
                    raise RuntimeError("一次只能下载一个模型，请先完成或取消当前下载。")
                if self.current["status"] != "paused":
                    return self._public()
                if self.current.get("pid") and pid_alive(self.current["pid"]):
                    raise RuntimeError("上次下载正在停止，请稍后再继续。")
            entry = self.b.catalog_by_id(model_id)
            if not entry:
                raise ValueError("没有找到这个模型。")
            package_id = entry.get("download_id")
            ids = [package_id, *entry.get("additional_download_ids", [])]
            packages = [self.b.SPEC_PACKAGE_BY_ID.get(key, {}) for key in ids]
            if entry.get("manual_install") or not all(self.b._webui_can_install_package(p) for p in packages):
                raise ValueError("这个模型需要手动准备权重，请查看模型详情中的安装位置。")
            if not self.b.SPEC_MODEL_MANAGER or not Path(self.b.SPEC_MODEL_MANAGER).is_file():
                raise RuntimeError("本地模型下载器不存在，请检查安装文件。")
            if self.current and self.current["model"] == model_id and self.current["status"] == "paused":
                self.token = token or self.token
                ident = self.current["id"]
            else:
                self.token = token
                ident = uuid.uuid4().hex
            self.current = dict(id=ident, model=model_id, label=entry["label"], status="preparing",
                                message="正在自动检测下载线路…", bytes=0, total_bytes=None,
                                speed=0, eta=None, route="", pid=None)
            if entry.get("installed"):
                self.current.update(status="done", message="模型已经安装。")
                self.token = ""
                self._save(True)
                return self._public()
            self._control_path().unlink(missing_ok=True)
            command = [sys.executable, "-u", str(self.b.SPEC_MODEL_MANAGER), "install", package_id,
                       "--models-root", str(self.b.MODELS_ROOT), "--overwrite", "--control-file", str(self._control_path())]
            for extra in ids[1:]:
                command.extend(["--with-package", extra])
            env = os.environ.copy()
            env.update(PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
            if self.token:
                env.update(HF_TOKEN=self.token, HUGGING_FACE_HUB_TOKEN=self.token)
            self._save(True)
            self.worker = threading.Thread(target=self._run, args=(command, env), daemon=True, name="model-download")
            self.worker.start()
            return self._public()

    def control(self, model_id, action):
        with self.lock:
            if action not in {"pause", "cancel"}:
                raise ValueError("不支持此下载操作。")
            self._refresh()
            if not self.current or self.current["model"] != model_id:
                raise ValueError("没有这个模型的下载任务。")
            if self.current["status"] in TERMINAL:
                return self._public()
            if self.current["status"] == "paused":
                if action == "cancel":
                    self.current.update(status="cancelled", message="已取消，已下载文件保留。")
                    self.token = ""
            else:
                self._write_control(action)
                self.current.update(status="pausing", message="正在安全停止，已下载文件会保留。")
            self._save(True)
            return self._public()

    def _event(self, line):
        for prefix in ("AUDIOCPP_DOWNLOAD_EVENT ", "AUDIOCPP_DOWNLOAD_ROUTE "):
            if not line.startswith(prefix):
                continue
            try:
                event = json.loads(line[len(prefix):])
            except ValueError:
                return
            phase = event.get("phase")
            with self.lock:
                job = self.current
                if event.get("route"):
                    job["route"] = str(event["route"])[:160]
                if job["status"] == "pausing":
                    return
                if phase in {"downloading", "verifying", "installing"}:
                    job["status"] = phase
                    job["message"] = {"downloading": "当前文件：", "verifying": "正在校验：", "installing": "正在安装："}[phase] + str(event.get("file", ""))[:180]
                    if phase == "downloading":
                        now = time.monotonic()
                        size = max(0, int(event.get("bytes") or 0))
                        previous = getattr(self, "_sample", (now, size, None))
                        elapsed = now - previous[0]
                        speed = max(0, size - previous[1]) / elapsed if elapsed > 0 and previous[2] == event.get("file") else 0
                        self._sample = (now, size, event.get("file"))
                        total = event.get("total")
                        job.update(bytes=size, total_bytes=total, speed=round(speed),
                                   eta=round(max(0, total - size) / speed) if total and speed else None)
                elif phase in {"probing", "selected", "fallback", "restart"}:
                    job["message"] = {"probing": "正在检测官方、镜像和已配置代理线路…", "selected": "已选择下载线路。",
                                      "fallback": "当前线路不可用，正在自动切换…", "restart": "文件版本发生变化，重新下载当前文件。"}[phase]
                self._save()
            return

    def _run(self, command, env):
        code = None
        try:
            with self.lock:
                self.proc = subprocess.Popen(command, cwd=self.b.PROJECT_ROOT, env=env,
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                self.current["pid"] = self.proc.pid
                self._save(True)
                proc = self.proc
            try:
                for line in proc.stdout:
                    self._event(line.strip())
            finally:
                proc.stdout.close()
            code = proc.wait()
        except Exception:
            # Do not expose signed URLs or credentials from downloader exceptions.
            pass
        finally:
            with self.lock:
                action = "pause"
                try:
                    action = json.loads(self._control_path().read_text(encoding="utf-8")).get("action", "pause")
                except (OSError, ValueError):
                    pass
                if code == 0:
                    self.current.update(status="done", message="下载和安装完成，模型已可使用。")
                elif code == 75:
                    self.current.update(status="cancelled" if action == "cancel" else "paused",
                                        message="已取消，已下载文件保留。" if action == "cancel" else "已暂停，可继续下载。")
                else:
                    self.current.update(status="error", message="下载未完成。可重试；受限模型请确认 HF 授权和访问令牌。")
                self.current.update(pid=None, speed=0, eta=None)
                self.proc = None
                if self.current["status"] in TERMINAL:
                    self.token = ""
                self._save(True)

    def close(self):
        with self.lock:
            self.closed = True
            if self.current and self.current["status"] not in TERMINAL | {"paused"}:
                self._write_control("pause")
                self.current.update(status="pausing", message="正在保留下载进度。")
                self._save(True)
