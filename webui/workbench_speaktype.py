"""Launch the existing Windows dictation client from the workbench."""
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time

import requests

try:
    from .workbench_metadata import ASR_AUTO_LANGUAGE, ASR_HIDDEN_LANGUAGE
except ImportError:
    from workbench_metadata import ASR_AUTO_LANGUAGE, ASR_HIDDEN_LANGUAGE


def language_contract(entry, spec):
    """Only offer language conditioning the model's request contract supports."""
    option = next((p for p in spec.get("options", {}).get("request", []) if p["name"] == "language"), None)
    supported = spec.get("languages", [])
    if option is None or entry["family"] in ASR_HIDDEN_LANGUAGE:
        return {"languages": [""], "language_default": "", "language_fixed": True,
                "supported_languages": supported}
    languages = list(dict.fromkeys(option.get("values") or supported))
    languages = [v for v in languages if isinstance(v, str) and v not in {"multilingual", "zh dialects"}
                 and "+" not in v and " " not in v]
    automatic = ASR_AUTO_LANGUAGE.get(entry["family"])
    if automatic and automatic not in languages:
        languages.insert(0, automatic)
    default = option.get("default", "")
    if default not in languages:
        default = languages[0] if languages else ""
    return {"languages": languages or [""], "language_default": default,
            "language_fixed": False, "supported_languages": supported}


