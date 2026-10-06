"""Local workbench HTTP adapter. Reuses the established model/task implementations."""
from __future__ import annotations

import base64
import contextlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import threading
import time
import uuid
import webbrowser

from fastapi import FastAPI, HTTPException, Request, UploadFile, File, BackgroundTasks
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

try:
    from .workbench_metadata import TASKS, public_model, model_detail, task_for
    from .workbench_references import ReferenceLibrary
    from .workbench_launcher import APPLICATION, INSTALL_ID, LOG_DIR, existing_health, open_existing, port_in_use, ui_port, runtime_revision
except ImportError:
    from workbench_metadata import TASKS, public_model, model_detail, task_for
    from workbench_references import ReferenceLibrary
    from workbench_launcher import APPLICATION, INSTALL_ID, LOG_DIR, existing_health, open_existing, port_in_use, ui_port, runtime_revision

PREFIX = "/api/workbench"
AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".opus", ".m4a", ".aac", ".webm", ".mp4", ".aiff", ".aif", ".wma"}
UPLOAD_EXTENSIONS = AUDIO_EXTENSIONS | {".gguf", ".onnx", ".index", ".pth", ".pt"}


class JobRequest(BaseModel):
    task: str
    model: str
    inputs: dict = Field(default_factory=dict)
    options: dict = Field(default_factory=dict)


class DownloadRequest(BaseModel):
    token: str = ""


class LoadRequest(BaseModel):
    options: dict = Field(default_factory=dict)


class ReferenceAudioRequest(BaseModel):
    audio: str = ""
    source: str = ""


class ReferenceSaveRequest(ReferenceAudioRequest):
    name: str
    text: str = ""
    overwrite: bool = False


def clean_message(value):
    # Existing task functions return Gradio-style status strings, not HTML.
    return str(value or "").replace("✅", "").replace("❌", "").replace("⏳", "").strip()


