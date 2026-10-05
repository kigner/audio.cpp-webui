"""Local workbench HTTP adapter. Reuses the established model/task implementations."""
from __future__ import annotations

import base64
import contextlib
import json
import os
from pathlib import Path
import threading
import time
import uuid
import webbrowser

from fastapi import FastAPI, HTTPException, Request, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

try:
    from .workbench_metadata import TASKS, public_model, model_detail, task_for
except ImportError:
    from workbench_metadata import TASKS, public_model, model_detail, task_for

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
        return {"server": {"text": clean_message(self.b.server_status()),
                           "model": getattr(self.b, "_loaded_id", None)},
                "hardware": {"vram_gb": self.b.LOCAL_VRAM_GB, "backend": self.b.SERVER_BACKEND},
                "busy": bool(busy), "job": busy, "realtime_active": realtime}

    def catalog(self):
        entries = [public_model(self.b, e) for e in self.b.catalog_models() if task_for(e)]
        entries.sort(key=lambda e: (not e["installed"], e.get("min_vram_gb") or 999, e["label"]))
        return {"version": self.b.APP_VERSION, "models": entries,
                "tasks": [{"id": key, "label": value[0]} for key, value in TASKS.items()], **self.status()}

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

    def submit(self, request):
        entry = self.entry(request.model)
        if request.task not in TASKS or task_for(entry) != request.task:
            raise HTTPException(400, "这个模型不支持当前任务，请重新选择。")
        if not entry.get("installed"):
            raise HTTPException(400, "模型尚未准备好，请先在模型中心完成下载。")
        ident = uuid.uuid4().hex
        self.reserve(ident)
        job = {"id": ident, "status": "queued", "message": "正在准备模型…", "text": "",
               "artifacts": [], "audio_segments": [], "started": time.monotonic(), "cancel": threading.Event()}
        self.jobs[ident] = job
        threading.Thread(target=self._run, args=(job, request), daemon=True, name="workbench-job").start()
        return {"id": ident}

    def job(self, ident, after=0):
        value = self.jobs.get(ident)
        if value is None:
            raise HTTPException(404, "任务不存在或服务已重新启动。")
        return {key: val for key, val in value.items() if key not in {"cancel", "started", "audio_segments"}} | {
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
        paths, final_message = [], ""
        try:
            if job["cancel"].is_set():
                return
            model = req.model
            audio = self.input_path(values.get("audio"))
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
            elif req.task == "vc":
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
            job.update(status="error" if failed else "done", message=clean_message(final_message))
        except Exception as exc:
            job.update(status="error", message=clean_message(getattr(exc, "detail", None) or str(exc)))
        finally:
            if job["cancel"].is_set():
                job.update(status="cancelled", message="任务已停止。", artifacts=[], audio_segments=[])
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
    app.state.workbench = work
    app.state.downloads = download_manager
    backend._workbench_runtime_guard = work.before_load

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        yield
        download_manager.close()
        if asr_manager:
            asr_manager.close()
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
        return {"voices": [{"name": name} for name in backend.builtin_voices() if name != "(none)"]}

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
            return {"message": clean_message(message), **work.status()}
        finally:
            work.release(ident)

    @app.post(PREFIX + "/unload")
    def unload():
        ident = uuid.uuid4().hex
        work.reserve(ident)
        try:
            message, _ = backend.unload_model()
            return {"message": clean_message(message), **work.status()}
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
    port = int(os.environ.get("AUDIOCPP_UI_PORT", "7860"))
    app = create_workbench_app(backend, realtime=os.environ.get("AUDIOCPP_DISABLE_REALTIME") != "1")
    if os.environ.get("AUDIOCPP_NO_BROWSER") != "1":
        timer = threading.Timer(1.5, lambda: webbrowser.open(f"http://127.0.0.1:{port}/"))
        timer.daemon = True
        timer.start()
    print(f"[webui] workbench and realtime: http://127.0.0.1:{port}/")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
