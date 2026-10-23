"""Local workbench HTTP adapter. Reuses the established model/task implementations."""
from __future__ import annotations

import asyncio
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
from typing import Literal
import uuid
import webbrowser

from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Form, BackgroundTasks
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

try:
    from .workbench_metadata import TASKS, public_model, model_detail, task_for
    from .workbench_references import ReferenceLibrary
    from .workbench_models import deletion_available, deletion_plan, delete_installation
    from .workbench_reference_audio import (audio_duration, clip_reference, require_short_reference,
                                           REFERENCE_SECONDS, LIBRARY_SECONDS, REFERENCE_TOO_LONG)
    from .workbench_launcher import APPLICATION, INSTALL_ID, LOG_DIR, existing_health, open_existing, port_in_use, ui_port, runtime_revision
except ImportError:
    from workbench_metadata import TASKS, public_model, model_detail, task_for
    from workbench_references import ReferenceLibrary
    from workbench_models import deletion_available, deletion_plan, delete_installation
    from workbench_reference_audio import (audio_duration, clip_reference, require_short_reference,
                                          REFERENCE_SECONDS, LIBRARY_SECONDS, REFERENCE_TOO_LONG)
    from workbench_launcher import APPLICATION, INSTALL_ID, LOG_DIR, existing_health, open_existing, port_in_use, ui_port, runtime_revision

PREFIX = "/api/workbench"
AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".opus", ".m4a", ".aac", ".webm", ".mp4", ".aiff", ".aif", ".wma"}
UPLOAD_EXTENSIONS = AUDIO_EXTENSIONS | {".gguf", ".onnx", ".index", ".pth", ".pt"}


class JobRequest(BaseModel):
    task: str
    model: str
    inputs: dict = Field(default_factory=dict)
    options: dict = Field(default_factory=dict)
    action: Literal["generate", "analyze_source"] = "generate"


class DownloadRequest(BaseModel):
    token: str = ""


class LoadRequest(BaseModel):
    options: dict = Field(default_factory=dict)


class DeleteModelRequest(BaseModel):
    token: str


class ReferenceAudioRequest(BaseModel):
    audio: str = ""
    source: str = ""


class ReferenceSaveRequest(ReferenceAudioRequest):
    name: str
    text: str = ""
    overwrite: bool = False


class ReferenceClipRequest(ReferenceAudioRequest):
    start_seconds: float
    end_seconds: float


def clean_message(value):
    # Strip only system decorations; keep emoji in names and generated content.
    message = re.sub(r"(?m)^([ \t]*)(?:[✅❌⏳⚠ℹ🚨💡📝⚪🔄✔✖❗🧠🎵🌐⏱📏🔀🎤🗒🧹📦🎛🧊][\ufe0e\ufe0f]?[ \t]*)+",
                     r"\1", str(value or ""))
    for decorated, plain in (("📥 加载模型", "加载模型"), ("⬇️ 下载模型", "下载模型"),
                             ("📥 Load", "Load"), ("⬇️ Download Model", "Download Model")):
        message = message.replace(decorated, plain)
    return message.strip()