class Workbench:
    def __init__(self, backend):
        self.b = backend
        self.lock = threading.RLock()
        self.jobs = {}
        self.active_job = None
        self.leases = {}
        self.local = threading.local()
        self.uploads = {}
        self.artifacts = {}
        self.asr = None
        self.external_model = None
        self.inputs_dir = Path(backend.OUTPUT_DIR) / "workbench-inputs"
        self.inputs_dir.mkdir(parents=True, exist_ok=True)

    def entry(self, model):
        entry = self.b.catalog_by_id(model)
        if entry is None:
            raise HTTPException(404, "没有找到该模型，请刷新模型列表。")
        return entry

    def reserve(self, ident):
        with self.lock:
            if self.leases:
                raise HTTPException(409, "实时聊天正在使用模型，请结束通话后再运行其他任务。")
            if self.active_job:
                raise HTTPException(409, "已有任务正在执行，请等待完成或先停止任务。")
            self.active_job = ident
            self.local.operation = ident

    def release(self, ident):
        with self.lock:
            if self.active_job == ident:
                self.active_job = None

    def before_load(self, model):
        with self.lock:
            ident = getattr(self.local, "operation", None)
            job = self.jobs.get(ident)
            if job and job["cancel"].is_set():
                raise RuntimeError("任务已取消。")
            if self.active_job and ident != self.active_job:
                raise RuntimeError("已有工作台任务正在执行。")
            if self.leases and any(cfg.get("tts_server_source") == "managed" and cfg.get("tts_model") != model
                                   for cfg in self.leases.values()):
                raise RuntimeError("实时聊天正在使用模型，请先结束通话。")
            # Keep the resident recognizer for small/CPU tasks. Larger or unknown
            # GPU budgets need the memory; voice chat explicitly leases both.
            if self.asr and not self.leases:
                resident = self.asr.status().get("model")
                if resident and not self.models_fit_together(self.b.catalog_by_id(model), self.b.catalog_by_id(resident)):
                    self.asr.unload()

    def models_fit_together(self, *entries):
        if any(entry is None for entry in entries):
            return False
        if any(entry.get("backend", self.b.SERVER_BACKEND) == "cpu" for entry in entries):
            return True
        sizes = [entry.get("min_vram_gb") for entry in entries]
        capacity = self.b.LOCAL_VRAM_GB
        return bool(capacity and all(size is not None for size in sizes) and sum(sizes) + .5 <= capacity)

    def reference_asr(self):
        if self.asr is None:
            try:
                from .workbench_asr import ManagedASR
            except ImportError:
                from workbench_asr import ManagedASR
            self.asr = ManagedASR(self.b)
        return self.asr

    def prepare_reference_memory(self, model):
        """Release an idle main GPU model if the catalog's combined budget won't fit."""
        b = self.b
        proc = getattr(b, "_server_proc", None)
        current = b.catalog_by_id(getattr(b, "_loaded_id", None))
        target = self.entry(model)
        if proc is None or proc.poll() is not None or not current:
            return False
        if not self.models_fit_together(current, target):
            b.unload_model()
            return True
        return False

    def lease(self, ident, config):
        with self.lock:
            if config is None:
                self.leases.pop(ident, None)
                return
            if self.active_job:
                raise RuntimeError("工作台任务正在使用模型，请稍后再开始通话。")
            if any(key != ident for key in self.leases):
                raise RuntimeError("已有实时会话，请先结束另一个通话。")
            self.leases[ident] = {key: config.get(key) for key in (
                "tts_model", "tts_server_source", "tts_streaming", "asr_model")}

    def status(self):
        with self.lock:
            busy, realtime = self.active_job, bool(self.leases)
        proc = getattr(self.b, "_server_proc", None)
        managed = proc is not None and proc.poll() is None
        model = getattr(self.b, "_loaded_id", None) if proc is None or managed else None
        if not managed and callable(getattr(self.b, "loaded_ids", None)):
            available = self.b.loaded_ids()
            model = next((ident for ident in (self.external_model, model) if ident in available), None)
            if model is None:
                model = next(iter(sorted(available)), None)
        return {"server": {"text": clean_message(self.b.server_status()),
                           "model": model,
                           "configuration": {
                               "managed": managed,
                               "load_options": dict(getattr(self.b, "_loaded_load_options", None) or {}) if managed else {},
                               "session_options": dict(getattr(self.b, "_loaded_session_options", None) or {}) if managed else {},
                               "mode": getattr(self.b, "_loaded_mode", None) if managed else None}},
                "hardware": {"vram_gb": self.b.LOCAL_VRAM_GB, "backend": self.b.SERVER_BACKEND},
                "asr": self.asr.status() if self.asr and callable(getattr(self.asr, "status", None)) else {"model": None, "managed": False},
                "busy": bool(busy), "job": busy, "realtime_active": realtime}

    def catalog(self):
        entries = [public_model(self.b, e) for e in self.b.catalog_models() if task_for(e)]
        entries.sort(key=lambda e: (not e["installed"], e.get("min_vram_gb") or 999, e["label"]))
        return {"version": self.b.APP_VERSION, "models": entries,
                "tasks": [{"id": key, "label": value[0], "types": list(value[1])} for key, value in TASKS.items()], **self.status()}

    def input_path(self, ident, *, audio=True):
        if not ident:
            return None
        path = self.uploads.get(str(ident))
        if path is None or not path.is_file():
            raise HTTPException(400, "输入文件已失效，请重新上传。")
        if audio and path.suffix.lower() not in AUDIO_EXTENSIONS:
            raise HTTPException(400, "请选择音频文件。")
        return str(path)

    def artifact(self, path, name=None):
        if not path or not isinstance(path, (str, os.PathLike)):
            return None
        path = Path(path).resolve()
        root = Path(self.b.OUTPUT_DIR).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            return None
        ident = uuid.uuid4().hex
        self.artifacts[ident] = path
        kind = "audio" if path.suffix.lower() in AUDIO_EXTENSIONS else "file"
        return {"name": name or path.name, "url": f"{PREFIX}/files/{ident}", "kind": kind}

    def add_artifacts(self, job, paths):
        seen = set()
        result = []
        for path in paths:
            if not path or str(path) in seen:
                continue
            seen.add(str(path))
            item = self.artifact(path)
            if item:
                result.append(item)
        job["artifacts"] = result

    def submit(self, request, *, reference_audio=None):
        entry = self.entry(request.model)
        if request.task not in TASKS or task_for(entry) != request.task:
            raise HTTPException(400, "这个模型不支持当前任务，请重新选择。")
        if not entry.get("installed"):
            raise HTTPException(400, "模型尚未准备好，请先在模型中心完成下载。")
        ident = uuid.uuid4().hex
        self.reserve(ident)
        job = {"id": ident, "task": request.task, "model": request.model,
               "status": "queued", "message": "正在准备模型…", "text": "",
               "artifacts": [], "audio_segments": [], "started": time.monotonic(), "cancel": threading.Event()}
        if reference_audio:
            job["reference_audio"] = reference_audio
        self.jobs[ident] = job
        threading.Thread(target=self._run, args=(job, request), daemon=True, name="workbench-job").start()
        return {"id": ident}

    def job(self, ident, after=0):
        value = self.jobs.get(ident)
        if value is None:
            raise HTTPException(404, "任务不存在或服务已重新启动。")
        return {key: val for key, val in value.items() if key not in {"cancel", "started", "audio_segments", "reference_audio"}} | {
            "audio_segments": [part for part in value["audio_segments"] if part["index"] > after],
            "elapsed": round(value.get("elapsed", time.monotonic() - value["started"]), 1)}

    def cancel(self, ident):
        # Keep the ownership check and process stop atomic with release/reserve:
        # a late cancellation must never terminate the next task's server.
        with self.lock:
            job = self.jobs.get(ident)
            if job is None:
                raise HTTPException(404, "任务不存在。")
            if job["status"] in {"done", "error", "cancelled"} or self.active_job != ident:
                return self.job(ident)
            job["cancel"].set()
            job["message"] = "正在停止任务…"
            if job.get("reference_audio"):
                self.reference_asr().cancel()
                return self.job(ident)
            # Stop only the process owned by this WebUI; never kill a foreign server.
            proc = getattr(self.b, "_server_proc", None)
            if proc is not None and proc.poll() is None:
                proc.terminate()
            else:
                job["message"] = "已请求取消，正在等待外部推理服务返回。"
            return self.job(ident)

    def _run(self, job, req):
        b, values, opts = self.b, req.inputs, dict(req.options)
        self.local.operation = job["id"]
        job["status"] = "running"
        paths, final_message, outcome = [], "", "error"
        try:
            if job["cancel"].is_set():
                return
            model = req.model
            audio = job.get("reference_audio") or self.input_path(values.get("audio"))
            voice = self.input_path(values.get("voice"))
            builtin = values.get("builtin_voice") or "(none)"
            if builtin != "(none)" and builtin not in b.builtin_voices():
                raise ValueError("参考音色不存在，请重新选择。")
            ref_text = str(values.get("reference_text") or "")
            if not ref_text and builtin != "(none)":
                _, ref_text = b.on_builtin_voice_change(builtin)
            seed = values.get("seed")
            seed = 1234 if seed in (None, "") else int(seed)
            max_tokens = values.get("max_tokens")
            max_tokens = 1200 if max_tokens in (None, "") else int(max_tokens)
            text, language = str(values.get("text") or ""), str(values.get("language") or "")
            if req.task == "tts":
                if values.get("stream"):
                    for pcm, path, message in b.do_tts_stream(
                            model, text, language, voice, builtin, ref_text, seed, max_tokens, opts, ""):
                        job["message"] = clean_message(message)
                        if pcm is not None:
                            sample_rate, samples = pcm
                            job["audio_segments"].append({"index": len(job["audio_segments"]) + 1,
                                "sample_rate": int(sample_rate),
                                "pcm": base64.b64encode(samples.astype("<i2").tobytes()).decode("ascii")})
                        if path:
                            paths.append(path)
                        final_message = message
                        if job["cancel"].is_set():
                            break
                else:
                    path, final_message = b.do_tts(model, text, language, voice, builtin,
                                                 ref_text, seed, max_tokens, opts, "")
                    paths.append(path)
            elif req.task == "asr":
                if job.get("reference_audio"):
                    freed = self.prepare_reference_memory(model)
                    job["message"] = "正在使用 Qwen3-ASR 0.6B 识别参考文本…"
                    job["text"] = self.reference_asr().transcribe(model, audio, job["cancel"])
                    final_message = "✅ 参考文本识别完成，Qwen3-ASR 保持驻留。"
                    if freed:
                        final_message += " 已释放当前模型内存，运行任务时会自动重新加载。"
                else:
                    for transcript, message, _details, path in b.do_asr_with_details(
                            model, audio, language, str(values.get("context") or ""),
                            bool(values.get("dialogue")), bool(values.get("stream")), opts, "",
                            bool(values.get("detailed"))):
                        job.update(text=transcript, message=clean_message(message))
                        final_message = message
                        if path:
                            paths.append(path)
                        if job["cancel"].is_set():
                            break
                if job["text"]:
                    out = Path(b.OUTPUT_DIR) / f"transcript_{job['id']}.txt"
                    out.write_text(job["text"], encoding="utf-8")
                    paths.append(str(out))
            elif req.task == "music":
                path, files, final_message = b.do_music_gen_with_files(
                    model, text, str(values.get("lyrics") or ""), audio,
                    values.get("duration") or 0, seed, opts, "")
                paths.extend([path, *(files or [])])
            elif req.task in {"vc", "processing"}:
                path, final_message = b.do_vc(model, audio, voice, builtin,
                    self.input_path(values.get("rvc_voice_model"), audio=False),
                    self.input_path(values.get("rvc_retrieval_index"), audio=False), seed, opts, "")
                paths.append(path)
            elif req.task == "separation":
                result = b.do_sep(model, audio, text, opts, "")
                paths.extend(result[-2] or [])
                final_message = result[-1]
            elif req.task == "analysis":
                result_text, raw_json, files, final_message = b.do_analyze_with_files(
                    model, audio, str(values.get("transcript") or ""), language, opts, "")
                job["text"] = result_text
                paths.extend([raw_json, *(files or [])])
            elif req.task == "design":
                path, final_message = b.do_vdes(model, text, str(values.get("instruct") or ""),
                                               seed, max_tokens, opts, "")
                paths.append(path)
            self.add_artifacts(job, paths)
            failed = "❌" in str(final_message) or not (paths or job["text"] or "✅" in str(final_message))
            if paths and not job["artifacts"] and not job["text"]:
                failed = True
            outcome = "error" if failed else "done"
            job.update(message=clean_message(final_message))
        except Exception as exc:
            job.update(message=clean_message(getattr(exc, "detail", None) or str(exc)))
        finally:
            if job["cancel"].is_set():
                job.update(status="cancelled", message="任务已停止。", artifacts=[], audio_segments=[])
            else:
                job["status"] = outcome
            job["elapsed"] = time.monotonic() - job["started"]
            self.release(job["id"])


