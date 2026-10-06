"""A separately owned, reusable ASR runtime for reference audio and voice chat."""
from __future__ import annotations

import atexit
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
from urllib.parse import urlsplit

import requests


class ManagedASR:
    def __init__(self, backend):
        self.backend = backend
        self.server_url = os.environ.get("AUDIOCPP_ASR_SERVER", "http://127.0.0.1:8081").strip().rstrip("/")
        self.host = "127.0.0.1"
        self.port = 8081
        self.can_manage = False
        try:
            url = urlsplit(self.server_url)
            self.port = url.port or 80
            main = urlsplit(backend.SERVER)
            main_port = main.port or (443 if main.scheme == "https" else 80)
            self.can_manage = (
                url.scheme == "http" and url.hostname in {"127.0.0.1", "localhost"}
                and not (url.username or url.password or url.query or url.fragment)
                and url.path in {"", "/"}
                and not (main.hostname in {"127.0.0.1", "localhost", "::1", "0.0.0.0"}
                         and main_port == self.port)
            )
        except ValueError:
            pass
        self._lock = threading.RLock()
        self._cancel = threading.Event()
        self._closed = threading.Event()
        self._proc = None
        self._interrupted_proc = None
        self._config_path = None
        self._config_key = None
        self._model_id = None
        self._log_file = None
        self._http = requests.Session()
        self._http.trust_env = False
        self.log_path = Path(backend.LOG_DIR) / "realtime_asr.log"
        atexit.register(self.close)

    def _entries(self):
        return [entry for entry in self.backend.catalog_models()
                if entry.get("task") == "asr" and entry.get("installed")]

    def catalog(self):
        result = []
        for entry in self._entries():
            spec = getattr(self.backend, "MODEL_SPECS", {}).get(entry["family"], {})
            if spec.get("modes") and "offline" not in spec["modes"]:
                continue
            profile = self.backend.profile_for(entry)
            result.append({
                "id": entry["id"], "label": entry.get("display_name") or entry.get("label") or entry["id"],
                "family": entry["family"], "mode": "offline", "installed": True,
                "backend": entry.get("backend", self.backend.SERVER_BACKEND),
                "supports_streaming": bool(profile.get("supports_streaming")),
                "min_vram_gb": entry.get("min_vram_gb"),
            })
        return result

    def _model_config(self, entry):
        family = entry["family"]
        spec = getattr(self.backend, "MODEL_SPECS", {}).get(family, {})
        if spec.get("modes") and "offline" not in spec["modes"]:
            raise ValueError("此模型不支持实时对话需要的分段离线识别。")
        model = {"id": entry["id"], "family": family,
                 "path": self.backend._server_model_path(entry), "task": "asr", "mode": "offline"}
        for key in ("config", "weight"):
            if entry.get(key) is not None:
                model[key] = entry[key]
        defaults = self.backend.profile_for(entry).get("default_options", {})
        for scope in ("load", "session"):
            key = scope + "_options"
            options = dict(entry.get(key) or {})
            nested = defaults.get(key, {})
            if not isinstance(nested, dict):
                raise ValueError(f"{key} 必须是对象。")
            options.update(nested)
            options.update({name[len(key) + 1:]: value for name, value in defaults.items()
                            if name.startswith(key + ".")})
            contract = spec.get("options", {}).get(scope)
            if contract is not None:
                allowed = {item["name"] for item in contract}
                unknown = [name for name in options
                           if name not in allowed and name.removeprefix(family + ".") not in allowed]
                if unknown:
                    raise ValueError(f"识别模型 {scope} 参数不在模型规格中：{', '.join(unknown)}")
            if options:
                model[key] = {name: value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
                              for name, value in options.items()}
        backend = entry.get("backend", self.backend.SERVER_BACKEND)
        return {"host": self.host, "port": self.port, "backend": backend,
                "device": self.backend.DEVICE, "threads": self.backend._model_threads(backend),
                "voice_dir": self.backend.VOICE_DIR, "models": [model]}

    def _status(self):
        try:
            health = self._http.get(self.server_url + "/health", timeout=1.5)
            if health.status_code != 200:
                return False, set()
            response = self._http.get(self.server_url + "/v1/models", timeout=1.5)
            response.raise_for_status()
            ids = {item["id"] for item in response.json().get("data", [])
                   if isinstance(item, dict) and item.get("id") and item.get("loaded", True)}
            return True, ids
        except (requests.RequestException, ValueError, TypeError, AttributeError):
            return False, set()

    def _port_open(self):
        try:
            with socket.create_connection((self.host, self.port), timeout=0.4):
                return True
        except OSError:
            return False

    def load(self, model_id, mode="offline"):
        if not self.can_manage:
            raise ValueError("自动识别服务只支持独立的本机 HTTP 根地址；不能使用主声音服务端口。")
        if mode != "offline":
            raise ValueError("实时对话的识别服务使用分段离线模式。")
        with self._lock:
            if self._closed.is_set():
                raise RuntimeError("识别服务正在退出，不能再加载模型。")
            self._cancel.clear()
            owned_alive = self._proc is not None and self._proc.poll() is None
            if not owned_alive:
                self._close_locked()
                healthy, ids = self._status()
                if healthy and model_id in ids:
                    self._model_id = model_id
                    return f"已复用识别服务：{model_id}"
                if healthy or self._port_open():
                    raise RuntimeError(f"识别端口 {self.port} 已被其他服务占用，且未提供所选模型。请调整识别服务地址。")
            entry = next((item for item in self._entries() if item["id"] == model_id), None)
            if entry is None:
                raise ValueError("识别模型未安装或文件不完整，请先到模型中心安装。")
            config = self._model_config(entry)
            config_key = json.dumps(config, ensure_ascii=False, sort_keys=True)
            if owned_alive and self._config_key == config_key:
                healthy, ids = self._status()
                if healthy and model_id in ids:
                    return f"识别模型已就绪：{entry.get('label', model_id)}"
            if not os.path.isfile(self.backend.SERVER_EXE):
                raise FileNotFoundError("找不到语音识别服务程序，请检查应用运行文件。")
            self._close_locked()
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            fd, self._config_path = tempfile.mkstemp(prefix="audiocpp_realtime_asr_", suffix=".json")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(config, handle, ensure_ascii=False)
                self._log_file = self.log_path.open("ab")
                command = [self.backend.SERVER_EXE, "--config", self._config_path,
                           "--no-ui", "--host", self.host, "--port", str(self.port)]
                if self._closed.is_set() or self._cancel.is_set():
                    raise RuntimeError("识别服务正在退出，不能再加载模型。")
                self._proc = subprocess.Popen(
                    command, cwd=self.backend.BUNDLE_ROOT, stdin=subprocess.DEVNULL,
                    stdout=self._log_file, stderr=subprocess.STDOUT)
                self._config_key = config_key
                deadline = time.monotonic() + self.backend.LOAD_TIMEOUT
                while time.monotonic() < deadline and not self._cancel.is_set():
                    if self._proc.poll() is not None:
                        raise RuntimeError("识别服务启动失败，请查看 realtime_asr.log。")
                    healthy, ids = self._status()
                    if healthy and model_id in ids and self._proc.poll() is None:
                        self._model_id = model_id
                        return f"识别模型已就绪：{entry.get('label', model_id)}"
                    self._cancel.wait(0.25)
                raise RuntimeError("识别模型加载已取消或超时，请查看 realtime_asr.log。")
            except BaseException:
                self._close_locked()
                raise

    def status(self):
        proc = self._proc
        alive = proc is not None and proc.poll() is None
        return {"model": self._model_id if alive or proc is None else None,
                "managed": alive}

    def transcribe(self, model_id, audio_path, cancel=None):
        """Keep the loaded model after recognition; never change the main server."""
        with self._lock:
            def check_cancelled():
                if self._cancel.is_set() or (cancel is not None and cancel.is_set()):
                    raise RuntimeError("参考文本识别已取消。")

            if cancel is not None and cancel.is_set():
                raise RuntimeError("参考文本识别已取消。")
            self.load(model_id)
            check_cancelled()
            entry = next(item for item in self._entries() if item["id"] == model_id)
            profile = self.backend.profile_for(entry)
            wav = self.backend._prepare_asr_input(audio_path, profile)
            duration = self.backend._audio_duration_seconds(wav)
            limit = profile.get("max_input_seconds")
            chunks = [wav]
            if limit and duration is not None and duration > limit:
                chunks = [path for path, _ in self.backend._split_wav_chunks(wav, limit, pad_to_max=False)]
            options = self.backend._merged_options(profile, None, "")
            texts = []
            for chunk in chunks:
                check_cancelled()
                payload = {"model": model_id, "audio": chunk}
                if options:
                    payload["options"] = options
                try:
                    response = self._http.post(self.server_url + "/v1/audio/transcriptions",
                                               json=payload, timeout=900)
                    check_cancelled()
                    if response.status_code != 200:
                        raise self.backend.server_error(entry, response.status_code, response.text)
                    data = response.json()
                    if not isinstance(data, dict) or not isinstance(data.get("text"), str):
                        raise ValueError("识别服务未返回有效文本，请检查服务版本。")
                    texts.append(data["text"].strip())
                except requests.RequestException as error:
                    check_cancelled()
                    raise RuntimeError("无法连接参考音频识别服务，请重新识别。") from error
            return "\n".join(text for text in texts if text)

    def cancel(self):
        """Interrupt our own request without waiting for the transcription lock."""
        self._cancel.set()
        proc = self._proc
        if proc is not None and proc.poll() is None and proc is not self._interrupted_proc:
            self._interrupted_proc = proc
            proc.terminate()

    def unload(self):
        """Release owned model memory; a later recognition can load it again."""
        self.cancel()
        with self._lock:
            self._close_locked()

    def _close_locked(self):
        if self._proc is not None:
            if self._proc.poll() is None:
                if self._proc is not self._interrupted_proc:
                    self._proc.terminate()
                try:
                    self._proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self._proc.kill()
                    self._proc.wait(timeout=5)
            self._proc = None
        self._interrupted_proc = None
        if self._log_file is not None:
            self._log_file.close()
            self._log_file = None
        if self._config_path is not None:
            Path(self._config_path).unlink(missing_ok=True)
            self._config_path = None
        self._config_key = None
        self._model_id = None

    def close(self):
        """Stop only the process created by this instance, never a port owner."""
        self._closed.set()
        self.cancel()
        with self._lock:
            self._close_locked()
            self._http.close()