class Workbench:
    clean_message = staticmethod(clean_message)

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
        self.scenario_runtime = None
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
                raise HTTPException(409, "实时会话正在使用模型，请先退出听写或结束通话。")
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
            if not job or not job.get("project_id"):
                self.scenario_runtime = None
            if job:
                stage = job.get("stage") if job.get("project_id") else None
                job["message"] = {"separate": "正在准备人声与背景音乐分离…", "align": "正在准备字幕时间对齐…",
                                  "recognize": "正在准备语音识别…", "synthesize": "正在准备目标语言配音…"}.get(stage, "正在准备模型…")

    def after_load(self, model):
        messages = {"tts": "声音合成中…", "asr": "语音识别中…", "music": "音乐与音效生成中…",
                    "design": "声音设计中…", "vc": "声音转换中…", "processing": "音频处理中…",
                    "separation": "音轨分离中…", "analysis": "音频分析中…"}
        with self.lock:
            job = self.jobs.get(getattr(self.local, "operation", None))
            if job and self.active_job == job["id"]:
                proc = getattr(self.b, "_server_proc", None)
                if job.get("project_id") and proc is not None and proc.poll() is None:
                    self.scenario_runtime = (job["project_id"], proc, model)
                scenario_message = {"separate": "正在分离人声与背景音乐…", "align": "正在对齐字幕时间…",
                                    "recognize": "正在识别语音与字幕时间轴…", "synthesize": "正在生成目标语言配音…"}.get(job.get("stage")) if job.get("project_id") else None
                self.progress(0, desc=scenario_message or ("正在分析源音频…" if job.get("action") == "analyze_source"
                              else messages.get(job["task"], "正在处理…")))

    def release_scenario_model(self, project_id, *, operation=None):
        """Release only this scene's managed runtime, preserving model selections."""
        with self.lock:
            if self.leases or self.active_job != operation:
                return False
            if operation and self.jobs.get(operation, {}).get("project_id") != project_id:
                return False
            owned = self.scenario_runtime
            if not owned or owned[0] != project_id:
                return False
            _, proc, model = owned
            if (proc is not getattr(self.b, "_server_proc", None) or proc.poll() is not None
                    or model != getattr(self.b, "_loaded_id", None)):
                self.scenario_runtime = None
                return False
            self.b.unload_model()
            self.scenario_runtime = None
            return True

    def progress(self, value, desc=None):
        """Bridge task progress to the owning job, never to another page's task."""
        with self.lock:
            job = self.jobs.get(getattr(self.local, "operation", None))
            if not job or self.active_job != job["id"]:
                return
            if job["cancel"].is_set():
                raise RuntimeError("任务已取消。")
            if desc:
                job["message"] = clean_message(desc)

    def reference_asr(self):
        if self.asr is None:
            try:
                from .workbench_asr import ManagedASR
            except ImportError:
                from workbench_asr import ManagedASR
            self.asr = ManagedASR(self.b)
        return self.asr

    def lease(self, ident, config):
        with self.lock:
            if config is None:
                self.leases.pop(ident, None)
                return
            if self.active_job:
                raise RuntimeError("工作台任务正在使用模型，请稍后再开始通话。")
            if any(key != ident for key in self.leases):
                raise RuntimeError("已有实时会话，请先退出听写或结束另一个通话。")
            self.scenario_runtime = None
            self.leases[ident] = {key: config.get(key) for key in (
                "tts_model", "tts_server_source", "tts_streaming", "asr_model")}

    def status(self):
        with self.lock:
            dictation = "speaktype" in self.leases
            busy, realtime = self.active_job or dictation, any(key != "speaktype" for key in self.leases)
        proc = getattr(self.b, "_server_proc", None)
        managed = proc is not None and proc.poll() is None
        model = getattr(self.b, "_loaded_id", None) if proc is None or managed else None
        if not managed and callable(getattr(self.b, "loaded_ids", None)):
            # A status refresh must not wait for inference or probe the same
            # server again through server_status(). Managed models are local.
            available = self.b.loaded_ids(timeout=(0.3, 1))
            model = next((ident for ident in (self.external_model, model) if ident in available), None)
            if model is None:
                model = next(iter(sorted(available)), None)
        return {"server": {"text": f"当前任务模型：{model}" if model else "未加载任务模型",
                           "model": model,
                           "configuration": {
                               "managed": managed,
                               "load_options": dict(getattr(self.b, "_loaded_load_options", None) or {}) if managed else {},
                               "session_options": dict(getattr(self.b, "_loaded_session_options", None) or {}) if managed else {},
                               "mode": getattr(self.b, "_loaded_mode", None) if managed else None}},
                "hardware": {"vram_gb": self.b.LOCAL_VRAM_GB, "backend": self.b.SERVER_BACKEND,
                             "name": getattr(self.b, "LOCAL_GPU_NAME", None)},
                "asr": self.asr.status() if self.asr and callable(getattr(self.asr, "status", None)) else {"model": None, "managed": False},
                "busy": bool(busy), "job": self.active_job, "realtime_active": realtime,
                "speaktype_active": dictation}

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
        if request.action == "analyze_source":
            if request.task != "music" or entry.get("family") != "ace_step":
                raise HTTPException(400, "只有 ACE-Step 支持源音频分析。")
            if not self.input_path(request.inputs.get("audio")):
                raise HTTPException(400, "请先添加源音频。")
        if not entry.get("installed"):
            raise HTTPException(400, "模型尚未准备好，请先在模型中心完成下载。")
        ident = uuid.uuid4().hex
        self.reserve(ident)
        job = {"id": ident, "task": request.task, "model": request.model, "action": request.action,
               "status": "queued", "message": "正在准备模型…", "text": "",
               "artifacts": [], "audio_segments": [], "started": time.monotonic(), "cancel": threading.Event()}
        if reference_audio:
            job["reference_audio"] = reference_audio
        elif request.task == "asr" and self.asr and self.asr.status().get("model") == request.model:
            job["asr_runtime"] = True
            job["dialogue"] = bool(request.inputs.get("dialogue"))
        self.jobs[ident] = job
        threading.Thread(target=self._run, args=(job, request), daemon=True, name="workbench-job").start()
        return {"id": ident}

    def job(self, ident, after=0):
        value = self.jobs.get(ident)
        if value is None:
            raise HTTPException(404, "任务不存在或服务已重新启动。")
        return {key: val for key, val in value.items() if key not in {"cancel", "started", "audio_segments", "reference_audio", "asr_runtime", "dialogue"}} | {
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
            if job.get("reference_audio") or job.get("asr_runtime"):
                self.reference_asr().cancel()
                if not job.get("dialogue"):
                    return self.job(ident)
            # Stop only the process owned by this WebUI; never kill a foreign server.
            proc = getattr(self.b, "_server_proc", None)
            if proc is not None and proc.poll() is None:
                proc.terminate()
            else:
                job["message"] = "已请求取消，正在等待外部推理服务返回。"
            return self.job(ident)

    def speaker_references(self, model, slots, options):
        """Resolve UI selections to the backend's positional WAV list."""
        b = self.b
        entry = b.catalog_by_id(model)
        family = entry.get('family') if entry else None
        if family not in {'moss_ttsd', 'vibevoice'} or not isinstance(slots, list) or not slots:
            raise ValueError('当前模型不支持这组说话人参考。')
        paths, transcripts = [], []
        for index, slot in enumerate(slots):
            if not isinstance(slot, dict) or (slot.get('voice') and slot.get('builtin_voice')):
                raise ValueError('每个说话人只能选择一种参考音频来源。')
            path, transcript = None, slot.get('reference_text')
            builtin = slot.get('builtin_voice')
            if builtin:
                if builtin not in b.builtin_voices():
                    raise ValueError('参考音色不存在，请刷新列表后重新选择。')
                path = str(Path(b.PROMPTS_DIR) / builtin)
                if transcript is None:
                    _, transcript = b.on_builtin_voice_change(builtin)
            elif slot.get('voice'):
                path = self.input_path(slot['voice'])
            if path:
                require_short_reference(path, b)
                path = b._ensure_wav(path)
                if ',' in path:
                    raise ValueError('多说话人参考的文件路径不能含逗号，请重命名后重新上传。')
                if transcript and family == 'moss_ttsd':
                    transcripts.append(f'[S{index + 1}] {str(transcript).strip()}')
            paths.append(path or '')
        if family == 'vibevoice':
            while paths and not paths[-1]:
                paths.pop()
            if any(not path for path in paths):
                raise ValueError('VibeVoice 的说话人参考不能跳过空位，请从 Speaker 0 起依次选择。')
        options.pop(family + '.voice_samples', None)
        options.pop('voice_samples', None)
        if paths:
            options['voice_samples'] = ','.join(paths)
        # A UI selection supersedes a JSON transcript for a different set of references.
        options.pop('reference_text', None)
        options.pop(family + '.reference_text', None)
        return ' '.join(transcripts)

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
            multi_speaker = req.task == 'tts' and 'speaker_references' in values
            voice = None if multi_speaker else self.input_path(values.get("voice"))
            builtin = '(none)' if multi_speaker else values.get("builtin_voice") or "(none)"
            if builtin != "(none)" and builtin not in b.builtin_voices():
                raise ValueError("参考音色不存在，请重新选择。")
            ref_text = str(values.get("reference_text") or "")
            if not ref_text and builtin != "(none)":
                _, ref_text = b.on_builtin_voice_change(builtin)
            seed = values.get("seed")
            seed = (None if req.task in {"tts", "design", "vc"} else 1234) if seed in (None, "") else int(seed)
            max_tokens = values.get("max_tokens")
            max_tokens = None if max_tokens in (None, "") else int(max_tokens)
            text, language = str(values.get("text") or ""), str(values.get("language") or "")
            if req.task == "tts":
                if 'speaker_references' in values:
                    ref_text = self.speaker_references(model, values['speaker_references'], opts)
                    voice, builtin = None, '(none)'
                if voice:
                    require_short_reference(voice, b)
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
                                                 ref_text, seed, max_tokens, opts, "", progress=self.progress)
                    paths.append(path)
            elif req.task == "asr":
                if job.get("reference_audio"):
                    # Reference ASR owns a separate resident server; leave the main model intact.
                    job["message"] = "正在使用 Qwen3-ASR 0.6B 识别参考文本…"
                    job["text"] = self.reference_asr().transcribe(model, audio, job["cancel"])
                    final_message = "✅"
                else:
                    runtime_args = {"asr_runtime": self.asr, "cancel": job["cancel"]} if job.get("asr_runtime") else {}
                    for transcript, message, _details, path in b.do_asr_with_details(
                            model, audio, language, str(values.get("context") or ""),
                            bool(values.get("dialogue")), bool(values.get("stream")), opts, "",
                            bool(values.get("detailed")), **runtime_args):
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
                if req.action == "analyze_source":
                    self.progress(0, desc="正在分析源音频…")
                    _, prefill, final_message = b.do_music_analyze(model, audio, seed, opts)
                    if "✅" in str(final_message) and isinstance(prefill, dict):
                        job["parameter_updates"] = {key: prefill[key] for key in
                            ("source_caption", "source_lyrics", "bpm", "keyscale", "timesignature") if key in prefill}
                else:
                    path, files, final_message = b.do_music_gen_with_files(
                        model, text, str(values.get("lyrics") or ""), audio,
                        values.get("duration") or 0, seed, opts, "")
                    paths.extend([path, *(files or [])])
            elif req.task in {"vc", "processing"}:
                rvc_model, rvc_index = values.get("rvc_voice_model"), values.get("rvc_retrieval_index")
                if self.entry(model).get("family") == "rvc":
                    if values.get("rvc_use_builtin") is True:
                        rvc_model = None
                        opts.pop("voice_model_path", None)
                    elif values.get("rvc_use_builtin") is False and not (rvc_model or opts.get("voice_model_path")):
                        raise ValueError('请选择 RVC 文件，或勾选“使用内置音色”。')
                    if values.get("rvc_no_index") is True:
                        rvc_index = None
                        opts.pop("retrieval_index_path", None)
                        opts["retrieval_blend"] = 0
                    elif (values.get("rvc_no_index") is False and (rvc_model or opts.get("voice_model_path"))
                          and float(opts.get("retrieval_blend", 0)) > 0 and not (rvc_index or opts.get("retrieval_index_path"))):
                        raise ValueError('请为自定义 RVC 音色选择索引文件，或勾选“不使用音色索引”。')
                path, final_message = b.do_vc(model, audio, voice, builtin,
                    self.input_path(rvc_model, audio=False),
                    self.input_path(rvc_index, audio=False), seed, opts, "")
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
    model_files_lock = getattr(download_manager, 'lock', threading.RLock())
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
    try:
        from .mobile_access import install_mobile_routes
    except ImportError:
        from mobile_access import install_mobile_routes
    mobile = install_mobile_routes(app, work)
    try:
        from .workbench_scenarios import install_scenario_routes
    except ImportError:
        from workbench_scenarios import install_scenario_routes
    install_scenario_routes(app, work)
    try:
        from .workbench_speaktype import install_speaktype_routes
    except ImportError:
        from workbench_speaktype import install_speaktype_routes
    speaktype = install_speaktype_routes(app, work)
    app.state.downloads = download_manager
    app.state.instance_id = uuid.uuid4().hex
    app.state.runtime_revision = runtime_revision()
    app.state.shutdown_token = secrets.token_urlsafe(32)
    app.state.shutdown_callback = None
    app.state.shutting_down = False
    backend._workbench_runtime_guard = work.before_load
    backend._workbench_runtime_ready = work.after_load

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        try:
            await asyncio.to_thread(mobile.resume)
            yield
        finally:
            app.state.shutting_down = True
            await asyncio.to_thread(mobile.stop, timeout=None)
            speaktype.close()
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
        elif request.url.path.startswith("/workbench-static/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.exception_handler(ValueError)
    async def value_error(_request, error):
        return JSONResponse({"detail": clean_message(error)}, status_code=400)

    @app.exception_handler(RuntimeError)
    async def runtime_error(_request, error):
        return JSONResponse({"detail": clean_message(error)}, status_code=409)

    @app.exception_handler(HTTPException)
    async def http_error(_request, error):
        detail = clean_message(error.detail) if isinstance(error.detail, str) else error.detail
        return JSONResponse({"detail": detail}, status_code=error.status_code, headers=error.headers)

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
        entry = work.entry(model)
        return {**model_detail(backend, entry), 'deletable': deletion_available(backend, entry)}

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
        require_short_reference(audio, backend)
        entry = work.entry("qwen3-asr")
        if entry.get("family") != "qwen3_asr" or task_for(entry) != "asr":
            raise HTTPException(400, "请在模型中心准备 Qwen3-ASR 0.6B。")
        return work.submit(JobRequest(task="asr", model=entry["id"]), reference_audio=audio)

    @app.post(PREFIX + "/reference-clips")
    def reference_clip(request: ReferenceClipRequest):
        if bool(request.audio) == bool(request.source):
            raise HTTPException(400, "请只选择一个原始参考音频。")
        audio = work.input_path(request.audio) if request.audio else str(references.path(request.source))
        ident = uuid.uuid4().hex
        output = work.inputs_dir / (ident + ".wav")
        duration = clip_reference(audio, output, request.start_seconds, request.end_seconds, backend)
        work.uploads[ident] = output
        return {"id": ident, "name": output.name, "duration": duration,
                "url": PREFIX + "/uploads/" + ident + "/audio"}

    @app.get(PREFIX + "/uploads/{ident}/audio")
    def uploaded_audio(ident: str):
        return FileResponse(work.input_path(ident))

    def validate_upload(path, purpose, recorded):
        if purpose == "reference-library":
            duration = audio_duration(path, backend)
            if duration >= LIBRARY_SECONDS:
                raise HTTPException(400, "音频库只允许上传小于 20 分钟的音频。")
        elif purpose == "tts-reference":
            duration = audio_duration(path, backend, limit=REFERENCE_SECONDS + 1.1)
            if duration > REFERENCE_SECONDS:
                if not recorded or duration > REFERENCE_SECONDS + 1:
                    raise HTTPException(400, REFERENCE_TOO_LONG)
                # MediaRecorder.stop() may flush a final encoded packet after the
                # 30-second timer. Bound only that small recording overrun.
                output = path.with_suffix(".recording.wav")
                duration = clip_reference(path, output, 0, REFERENCE_SECONDS, backend)
                path.unlink(missing_ok=True)
                path = output
        else:
            duration = None
        return path, duration

    @app.post(PREFIX + "/uploads")
    async def upload(file: UploadFile = File(...), purpose: str = Form(""), recorded: bool = Form(False)):
        suffix = Path(file.filename or "").suffix.lower()
        if suffix not in UPLOAD_EXTENSIONS:
            raise HTTPException(400, "不支持此文件格式，请上传音频或模型要求的声音文件。")
        if purpose not in {"", "reference-library", "tts-reference"}:
            raise HTTPException(400, "不支持此上传用途。")
        if purpose and suffix not in AUDIO_EXTENSIONS:
            raise HTTPException(400, "请选择音频文件。")
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
            path, duration = await run_in_threadpool(validate_upload, path, purpose, recorded)
        except Exception:
            path.unlink(missing_ok=True)
            raise
        finally:
            await file.close()
        work.uploads[ident] = path
        return {"id": ident, "name": Path(file.filename or path.name).name, "duration": duration}

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
            runtime_args = {"runtime": work.asr} if task_for(entry) == "asr" and work.asr and work.asr.status().get("model") == model else {}
            message = backend._ensure_with_options(model, TASKS[task_for(entry)][1], options, **runtime_args)
            if not runtime_args:
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
        finally:
            work.release(ident)
        return {"message": clean_message(message), **work.status()}

    @app.post(PREFIX + "/unload-all")
    def unload_all():
        ident = uuid.uuid4().hex
        work.reserve(ident)
        try:
            if work.asr:
                work.asr.unload()
            backend.unload_model()
        finally:
            work.release(ident)
        return {"message": "已卸载工作台所有内存模型。", **work.status()}

    def deletion_blocker(operation=None):
        with work.lock:
            if work.leases or (work.active_job and work.active_job != operation):
                return {'reason': '请先结束正在执行的任务或实时通话，再删除模型。', 'unload': False}
        if any(job.get('status') not in {'done', 'error', 'cancelled'} for job in download_manager.list()):
            return {'reason': '请先完成或取消当前下载（暂停的下载也需取消），再删除模型。', 'unload': False}
        status = work.status()
        if (status['server'].get('model') or status['server'].get('configuration', {}).get('managed')
                or status['asr'].get('model') or status['asr'].get('managed')):
            managed = status['server'].get('configuration', {}).get('managed')
            foreign = status['server'].get('model') and not managed
            foreign = foreign or (status['asr'].get('model') and not status['asr'].get('managed'))
            return {'reason': ('外部推理服务正在使用模型，请先关闭外部服务后重试。' if foreign else
                               '请先卸载所有已加载的模型，释放权重文件后再删除。'), 'unload': not foreign}
        return None

    @app.get(PREFIX + '/models/{model}/deletion')
    def preview_model_deletion(model: str):
        with model_files_lock:
            try:
                plan = deletion_plan(backend, work.entry(model))
            except OSError as error:
                raise HTTPException(409, '模型文件已变化或无法读取，请刷新列表后重试。') from error
            return {**plan, 'blocker': deletion_blocker()}

    @app.post(PREFIX + '/models/{model}/delete')
    def delete_model(model: str, request: DeleteModelRequest):
        ident = uuid.uuid4().hex
        work.reserve(ident)
        try:
            # Share the downloader's lock: a new/resumed installation cannot
            # race the final filesystem validation and deletion.
            with model_files_lock:
                blocker = deletion_blocker(ident)
                if blocker:
                    raise HTTPException(409, blocker['reason'])
                try:
                    result = delete_installation(backend, work.entry(model), request.token)
                except OSError as error:
                    raise HTTPException(409, '模型文件已变化或无法读取，请刷新列表后重试。') from error
        finally:
            work.release(ident)
        return {**result, **work.status()}

    @app.get(PREFIX + "/downloads")
    def downloads():
        return {"downloads": download_manager.list()}

    @app.post(PREFIX + "/downloads/{model}")
    def download(model: str, request: DownloadRequest):
        with model_files_lock:
            work.entry(model)
            return download_manager.start(model, request.token)

    @app.post(PREFIX + "/downloads/{model}/{action}")
    def control(model: str, action: str):
        if action == "resume":
            with model_files_lock:
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
        raise RuntimeError(f"Port {port} is in use. Set AUDIOCPP_UI_PORT to another port and try again.")
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