def api_documentation(backend):
    base = backend.SERVER.rstrip("/")
    model = getattr(backend, "_loaded_id", None) or "YOUR_MODEL_ID"
    definitions = [
        ("可用模型", "GET", "/v1/models", "查看当前推理服务已加载的模型。", None),
        ("生成语音", "POST", "/v1/audio/speech", "支持语音合成的模型返回 WAV；声音设计使用 instructions。",
         {"model": model, "input": "你好，欢迎使用 audio.cpp。"}),
        ("音频转文字", "POST", "/v1/audio/transcriptions", "audio 为推理服务器可访问的本机文件路径。",
         {"model": model, "audio": "D:/audio/input.wav"}),
        ("其他音频任务", "POST", "/v1/tasks/run", "模型须支持所选任务；结果可能包括音轨、JSON 或乐谱文件。",
         {"model": model, "request": {"audio": "D:/audio/input.wav"}}),
    ]
    endpoints = []
    for title, method, path, description, payload in definitions:
        body = json.dumps(payload, ensure_ascii=False, indent=2) if payload else ""
        if payload:
            python = f"import requests\n\npayload = {body}\nr = requests.post({base + path!r}, json=payload, timeout=900)\nr.raise_for_status()\n"
            python += "open('output.wav', 'wb').write(r.content)" if path.endswith("speech") else "print(r.json())"
            curl = f"# 将以下 JSON 保存为 request.json\n{body}\n\ncurl.exe -X POST {base + path} -H \"Content-Type: application/json\" --data-binary @request.json"
            if path.endswith("speech"):
                curl += " --output output.wav"
        else:
            python = f"import requests\nr = requests.get({base + path!r})\nr.raise_for_status()\nprint(r.json())"
            curl = f"curl.exe {base + path}"
        endpoints.append(dict(title=title, path=path, method=method, description=description,
                              example_python=python, example_curl=curl))
    return {"base_url": base, "model": model, "endpoints": endpoints,
            "realtime": {"path": "/api/realtime/v1/realtime", "protocol": "WebSocket PCM16 16 kHz mono"}}