class SpeakTypeLauncher:
    def __init__(self, work):
        self.work = work
        self.lock = threading.RLock()
        self.proc = None
        self.temp = None
        self.closed = False
        self.message = "尚未启动"
        self.model = None
        self.language = None
        self.ident = "speaktype"
        root = Path(getattr(work.b, "PROJECT_ROOT", Path(__file__).resolve().parents[1]))
        bundle = Path(getattr(work.b, "BUNDLE_ROOT", root))
        self.root = next((p / "SpeakType" for p in (root, bundle)
                          if (p / "SpeakType" / "run.py").is_file()), root / "SpeakType")

    def config(self):
        try:
            return json.loads((self.root / "config.json").read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as error:
            raise ValueError("无法读取 SpeakType/config.json，请检查安装文件。") from error

    def models(self):
        result = []
        for entry in self.work.b.catalog_models():
            spec = getattr(self.work.b, "MODEL_SPECS", {}).get(entry["family"], {})
            if (entry.get("task") == "asr" and entry.get("installed")
                    and self.work.b.profile_for(entry).get("supports_streaming")
                    and (not spec.get("modes") or "streaming" in spec["modes"])):
                result.append({"id": entry["id"], "label": entry.get("display_name") or entry.get("label") or entry["id"],
                               **language_contract(entry, spec)})
        return result

    def status(self):
        # Do not wait on the launch lock while a model is loading.
        config = self.config() if (self.root / "config.json").is_file() else {}
        return {"available": sys.platform == "win32" and (self.root / "run.py").is_file(),
                "active": self.ident in self.work.leases,
                "running": self.proc is not None and self.proc.poll() is None,
                "message": self.message, "model": self.model,
                "models": self.models(), "default_model": config.get("asr", {}).get("model", ""),
                "language": self.language if self.language is not None else config.get("asr", {}).get("language", ""),
                "toggle_hotkey": config.get("hotkeys", {}).get("toggle_recording", "ctrl+alt+f9"),
                "cancel_hotkey": config.get("hotkeys", {}).get("cancel_current", "esc")}

    def start(self, model, language, ui_language="zh"):
        with self.lock:
            if self.closed:
                raise RuntimeError("工作台正在退出。")
            if self.proc is not None and self.proc.poll() is None:
                return self.status()
            self._stop_locked()
            if not self.status()["available"]:
                raise ValueError("SpeakType 需要 Windows 和完整的 SpeakType 运行文件。")
            selected = next((item for item in self.models() if item["id"] == model), None)
            if selected is None:
                raise ValueError("请先在模型中心安装支持流式转写的 ASR 模型。")
            if not isinstance(language, str) or len(language) > 64:
                raise ValueError("识别语言无效。")
            if not language:
                language = selected["language_default"]
            if language not in selected["languages"]:
                raise ValueError("此模型不支持所选识别语言，请从语言下拉列表重新选择。")
            config = self.config()
            ui = config.setdefault("ui", {})
            ui["language"] = "en" if ui_language == "en" else "zh"
            if ui.get("host", "127.0.0.1") != "127.0.0.1":
                raise ValueError("SpeakType 悬浮条必须使用本机地址。")
            port = int(ui.get("port", 8765))
            try:
                with socket.socket() as probe:
                    probe.bind(("127.0.0.1", port))
            except OSError as error:
                raise RuntimeError(f"SpeakType 悬浮条端口 {port} 已被占用；请先关闭已运行的 SpeakType，或调整其配置。") from error
            self.work.lease(self.ident, {"asr_model": model})
            self.message = "正在准备识别模型…"
            self.model = model
            self.language = language
            try:
                manager = self.work.reference_asr()
                manager.load(model, mode="streaming")
                config.setdefault("asr", {}).update(base_url=manager.server_url, model=model,
                    language=language, transport="streaming",
                    stream_url=manager.server_url + "/v1/audio/transcriptions")
                config.setdefault("demo", {})["mock"] = False
                # Preserve the user's microphone gain, VAD, hotkeys and injection settings.
                self.temp = tempfile.TemporaryDirectory(prefix="audiocpp-speaktype-")
                path = Path(self.temp.name) / "config.json"
                path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
                log_dir = Path(getattr(self.work.b, "LOG_DIR", self.work.b.OUTPUT_DIR))
                log_dir.mkdir(parents=True, exist_ok=True)
                with (log_dir / "speaktype-launch.log").open("ab") as log:
                    self.proc = subprocess.Popen([sys.executable, str(self.root / "run.py"), "--config", str(path),
                        "--stop-file", str(Path(self.temp.name) / "stop")],
                        cwd=self.root, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                self.message = "正在启动悬浮条…"
                deadline = time.monotonic() + 30
                with requests.Session() as http:
                    http.trust_env = False
                    while time.monotonic() < deadline:
                        if self.proc.poll() is not None:
                            raise RuntimeError("SpeakType 启动失败，请查看 speaktype-launch.log 和 SpeakType/logs/app.log。")
                        try:
                            response = http.get(f"http://127.0.0.1:{port}/health", timeout=0.5)
                            data = response.json()
                            if data.get("pid") == self.proc.pid and data.get("ready"):
                                break
                        except (requests.RequestException, ValueError):
                            pass
                        time.sleep(0.1)
                    else:
                        raise RuntimeError("SpeakType 悬浮条启动超时，请查看启动日志。")
                self.message = "已启动，请切换到目标输入框后按快捷键听写。"
                threading.Thread(target=self._watch, args=(self.proc,), daemon=True,
                                 name="speaktype-monitor").start()
                return self.status()
            except Exception:
                self._stop_locked()
                self.message = "启动失败，请检查提示后重试。"
                raise

    def _watch(self, proc):
        proc.wait()
        with self.lock:
            if self.proc is proc:
                self._stop_locked()
                self.message = "SpeakType 已退出。"

    def _stop_locked(self):
        if self.proc is not None:
            if self.proc.poll() is None:
                if self.temp is not None:
                    (Path(self.temp.name) / "stop").touch()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.terminate()
                    try:
                        self.proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        self.proc.kill()
                        self.proc.wait(timeout=5)
            self.proc = None
        if self.temp is not None:
            self.temp.cleanup()
            self.temp = None
        self.work.lease(self.ident, None)

    def stop(self):
        with self.lock:
            self._stop_locked()
            self.message = "SpeakType 已退出，快捷键已释放。"
            return self.status()

    def close(self):
        with self.lock:
            self.closed = True
            self._stop_locked()


def install_speaktype_routes(app, work):
    from pydantic import BaseModel

    class StartRequest(BaseModel):
        model: str
        language: str = ""
        ui_language: str = "zh"

    launcher = SpeakTypeLauncher(work)
    app.state.speaktype = launcher

    @app.get("/api/workbench/speaktype")
    def status():
        return launcher.status()

    @app.post("/api/workbench/speaktype/start")
    def start(request: StartRequest):
        return launcher.start(request.model, request.language, request.ui_language)

    @app.post("/api/workbench/speaktype/stop")
    def stop():
        return launcher.stop()

    return launcher