def create_workbench_app(backend, *, realtime=True, download_manager=None, asr_manager=None):
    work = Workbench(backend)
    references = ReferenceLibrary(backend)
    if download_manager is None:
        try:
            from .workbench_downloads import DownloadJobs
        except ImportError:
            from workbench_downloads import DownloadJobs
        download_manager = DownloadJobs(backend)
    if realtime:
        try:
            from .realtime_server import create_app
            from .workbench_asr import ManagedASR
        except ImportError:
            from realtime_server import create_app
            from workbench_asr import ManagedASR
        asr_manager = asr_manager or ManagedASR(backend)
        app = create_app(model_catalog_provider=backend.realtime_tts_models,
                         managed_tts_loader=backend.load_realtime_tts_model,
                         api_prefix="/api/realtime", lease_callback=work.lease,
                         asr_catalog_provider=asr_manager.catalog,
                         managed_asr_loader=asr_manager.load if asr_manager.can_manage else None)
    else:
        app = FastAPI(title="audio.cpp Workbench")
    work.asr = asr_manager
    app.state.workbench = work
    app.state.downloads = download_manager
    app.state.instance_id = uuid.uuid4().hex
    app.state.runtime_revision = runtime_revision()
    app.state.shutdown_token = secrets.token_urlsafe(32)
    app.state.shutdown_callback = None
    app.state.shutting_down = False
    backend._workbench_runtime_guard = work.before_load

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        try:
            yield
        finally:
            app.state.shutting_down = True
            with work.lock:
                for job in work.jobs.values():
                    if job["status"] not in {"done", "error", "cancelled"}:
                        job["cancel"].set()
            # Only owned Popen handles: external ASR/LLM/model services stay up.
            try:
                download_manager.close()
                downloading = getattr(download_manager, "proc", None)
                if downloading is not None and downloading.poll() is None:
                    try:
                        downloading.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        downloading.terminate()
                        try:
                            downloading.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            downloading.kill()
                            downloading.wait(timeout=5)
            finally:
                try:
                    if work.asr:
                        work.asr.close()
                finally:
                    stop = getattr(backend, "_shutdown_server", None) or getattr(backend, "_stop_server", None)
                    if callable(stop):
                        stop()
    app.router.lifespan_context = lifespan

    @app.middleware("http")
    async def local_requests(request, call_next):
        host = request.url.hostname
        if host not in {"127.0.0.1", "localhost", "::1", "testserver"}:
            return JSONResponse({"detail": "仅允许本机访问。"}, status_code=403)
        origin = request.headers.get("origin")
        if origin and origin != f"{request.url.scheme}://{request.url.netloc}":
            return JSONResponse({"detail": "不允许跨站访问本地工作台。"}, status_code=403)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        if request.url.path.startswith(PREFIX):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(ValueError)
    async def value_error(_request, error):
        return JSONResponse({"detail": str(error)}, status_code=400)

    @app.exception_handler(RuntimeError)
    async def runtime_error(_request, error):
        return JSONResponse({"detail": str(error)}, status_code=409)

    @app.get(PREFIX + "/health")
    def health():
        return {"application": APPLICATION, "install_id": INSTALL_ID,
                "runtime_revision": app.state.runtime_revision,
                "instance_id": app.state.instance_id, "pid": os.getpid(),
                "shutting_down": app.state.shutting_down,
                "shutdown_available": callable(app.state.shutdown_callback),
                "shutdown_token": app.state.shutdown_token}

    @app.get(PREFIX + "/logs")
    def logs():
        records = []
        for name in ("startup.log", "audiocpp_server_webui.log", "realtime_asr.log"):
            path = LOG_DIR / name
            text, truncated = "", False
            if path.is_file():
                with path.open("rb") as handle:
                    size = handle.seek(0, 2)
                    truncated = size > 65536
                    handle.seek(max(0, size - 65536))
                    text = handle.read(65536).decode("utf-8", errors="replace")
            # Logs are useful for local diagnostics without echoing credentials.
            text = re.sub(r"(?i)(authorization\s*[:=]\s*)(?:bearer\s+)?[^\r\n,}]+", r"\1[redacted]", text)
            text = re.sub(r"(?i)((?:api[_-]?key|access[_-]?token|hf[_-]?token|token|auth|password)[\"']?\s*[:=]\s*[\"']?)[^\s\"',}]+", r"\1[redacted]", text)
            text = re.sub(r"\b(?:sk-[A-Za-z0-9_-]{12,}|hf_[A-Za-z0-9]{12,})\b", "[redacted]", text)
            records.append({"name": name, "text": text, "truncated": truncated})
        return {"logs": records, "directory": str(LOG_DIR)}

    @app.post(PREFIX + "/shutdown")
    def shutdown(request: Request, background_tasks: BackgroundTasks):
        if not secrets.compare_digest(request.headers.get("X-Workbench-Shutdown", ""), app.state.shutdown_token):
            raise HTTPException(403, "退出请求无效，请刷新工作台后重试。")
        callback = app.state.shutdown_callback
        if not callable(callback):
            raise HTTPException(409, "当前启动方式不支持从页面退出。")
        app.state.shutting_down = True
        background_tasks.add_task(callback)
        return {"message": "正在退出本地服务。"}

    @app.get(PREFIX + "/catalog")
    def catalog():
        return work.catalog()

    @app.get(PREFIX + "/status")
    def status():
        return work.status()

    @app.get(PREFIX + "/models/{model}")
    def detail(model: str):
        return model_detail(backend, work.entry(model))

    @app.get(PREFIX + "/voices")
    def voices():
        return {"voices": references.list()}

    @app.get(PREFIX + "/references")
    def reference_list():
        return {"voices": references.list()}

    @app.post(PREFIX + "/references")
    def reference_save(request: ReferenceSaveRequest):
        return references.save(request, work)

    @app.get(PREFIX + "/references/{name}/audio")
    def reference_audio(name: str):
        return FileResponse(references.path(name), media_type="audio/wav")

    @app.delete(PREFIX + "/references/{name}")
    def reference_delete(name: str):
        return references.delete(name)

    @app.post(PREFIX + "/reference-transcriptions")
    def reference_transcribe(request: ReferenceAudioRequest):
        audio = work.input_path(request.audio) if request.audio else str(references.path(request.source))
        entry = work.entry("qwen3-asr")
        if entry.get("family") != "qwen3_asr" or task_for(entry) != "asr":
            raise HTTPException(400, "请在模型中心准备 Qwen3-ASR 0.6B。")
        return work.submit(JobRequest(task="asr", model=entry["id"]), reference_audio=audio)

    @app.post(PREFIX + "/uploads")
    async def upload(file: UploadFile = File(...)):
        suffix = Path(file.filename or "").suffix.lower()
        if suffix not in UPLOAD_EXTENSIONS:
            raise HTTPException(400, "不支持此文件格式，请上传音频或模型要求的声音文件。")
        ident = uuid.uuid4().hex
        path = work.inputs_dir / (ident + suffix)
        size = 0
        limit = 2 * 1024 ** 3
        try:
            with path.open("wb") as handle:
                while chunk := await file.read(1024 ** 2):
                    size += len(chunk)
                    if size > limit:
                        raise HTTPException(413, "单个输入文件不能超过 2 GB。")
                    handle.write(chunk)
            if size == 0:
                raise HTTPException(400, "文件为空，请重新选择。")
        except Exception:
            path.unlink(missing_ok=True)
            raise
        finally:
            await file.close()
        work.uploads[ident] = path
        return {"id": ident, "name": Path(file.filename or path.name).name}

    @app.post(PREFIX + "/jobs")
    def submit(request: JobRequest):
        return work.submit(request)

    @app.get(PREFIX + "/jobs/{ident}")
    def job(ident: str, after: int = 0):
        return work.job(ident, after)

    @app.post(PREFIX + "/jobs/{ident}/cancel")
    def cancel(ident: str):
        return work.cancel(ident)

    @app.get(PREFIX + "/files/{ident}")
    def output(ident: str):
        path = work.artifacts.get(ident)
        if path is None or not path.is_file():
            raise HTTPException(404, "结果文件不存在。")
        return FileResponse(path, filename=path.name)

    @app.post(PREFIX + "/models/{model}/load")
    def load(model: str, request: LoadRequest):
        entry = work.entry(model)
        ident = uuid.uuid4().hex
        work.reserve(ident)
        try:
            options = dict(request.options)
            message = backend._ensure_with_options(model, TASKS[task_for(entry)][1], options)
            work.external_model = model
        except Exception as error:
            loader_error = getattr(getattr(backend, "gr", None), "Error", None)
            if loader_error is not None and isinstance(error, loader_error):
                raise HTTPException(400, clean_message(getattr(error, "message", error))) from error
            raise
        finally:
            work.release(ident)
        return {"message": clean_message(message), **work.status()}

    @app.post(PREFIX + "/unload")
    def unload():
        ident = uuid.uuid4().hex
        work.reserve(ident)
        try:
            message, _ = backend.unload_model()
            return {"message": clean_message(message), **work.status()}
        finally:
            work.release(ident)

    @app.post(PREFIX + "/unload-all")
    def unload_all():
        ident = uuid.uuid4().hex
        work.reserve(ident)
        try:
            if work.asr:
                work.asr.unload()
            backend.unload_model()
            return {"message": "已卸载工作台所有内存模型。", **work.status()}
        finally:
            work.release(ident)

    @app.get(PREFIX + "/downloads")
    def downloads():
        return {"downloads": download_manager.list()}

    @app.post(PREFIX + "/downloads/{model}")
    def download(model: str, request: DownloadRequest):
        work.entry(model)
        return download_manager.start(model, request.token)

    @app.post(PREFIX + "/downloads/{model}/{action}")
    def control(model: str, action: str):
        if action == "resume":
            return download_manager.start(model)
        if action not in {"pause", "cancel"}:
            raise HTTPException(400, "未知下载操作。")
        return download_manager.control(model, action)

    @app.get(PREFIX + "/api-docs")
    def docs():
        return api_documentation(backend)

    static = Path(__file__).parent / "workbench_static"
    app.mount("/workbench-static", StaticFiles(directory=static), name="workbench-static")

    @app.get("/")
    def index():
        return FileResponse(static / "index.html", headers={"Cache-Control": "no-cache"})

    return app


def launch_workbench(backend):
    import uvicorn
    port = ui_port()
    if existing_health(port):
        open_existing(port)
        return
    if port_in_use(port):
        raise RuntimeError(f"端口 {port} 已被其他服务占用，请设置 AUDIOCPP_UI_PORT 后重试。")
    app = create_workbench_app(backend, realtime=os.environ.get("AUDIOCPP_DISABLE_REALTIME") != "1")
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port,
                                         log_level="warning", timeout_graceful_shutdown=10))
    app.state.shutdown_callback = lambda: setattr(server, "should_exit", True)
    stopped = threading.Event()

    def open_when_ready():
        while not stopped.wait(.1):
            if server.started:
                if os.environ.get("AUDIOCPP_NO_BROWSER") != "1":
                    webbrowser.open(f"http://127.0.0.1:{port}/")
                return

    threading.Thread(target=open_when_ready, daemon=True).start()
    print(f"[webui] workbench and realtime: http://127.0.0.1:{port}/")
    try:
        server.run()
    finally:
        stopped.set()
