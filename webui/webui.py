"""
audio.cpp WebUI (Route B) — a thin Gradio frontend that proxies to the local
audiocpp_server HTTP API.

Model loading is on demand: instead of preloading a model at server startup, this
WebUI reads models_catalog.json, lets you pick a model, and (re)starts
audiocpp_server with a single-model config only when you actually load/run it.
One model lives in VRAM at a time — picking a different model swaps it.

Uploaded files are saved by Gradio to local temp paths, which we pass to the
server as `voice_ref` / `audio` (frontend + server run on the same machine).

Just launch this (it starts the server for you):
    venv\\Scripts\\python audiocpp-portable\\webui.py

Env overrides:
    AUDIOCPP_BACKEND=gpu|cpu     which bin dir to launch the server from (default gpu)
    AUDIOCPP_SERVER=http://...   talk to an already-running server instead of managing one
    AUDIOCPP_LOAD_TIMEOUT=300    seconds to wait for a model to finish loading
    AUDIOCPP_NO_BROWSER=1        don't open a browser tab
"""
import atexit
import io
import json
import logging
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import warnings
import wave
from urllib.parse import urlparse

import requests
import gradio as gr

# 降噪：屏蔽 Gradio 内部触发、每次请求都会刷屏的 Starlette 弃用告警。
warnings.filterwarnings("ignore", message=r".*HTTP_422_UNPROCESSABLE.*")


def _silence_proactor_connection_reset():
    """Windows: swallow the benign `ConnectionResetError [WinError 10054]` that
    asyncio's proactor prints when a browser/HTTP connection drops abruptly."""
    if sys.platform != "win32":
        return
    try:
        from asyncio.proactor_events import _ProactorBasePipeTransport
    except Exception:
        return
    _orig = _ProactorBasePipeTransport._call_connection_lost

    def _patched(self, exc):
        if isinstance(exc, ConnectionResetError):
            exc = None  # peer reset == normal close; still run the cleanup below
        try:
            return _orig(self, exc)
        except ConnectionResetError:
            # _orig's own sock.shutdown() raced a peer reset (WinError 10054),
            # which skips the rest of its cleanup — finish it here.
            sock = getattr(self, "_sock", None)
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass
                self._sock = None
            server = getattr(self, "_server", None)
            if server is not None:
                try:
                    server._detach()
                except Exception:
                    pass
                self._server = None
            self._called_connection_lost = True

    _ProactorBasePipeTransport._call_connection_lost = _patched


def _silence_h11_content_length_race():
    """Large uploads (e.g. a multi-minute reference wav) can have the browser
    abort/replace an in-flight preview fetch for the same file while uvicorn
    is still streaming its body; h11 then raises LocalProtocolError trying to
    close out that half-sent response. It's a benign race — verified the
    aborted request doesn't affect the server or any other request, the
    browser's follow-up fetch of the same file completes fine — but uvicorn
    logs it as a full "Exception in ASGI application" traceback per occurrence.
    Drop just that one exception type from uvicorn's logger instead of hiding
    all uvicorn.error output."""
    try:
        from h11 import LocalProtocolError
    except Exception:
        return

    class _DropContentLengthRace(logging.Filter):
        def filter(self, record):
            exc = record.exc_info[1] if record.exc_info else None
            if isinstance(exc, LocalProtocolError) and "declared Content-Length" in str(exc):
                return False
            return True

    logging.getLogger("uvicorn.error").addFilter(_DropContentLengthRace())


_silence_proactor_connection_reset()
_silence_h11_content_length_race()

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(HERE)

# WebUI-local working dirs, kept next to this file and created on startup.
CONFIG_DIR = os.path.join(HERE, "configs")
OUTPUT_DIR = os.path.join(HERE, "output")
VOICE_DIR = os.path.join(HERE, "voice")
LOG_DIR = os.path.join(HERE, "logs")
for _d in (CONFIG_DIR, OUTPUT_DIR, VOICE_DIR, LOG_DIR):
    os.makedirs(_d, exist_ok=True)

PROMPTS_DIR = VOICE_DIR                                    # built-in / reference voices
CATALOG_PATH = os.path.join(CONFIG_DIR, "models_catalog.json")
MODEL_PARAMS_PATH = os.path.join(CONFIG_DIR, "model_params.json")


def _find_bundle_root():
    """Locate the integrated bundle (holds cpu/ gpu/ models/ assets/ tools/).

    Works both in the dev tree (this file lives in webui/, next to
    audiocpp-portable/) and when webui/ is copied into the bundle for
    distribution (then the bundle is this file's own dir). Override with
    AUDIOCPP_BUNDLE."""
    for c in (os.environ.get("AUDIOCPP_BUNDLE"),
              HERE,                                         # webui shipped inside the bundle
              os.path.join(PROJECT_ROOT, "audiocpp-portable")):
        if c and (os.path.isdir(os.path.join(c, "gpu")) or os.path.isdir(os.path.join(c, "cpu"))):
            return c
    return os.environ.get("AUDIOCPP_BUNDLE") or os.path.join(PROJECT_ROOT, "audiocpp-portable")


BUNDLE_ROOT = _find_bundle_root()

BACKEND = os.environ.get("AUDIOCPP_BACKEND", "gpu").strip().lower()
SERVER_EXE = os.path.join(BUNDLE_ROOT, BACKEND, "audiocpp_server.exe")
LOG_PATH = os.path.join(LOG_DIR, "audiocpp_server_webui.log")
LOAD_TIMEOUT = int(os.environ.get("AUDIOCPP_LOAD_TIMEOUT", "300"))

# model_manager.py is used to download not-yet-installed models in the background.
MODELS_ROOT = os.path.join(BUNDLE_ROOT, "models")


def _find_model_manager():
    for c in (os.environ.get("AUDIOCPP_MODEL_MANAGER"),
              os.path.join(BUNDLE_ROOT, "tools", "model_manager.py"),
              os.path.join(PROJECT_ROOT, "tools", "model_manager.py")):
        if c and os.path.isfile(c):
            return c
    return None


MODEL_MANAGER = _find_model_manager()

LANGS = ["", "english", "chinese", "french", "german", "italian",
         "japanese", "korean", "portuguese", "russian", "spanish", "Auto"]

# Which catalog task tokens each tab can drive. do_tts sends text + optional
# reference voice, which fits both plain TTS ("tts") and voice cloning ("clon").
TTS_TASKS = ("tts", "clon")
ASR_TASKS = ("asr",)

# Per-family behavior for the TTS tab, keyed by catalog `family`. This is how we
# cope with each model wanting different input formats / options: the shared UI
# stays simple, and each family gets its own hint, optional text transform, and
# default request options. A catalog entry can also carry its own `input_hint` /
# `default_options` to override the family profile without editing this file, and
# the "高级参数 (JSON)" box lets you pass ANY model-specific option at run time.
MODEL_PROFILES = {
    "vibevoice": {
        "input_hint": (
            "🗣 **VibeVoice** 要求多说话人脚本，每行 `Speaker N: 内容`（N 从 0 起）。"
            "只填普通文字会自动包成 `Speaker 0: ...`。多角色不同音色请在下方“高级参数”里用 "
            "`voice_samples`（逗号分隔的服务器本地 wav，最多 4 个），此时**不要**再上传参考音色。"
            "可调 `num_inference_steps` / `guidance_scale` / `max_length_times`。"),
        "wrap_speaker_script": True,
        # VibeVoice has no internal text chunking. VRAM is bounded since the
        # layerwise-prefill/gallocr decode-graph fix, so chunks no longer need to be
        # tiny; 600 chars keeps each chunk's generation inside the default
        # max_tokens=1200 budget (~1.5 frames/CJK char) and the KV capacity tier
        # <= 2048 (~7.1 GB peak on 8 GB GPUs).
        "chunk_chars": 600,
    },
    "qwen3_tts": {
        "input_hint": (
            "🗣 **Qwen3-TTS** 是声音克隆：建议上传/选一段干净的单人参考音色，并在“参考文本”里"
            "填该音频对应的原话，否则可能很快截断。"),
    },
    "pocket_tts": {
        "input_hint": "🗣 **PocketTTS** 需要参考音色：必须上传/录制或选一个内置参考音色，否则会报错。",
    },
    "chatterbox": {
        "input_hint": "🗣 **Chatterbox**（声音克隆）：需要一段参考音色（上传/录音），否则会报错。",
    },
    "qwen3_asr": {
        # Encoder cap: max_source_positions=1500 tokens at 13 tokens/second
        # (qwen3_asr_audio_encoder_token_count) -> ~115 s of audio per request.
        "input_hint": "📝 **Qwen3-ASR** 单次最长约 115 秒；更长的音频请先剪短或分段转写。",
    },
}
DEFAULT_PROFILE = {"input_hint": "", "wrap_speaker_script": False, "default_options": {},
                   # Families with internal chunking handle long text fine; the client
                   # split only exists to bound each HTTP request (no 900 s timeout)
                   # and surface progress, so the budget can stay coarse.
                   "chunk_chars": 1000}

# One "Speaker N:" line (any speaker index) is enough to treat text as a script.
_SPEAKER_RE = re.compile(r"^\s*Speaker\s+\d+\s*:", re.IGNORECASE | re.MULTILINE)


def profile_for(entry):
    prof = {**DEFAULT_PROFILE, **MODEL_PROFILES.get(entry.get("family", ""), {})}
    if entry.get("input_hint"):
        prof["input_hint"] = entry["input_hint"]
    if entry.get("default_options"):
        prof["default_options"] = {**prof.get("default_options", {}), **entry["default_options"]}
    return prof


def model_hint_for(model_id):
    entry = catalog_by_id(model_id) if model_id else None
    return profile_for(entry)["input_hint"] if entry else ""


def _as_speaker_script(text):
    """Wrap plain text into `Speaker 0:` lines when it isn't already a script."""
    if _SPEAKER_RE.search(text or ""):
        return text
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    return "\n".join(f"Speaker 0: {ln}" for ln in lines) if lines else text


# --- client-side long-text chunking ------------------------------------------
# Long text is synthesized as one HTTP request per chunk and concatenated here.
# That keeps every request bounded (no 900 s timeout, works for families without
# internal chunking) and lets the UI show real per-chunk progress.
_SPEAKER_LINE_RE = re.compile(r"^\s*(Speaker\s+\d+\s*:)\s*(.*)$", re.IGNORECASE)
_SENTENCE_RE = re.compile(r"[^。！？!?；;…]*[。！？!?；;…]+|[^。！？!?；;…]+$")


def _split_long_line(line, budget):
    """Split one overlong line at sentence ends into pieces of <= budget chars,
    re-attaching its `Speaker N:` prefix (if any) to every piece."""
    m = _SPEAKER_LINE_RE.match(line)
    prefix, body = (m.group(1) + " ", m.group(2)) if m else ("", line.strip())
    pieces, cur = [], ""
    for sent in _SENTENCE_RE.findall(body):
        if cur and len(cur) + len(sent) > budget:
            pieces.append(prefix + cur)
            cur = ""
        cur += sent
    if cur:
        pieces.append(prefix + cur)
    return pieces or [line]


def _split_tts_chunks(text, budget):
    """Group non-empty lines into chunks of <= budget chars. A line is never
    split across chunks unless it alone exceeds the budget (then it is split at
    sentence boundaries). Returns a list of chunk strings."""
    units = []
    for ln in (text or "").splitlines():
        if not ln.strip():
            continue
        units.extend(_split_long_line(ln, budget) if len(ln) > budget else [ln])
    chunks, cur, cur_len = [], [], 0
    for unit in units:
        sep = 1 if cur else 0  # the "\n" join separator counts toward the budget
        if cur and cur_len + sep + len(unit) > budget:
            chunks.append("\n".join(cur))
            cur, cur_len, sep = [], 0, 0
        cur.append(unit)
        cur_len += sep + len(unit)
    if cur:
        chunks.append("\n".join(cur))
    return chunks or ([text] if (text or "").strip() else [])


def _concat_wavs(blobs, out_path):
    """Concatenate same-format WAV byte blobs into one file at out_path."""
    params, frames = None, []
    for blob in blobs:
        with wave.open(io.BytesIO(blob)) as w:
            fmt = (w.getnchannels(), w.getsampwidth(), w.getframerate())
            if params is None:
                params = fmt
            elif fmt != params:
                raise gr.Error(f"分段音频格式不一致：{fmt} != {params}")
            frames.append(w.readframes(w.getnframes()))
    with wave.open(out_path, "wb") as w:
        w.setnchannels(params[0])
        w.setsampwidth(params[1])
        w.setframerate(params[2])
        for data in frames:
            w.writeframes(data)


def _audio_duration_seconds(path):
    """Duration of a local audio file, or None when not measurable. wave covers
    WAV, i.e. Gradio mic recordings and the typical uploads here; other formats
    just skip the duration note instead of failing the request."""
    try:
        with wave.open(path, "rb") as w:
            rate = w.getframerate()
            return (w.getnframes() / float(rate)) if rate else None
    except Exception:
        return None


def _parse_adv_options(raw):
    raw = (raw or "").strip()
    if not raw:
        return {}
    try:
        obj = json.loads(raw)
    except Exception as e:
        raise gr.Error(f"高级参数不是合法 JSON：{e}")
    if not isinstance(obj, dict):
        raise gr.Error('高级参数必须是 JSON 对象，例如 {"num_inference_steps": 10}')
    return obj


# Map known server-error fragments to an actionable Chinese hint, so a raw 500
# like "requires a session voice via --voice-ref" becomes "请上传参考音色".
# Ordered specific -> generic; server_error() takes the FIRST match.
ERROR_HINTS = [
    (re.compile(r"max_source_positions", re.I),
     "⏱ 音频过长：Qwen3-ASR 编码器上限 1500 token（约 13 token/秒），"
     "单次最多约 115 秒。请把音频剪短或分段后再转写。"),
    (re.compile(r"combine voice_samples|voice_samples.{0,20}voice_ref", re.I),
     "🔀 voice_samples 与单个参考音色不能同时用：多说话人时请不要上传参考音色。"),
    (re.compile(r"cached voice id", re.I),
     "🎤 需要参考音频文件（不是 voice id）：请上传/录制一段参考音色。"),
    (re.compile(r"no valid Speaker|Speaker\s+N", re.I),
     "📝 需要多说话人脚本：每行写成 `Speaker 0: 内容`（多角色用 Speaker 0/1/…）。"),
    (re.compile(r"reference[-_ ]?text", re.I),
     "🗒 需要参考文本：在“参考文本”里填参考音频里说的原话。"),
    (re.compile(r"voice[-_ ]?ref|voice[-_ ]?id|session voice|speaker reference|"
                r"requires .{0,40}voice|requires audio", re.I),
     "🎤 该模型需要参考音色：上传/录制一段参考音频，或选一个内置参考音色后重试。"),
]


def _extract_server_message(text):
    try:
        return json.loads(text)["error"]["message"] or text
    except Exception:
        return (text or "").strip()


def server_error(entry, status, text, extra=None):
    """Build a friendly gr.Error from a non-200 server response."""
    msg = _extract_server_message(text)
    parts = [f"❌ server {status}：{msg[:400]}"]
    hint = next((h for pat, h in ERROR_HINTS if pat.search(msg)), None)
    if hint:
        parts.append("💡 " + hint)
    if extra:
        parts.append(extra)
    if entry:
        ih = profile_for(entry).get("input_hint")
        if ih:
            parts.append("ℹ️ " + ih)
    return gr.Error("\n\n".join(parts))


def _msg_from_error(e):
    """Human-readable text from a gr.Error/exception, for inline (non-popup) display."""
    return getattr(e, "message", None) or str(e) or "未知错误"


# Fallback catalog if models_catalog.json is missing/unreadable.
DEFAULT_CATALOG = {
    "host": "127.0.0.1", "port": 8080, "device": 0, "threads": 1,
    "models": [
        {"id": "qwen3-tts", "display_name": "Qwen3-TTS 0.6B (tts)",
         "family": "qwen3_tts", "path": "models/Qwen3-TTS-12Hz-0.6B-Base",
         "task": "tts", "mode": "offline"},
        {"id": "vibevoice", "display_name": "VibeVoice 1.5B (tts)",
         "family": "vibevoice", "path": "models/VibeVoice-1.5B",
         "task": "tts", "mode": "offline"},
        {"id": "qwen3-asr", "display_name": "Qwen3-ASR 0.6B (asr)",
         "family": "qwen3_asr", "path": "models/Qwen3-ASR-0.6B",
         "task": "asr", "mode": "offline"},
    ],
}


def _load_catalog():
    if os.path.isfile(CATALOG_PATH):
        try:
            with open(CATALOG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"[webui] failed to read {CATALOG_PATH}: {e}; using defaults")
    return DEFAULT_CATALOG


def _load_model_params():
    """Per-family advanced-parameter specs for the TTS tab (configs/model_params.json).
    Returns {family: [param_spec, ...]}; a missing/broken file -> {} (no knobs shown)."""
    if os.path.isfile(MODEL_PARAMS_PATH):
        try:
            with open(MODEL_PARAMS_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"[webui] failed to read {MODEL_PARAMS_PATH}: {e}; no param controls")
    return {}


CATALOG = _load_catalog()
MODEL_PARAMS = _load_model_params()
HOST = CATALOG.get("host", "127.0.0.1")
PORT = int(CATALOG.get("port", 8080))
DEVICE = int(CATALOG.get("device", 0))
THREADS = int(CATALOG.get("threads", 1))

# If the user points us at an existing server, keep everything consistent with it.
_ENV_SERVER = os.environ.get("AUDIOCPP_SERVER")
if _ENV_SERVER:
    _u = urlparse(_ENV_SERVER)
    HOST = _u.hostname or HOST
    PORT = _u.port or PORT
    SERVER = _ENV_SERVER.rstrip("/")
else:
    SERVER = f"http://{HOST}:{PORT}"

# --- managed server process state ------------------------------------------
_proc_lock = threading.Lock()
_server_proc = None      # subprocess.Popen we launched, or None
_loaded_id = None        # model id our managed server is serving


def catalog_models():
    """Catalog entries annotated with abs_path / installed / label."""
    out = []
    for m in CATALOG.get("models", []):
        rel = m.get("path", "")
        ap = rel if os.path.isabs(rel) else os.path.join(BUNDLE_ROOT, rel)
        entry = dict(m)
        entry["abs_path"] = os.path.normpath(ap).replace("\\", "/")
        entry["installed"] = os.path.exists(entry["abs_path"])
        entry["label"] = m.get("display_name") or m.get("id", "?")
        out.append(entry)
    return out


def catalog_by_id(model_id):
    for m in catalog_models():
        if m.get("id") == model_id:
            return m
    return None


def choices_for_tasks(tasks):
    """[(label, id)] for catalog models whose task is in `tasks`; missing ones flagged."""
    out = []
    for m in catalog_models():
        if m.get("task") not in tasks:
            continue
        label = m["label"] if m["installed"] else m["label"] + " · 未安装"
        out.append((label, m["id"]))
    return out


def builtin_voices():
    if not os.path.isdir(PROMPTS_DIR):
        return []
    return sorted(f for f in os.listdir(PROMPTS_DIR) if f.lower().endswith(".wav"))


def _load_voice_texts():
    """Built-in voice basename -> reference transcript, parsed from
    voice/prompt_text (each line is '<basename>|<transcript>')."""
    texts = {}
    try:
        with open(os.path.join(PROMPTS_DIR, "prompt_text"), "r", encoding="utf-8") as f:
            for line in f:
                name, sep, text = line.rstrip("\n").partition("|")
                if sep:
                    texts[name.strip()] = text
    except Exception:
        pass
    return texts


def on_builtin_voice_change(name):
    """Selecting a built-in voice mirrors its wav into the upload widget and
    fills the matching reference text; '(none)' clears both."""
    if not name or name == "(none)":
        return None, ""
    path = os.path.join(PROMPTS_DIR, name)
    ref = _load_voice_texts().get(os.path.splitext(name)[0], "")
    return (path if os.path.isfile(path) else None), ref


# --- config-driven advanced-parameter controls (TTS tab) -------------------
def params_for(model_id):
    """Advanced-parameter specs for a model, looked up by its catalog family."""
    entry = catalog_by_id(model_id) if model_id else None
    if not entry:
        return []
    specs = MODEL_PARAMS.get(entry.get("family", ""), [])
    return specs if isinstance(specs, list) else []


def _make_param_component(p):
    """Build one Gradio control from a spec (type: slider|number|bool|text|choice).

    interactive=True is forced: inside @gr.render a control that is only wired to
    its own .change handler is otherwise inferred as output-only (read-only)."""
    t = p.get("type", "number")
    label = p.get("label", p.get("name", ""))
    info = p.get("info")
    if t == "bool":
        return gr.Checkbox(label=label, info=info, value=bool(p.get("default", False)),
                           interactive=True)
    if t == "text":
        return gr.Textbox(label=label, info=info, value=p.get("default", ""),
                          placeholder=p.get("placeholder", ""), lines=1,
                          interactive=True)
    if t == "choice":
        return gr.Dropdown(label=label, info=info, choices=p.get("choices", []),
                           value=p.get("default"), interactive=True)
    if t == "slider":
        return gr.Slider(label=label, info=info,
                         minimum=p.get("minimum", 0), maximum=p.get("maximum", 1),
                         step=p.get("step", 0.01), value=p.get("default", 0),
                         interactive=True)
    return gr.Number(label=label, info=info, value=p.get("default"),
                     minimum=p.get("minimum"), maximum=p.get("maximum"),
                     step=p.get("step"), precision=p.get("precision"),
                     interactive=True)


def _adv_updater(name):
    """change-handler that writes one control's value into the shared advanced
    options state dict (keyed by the option name)."""
    def _fn(state, value):
        state = dict(state or {})
        state[name] = value
        return state
    return _fn


# --- server lifecycle ------------------------------------------------------
def _port_open(host, port, timeout=0.5):
    try:
        with socket.create_connection((host, int(port)), timeout=timeout):
            return True
    except OSError:
        return False


def server_alive():
    try:
        requests.get(f"{SERVER}/health", timeout=3).raise_for_status()
        return True
    except Exception:
        return False


def loaded_ids():
    try:
        r = requests.get(f"{SERVER}/v1/models", timeout=5)
        r.raise_for_status()
        return [m.get("id") for m in r.json().get("data", [])]
    except Exception:
        return []


def _write_temp_config(entry):
    model = {
        "id": entry["id"],
        "family": entry["family"],
        "path": entry["abs_path"],
        "task": entry.get("task", "tts"),
        "mode": entry.get("mode", "offline"),
    }
    for key in ("config", "weight", "load_options", "session_options"):
        if entry.get(key) is not None:
            model[key] = entry[key]
    cfg = {"host": HOST, "port": PORT, "device": DEVICE,
           "threads": THREADS, "models": [model]}
    fd, path = tempfile.mkstemp(prefix="audiocpp_webui_cfg_", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(cfg, f)
    return path


def _stop_server():
    global _server_proc, _loaded_id
    proc, _server_proc, _loaded_id = _server_proc, None, None
    if proc is not None and proc.poll() is None:
        try:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
        except Exception:
            pass
    for _ in range(24):  # let the OS release the port
        if not _port_open(HOST, PORT):
            break
        time.sleep(0.25)


def _read_tail(path, n=30, max_bytes=65536):
    """Last n non-empty lines of a file. Reads only the file's tail, and treats
    \\r as a line break so tqdm-style progress (one giant \\r-line) shows its
    latest state instead of nothing."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            data = f.read().decode("utf-8", errors="replace")
        lines = [ln for ln in data.replace("\r\n", "\n").replace("\r", "\n").split("\n")
                 if ln.strip()]
        return "\n".join(lines[-n:]).strip()
    except Exception:
        return ""


def _log_tail(n=30):
    return _read_tail(LOG_PATH, n)


# One shared append handle for the WebUI log: the pump thread (server output)
# and _ui_log (webui-side request events) both write through it, so lines
# interleave correctly instead of two handles overwriting each other.
_log_lock = threading.Lock()
_log_fh = None


def _open_log_file(truncate=False):
    global _log_fh
    with _log_lock:
        if _log_fh is not None:
            try:
                _log_fh.close()
            except Exception:
                pass
        _log_fh = open(LOG_PATH, "w" if truncate else "a",
                       encoding="utf-8", errors="replace")


def _log_write(text):
    global _log_fh
    with _log_lock:
        if _log_fh is None:
            try:
                _log_fh = open(LOG_PATH, "a", encoding="utf-8", errors="replace")
            except Exception:
                return
        try:
            _log_fh.write(text)
            _log_fh.flush()
        except Exception:
            pass


def _ts():
    return time.strftime("%H:%M:%S")


def _emit_log_line(text):
    """One already-formatted line to BOTH the console and the WebUI log file."""
    try:
        sys.stdout.write(text)
        sys.stdout.flush()
    except Exception:
        pass
    _log_write(text)


def _ui_log(msg):
    """Timestamped webui-side event (request start/finish, model load, ...) so
    the console/log show when things began and ended, not just server spam."""
    _emit_log_line(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] [webui] {msg}\n")


def _pump_server_output(proc):
    """Tee the server's combined stdout/stderr to console + log file, prefixing
    every line with a timestamp and collapsing consecutive duplicate lines
    (e.g. the repeated `CUDA graph warmup complete`) into a periodic counter."""
    last, repeats = None, 0
    try:
        for line in proc.stdout:
            if line == last:
                repeats += 1
                if repeats % 50 == 0:
                    _emit_log_line(f"[{_ts()}]   ... 上一行已重复 {repeats} 次\n")
                continue
            if repeats:
                _emit_log_line(f"[{_ts()}]   ... (上一行共重复 {repeats} 次)\n")
            last, repeats = line, 0
            _emit_log_line(f"[{_ts()}] {line}")
    except Exception:
        pass
    finally:
        if repeats:
            _emit_log_line(f"[{_ts()}]   ... (上一行共重复 {repeats} 次)\n")


def _start_server(entry):
    global _server_proc, _loaded_id
    if not os.path.isfile(SERVER_EXE):
        raise gr.Error(f"找不到 server: {SERVER_EXE}（用 AUDIOCPP_BACKEND=gpu|cpu 指定）")
    cfg = _write_temp_config(entry)
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    _open_log_file(truncate=True)
    _server_proc = subprocess.Popen(
        [SERVER_EXE, "--config", cfg, "--host", HOST, "--port", str(PORT)],
        cwd=BUNDLE_ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        creationflags=flags, text=True, encoding="utf-8", errors="replace", bufsize=1,
    )
    _loaded_id = entry["id"]
    _ui_log(f"启动 audiocpp_server（backend={BACKEND}），加载模型 {entry['label']} …")
    threading.Thread(target=_pump_server_output, args=(_server_proc,),
                     daemon=True).start()


def _wait_health(timeout):
    start = time.time()
    while time.time() - start < timeout:
        if _server_proc is not None and _server_proc.poll() is not None:
            return False  # process exited before becoming healthy
        if server_alive():
            return True
        time.sleep(0.5)
    return False


def ensure_model_loaded(model_id, expect_tasks=None):
    """(Re)start the server so `model_id` is loaded. Returns a status string."""
    if not model_id:
        raise gr.Error("请先选择一个模型")
    entry = catalog_by_id(model_id)
    if entry is None:
        raise gr.Error(f"catalog 里没有模型 id: {model_id}")
    if not entry["installed"]:
        raise gr.Error(f"模型未安装（目录不存在）: {entry['abs_path']}")
    if expect_tasks and entry.get("task") not in expect_tasks:
        raise gr.Error(
            f"模型 {model_id} 的 task 是 {entry.get('task')}，此处需要 {'/'.join(expect_tasks)}")

    with _proc_lock:
        managed_alive = _server_proc is not None and _server_proc.poll() is None
        if managed_alive and _loaded_id == model_id and server_alive():
            return f"✅ 已加载：{entry['label']}"

        if not managed_alive and server_alive():
            # A server we didn't launch is holding the port.
            if model_id in loaded_ids():
                return f"✅ 复用外部 server：{entry['label']}"
            raise gr.Error(
                f"检测到一个非本 WebUI 启动的 server 正占用 {HOST}:{PORT}"
                f"（例如 run_server.bat）。请先关闭它，或设 AUDIOCPP_SERVER 指向它。")

        _stop_server()
        t0 = time.time()
        _start_server(entry)
        if not _wait_health(LOAD_TIMEOUT):
            tail = _log_tail()
            _stop_server()
            _ui_log(f"模型 {entry['label']} 加载失败/超时（{LOAD_TIMEOUT}s）")
            raise gr.Error(f"加载 {entry['label']} 失败/超时（{LOAD_TIMEOUT}s）。\n日志尾部：\n{tail}")
        _ui_log(f"模型 {entry['label']} 加载完成，用时 {time.time() - t0:.1f}s")
        return f"✅ 已加载：{entry['label']}"


def server_status():
    if server_alive():
        who = "webui 管理" if _server_proc is not None else "外部"
        ids = ", ".join(loaded_ids()) or "(none)"
        return f"✅ server @ {SERVER} · backend={BACKEND} · 已加载：{ids} · {who}"
    return f"⚪ server 未运行 @ {SERVER} — 选择模型并点『加载模型』会自动启动"


# --- background model downloads (via tools/model_manager.py) ----------------
_dl_lock = threading.Lock()
_downloads = {}  # model_id -> {"proc": Popen, "log": path}


def _dl_log_path(model_id):
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", model_id)
    return os.path.join(LOG_DIR, f"download_{safe}.log")


def _dir_size_bytes(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def _fmt_bytes(n):
    return f"{n / 1e9:.2f} GB" if n >= 1e9 else f"{n / 1e6:.1f} MB"


def _download_progress_note(entry):
    """Bytes already on disk for a running download. model_manager stages into
    models/.engine_model_staging/<target>.partial/ and renames on completion;
    fall back to the whole staging root for packages with composite targets."""
    staging_root = os.path.join(MODELS_ROOT, ".engine_model_staging")
    base = os.path.basename(entry.get("path", "").rstrip("/\\"))
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", base)
    staging = os.path.join(staging_root, safe + ".partial")
    probe = staging if os.path.isdir(staging) else staging_root
    if not os.path.isdir(probe):
        return "尚未写入数据（正在连接/解析）"
    return f"已下载 {_fmt_bytes(_dir_size_bytes(probe))}"


def hf_token_present():
    """True if model_manager will find an HF token (env or cached login)."""
    if os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN"):
        return True
    return os.path.isfile(os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "token"))


def download_model(model_id, hf_token="", proxy=""):
    """Kick off `model_manager.py install <download_id>` in the background."""
    if not model_id:
        return "❌ 请先选择一个模型"
    entry = catalog_by_id(model_id)
    if entry is None:
        return f"❌ catalog 里没有模型 id: {model_id}"
    if entry["installed"]:
        return f"✅ {entry['label']} 已安装，无需下载"
    dl_id = entry.get("download_id")
    if not dl_id:
        return f"⚠️ {entry['label']} 没有配置 download_id（内置资源/依赖），请手动安装"
    if MODEL_MANAGER is None:
        return "❌ 找不到 tools/model_manager.py（设 AUDIOCPP_MODEL_MANAGER 指向它）"

    # Pass a token to the child so gated/private HF repos don't 401.
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"    # progress lines land in the log immediately
    env["PYTHONIOENCODING"] = "utf-8"
    tok = (hf_token or "").strip()
    if tok:
        env["HF_TOKEN"] = tok
        env["HUGGING_FACE_HUB_TOKEN"] = tok
    # Route the child's downloads through a proxy (urllib reads these env vars).
    px = (proxy or "").strip()
    proxy_note = ""
    if px:
        for var in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
            env[var] = px
        proxy_note = f"🌐 通过代理 {px}\n\n"
    warn = "" if (tok or hf_token_present()) else (
        "⚠️ 未检测到 HF token —— 受限/gated 模型会 401。请在上方填入 token"
        "（或先 `huggingface-cli login`），受限模型还需先到其 HF 页面点同意。\n\n")

    with _dl_lock:
        rec = _downloads.get(model_id)
        if rec and rec["proc"].poll() is None:
            return f"⏳ {entry['label']} 已经在后台下载中…\n```\n{_read_tail(rec['log'])}\n```"
        log = _dl_log_path(model_id)
        logf = open(log, "w", encoding="utf-8", errors="replace")
        proc = subprocess.Popen(
            [sys.executable, "-u", MODEL_MANAGER, "install", dl_id,
             "--models-root", MODELS_ROOT, "--overwrite"],
            cwd=PROJECT_ROOT, stdout=logf, stderr=subprocess.STDOUT, env=env)
        _downloads[model_id] = {"proc": proc, "log": log}
    _ui_log(f"开始后台下载 {entry['label']}（{dl_id}），日志：{log}")
    return (f"{warn}{proxy_note}⏳ 已开始后台下载 **{entry['label']}**（{dl_id}），"
            f"下方进度每几秒自动刷新。\n完成后点旁边的『🔄 刷新』即可加载。\n日志：{log}")


def download_status(model_id):
    entry = catalog_by_id(model_id) if model_id else None
    if entry is None:
        return ""
    if entry["installed"]:
        return f"✅ {entry['label']} 已安装"
    rec = _downloads.get(model_id)
    if rec is None:
        return f"⚪ {entry['label']} 未安装，未开始下载"
    code = rec["proc"].poll()
    tail = _read_tail(rec["log"], n=12)
    if code is None:
        return (f"⏳ 正在下载 {entry['label']}… {_download_progress_note(entry)}"
                f" · 更新于 {_ts()}\n```\n{tail}\n```")
    if not rec.get("reported"):
        rec["reported"] = True
        _ui_log(f"{entry['label']} 下载进程结束 (exit {code})")
    if code == 0:
        return f"✅ {entry['label']} 下载进程完成，点旁边的『🔄 刷新』刷新可用列表。\n```\n{tail}\n```"
    return f"❌ {entry['label']} 下载失败 (exit {code})。\n```\n{tail}\n```"


def _download_running(model_id):
    rec = _downloads.get(model_id) if model_id else None
    return rec is not None and rec["proc"].poll() is None


def download_start(model_id, hf_token="", proxy=""):
    """Click handler: kick off the download and arm the auto-refresh timer."""
    msg = download_model(model_id, hf_token, proxy)
    return msg, gr.Timer(active=_download_running(model_id))


def download_status_tick(model_id):
    """Timer tick: refresh status; stop the timer once the download is idle."""
    return download_status(model_id), gr.Timer(active=_download_running(model_id))


# --- task handlers ---------------------------------------------------------
# Task handlers return (output, message): the reminder/status message is shown
# inline under the output widget instead of as a Gradio popup card.
def do_tts(model, text, language, uploaded_voice, builtin_voice,
           reference_text, seed, max_tokens, adv_values, adv_options,
           progress=gr.Progress()):
    try:
        if not (text or "").strip():
            raise gr.Error("请输入要合成的文字")
        ensure_model_loaded(model, TTS_TASKS)

        entry = catalog_by_id(model)
        prof = profile_for(entry) if entry else DEFAULT_PROFILE

        if prof.get("wrap_speaker_script"):     # e.g. VibeVoice needs Speaker N: lines
            text = _as_speaker_script(text)

        # Model-specific knobs travel in a nested "options" object; the server merges
        # every key into the request options and each model reads what it understands.
        # Order: family defaults -> generated controls (user-changed only) -> JSON box.
        options = dict(prof.get("default_options", {}))
        if isinstance(adv_values, dict):
            options.update({k: v for k, v in adv_values.items()
                            if v is not None and v != ""})
        options.update(_parse_adv_options(adv_options))

        voice_path = None
        if uploaded_voice:                      # gradio gives an absolute temp path
            voice_path = uploaded_voice
        elif builtin_voice and builtin_voice != "(none)":
            voice_path = os.path.join(PROMPTS_DIR, builtin_voice)
        # voice_samples (multi-speaker) can't be combined with a single voice_ref.
        if "voice_samples" in options and voice_path:
            voice_path = None

        payload = {
            "model": model,
            "language": language or "",
            "seed": int(seed),
            "max_tokens": int(max_tokens),
        }
        if voice_path:
            payload["voice_ref"] = voice_path
        if (reference_text or "").strip():
            payload["reference_text"] = reference_text
        if options:
            payload["options"] = options

        # Long text goes out as several bounded requests (concatenated below), so a
        # whole chapter neither hits the per-request timeout nor runs blind.
        chunks = _split_tts_chunks(text, prof.get("chunk_chars", 1000))
        _ui_log(f"TTS 开始：model={model}，{len(chunks)} 段 / 共 {sum(len(c) for c in chunks)} 字")
        t_start = time.time()
        blobs = []
        for i, chunk in enumerate(chunks):
            if len(chunks) > 1:
                progress((i, len(chunks)), desc=f"合成 {i + 1}/{len(chunks)} 段…")
            payload["input"] = chunk
            t_chunk = time.time()
            try:
                r = requests.post(f"{SERVER}/v1/audio/speech", json=payload, timeout=900)
            except requests.RequestException as e:
                _ui_log(f"TTS 失败：段 {i + 1}/{len(chunks)} 无法连接 server")
                raise gr.Error(f"无法连接 server @ {SERVER}：{e}\n💡 server 可能已退出，重新点『📥 加载模型』。")
            if r.status_code != 200:
                _ui_log(f"TTS 失败：段 {i + 1}/{len(chunks)}，server {r.status_code}")
                raise server_error(entry, r.status_code, r.text)
            blobs.append(r.content)
            _ui_log(f"TTS 段 {i + 1}/{len(chunks)} 完成（{len(chunk)} 字，"
                    f"{time.time() - t_chunk:.1f}s）")

        out = os.path.join(OUTPUT_DIR, f"audiocpp_tts_{int(time.time()*1000)}.wav")
        if len(blobs) == 1:
            with open(out, "wb") as f:
                f.write(blobs[0])
        else:
            _concat_wavs(blobs, out)
        elapsed = time.time() - t_start
        _ui_log(f"TTS 完成：{out}，总用时 {elapsed:.1f}s")
        parts_note = f"（{len(blobs)} 段）" if len(blobs) > 1 else ""
        return out, f"✅ 生成完成{parts_note}，用时 {elapsed:.1f}s。"
    except gr.Error as e:
        return None, _msg_from_error(e)
    except Exception as e:
        return None, f"❌ 生成失败：{e}"


def do_asr(model, audio_path):
    try:
        if not audio_path:
            raise gr.Error("请上传或录制音频")
        ensure_model_loaded(model, ASR_TASKS)
        entry = catalog_by_id(model)
        dur = _audio_duration_seconds(audio_path)
        dur_note = f"{dur:.1f}s" if dur is not None else "未知"
        payload = {"model": model, "audio": audio_path}
        _ui_log(f"ASR 开始：model={model}，音频时长 {dur_note}")
        t_start = time.time()
        try:
            r = requests.post(f"{SERVER}/v1/audio/transcriptions", json=payload, timeout=900)
        except requests.RequestException as e:
            _ui_log("ASR 失败：无法连接 server")
            raise gr.Error(f"无法连接 server @ {SERVER}：{e}\n💡 server 可能已退出，重新点『📥 加载模型』。")
        if r.status_code != 200:
            _ui_log(f"ASR 失败：server {r.status_code}（音频 {dur_note}）")
            extra = f"⏱ 本次音频时长约 {dur:.1f} 秒" if dur is not None else None
            raise server_error(entry, r.status_code, r.text, extra=extra)
        elapsed = time.time() - t_start
        _ui_log(f"ASR 完成：音频 {dur_note}，用时 {elapsed:.1f}s")
        done = f"✅ 转写完成（音频 {dur_note}），用时 {elapsed:.1f}s。"
        try:
            data = r.json()
        except Exception:
            return r.text, done
        return (data.get("text") or str(data)), done
    except gr.Error as e:
        return "", _msg_from_error(e)
    except Exception as e:
        return "", f"❌ 转写失败：{e}"


def load_tts(model):
    try:
        s = ensure_model_loaded(model, TTS_TASKS)
    except gr.Error as e:
        s = _msg_from_error(e)
    return s, server_status()


def load_asr(model):
    try:
        s = ensure_model_loaded(model, ASR_TASKS)
    except gr.Error as e:
        s = _msg_from_error(e)
    return s, server_status()


def refresh():
    global CATALOG, MODEL_PARAMS
    CATALOG = _load_catalog()
    MODEL_PARAMS = _load_model_params()
    tts = choices_for_tasks(TTS_TASKS)
    asr = choices_for_tasks(ASR_TASKS)
    tval = tts[0][1] if tts else None
    aval = asr[0][1] if asr else None
    return (
        gr.update(choices=tts, value=tval),
        gr.update(choices=asr, value=aval),
        server_status(),
        model_hint_for(tval),
        model_hint_for(aval),
    )


atexit.register(_stop_server)


CUSTOM_CSS = """

.audio-default { border: none !important; box-shadow: none !important; }

.mm-btn-row { gap: 10px !important; }
.mm-btn-row button { border-radius: var(--button-large-radius, var(--radius-lg)) !important; }

/* 长音频的波形出现横向滚动条时，WaveSurfer 的滚动层（58px 内容 + 滚动条）会
   溢出 Gradio 固定 58px 的 .waveform-container / #waveform，盖住下方的
   0:00/总时长标签。放开这两层的高度让标签随内容下移；短音频（无滚动条）时
   min-height 保证布局与原来一致。 */
.waveform-container, #waveform { height: auto !important; min-height: 58px; }

.hint-small { opacity: 0.7; font-size: 0.85em; margin-top: -6px; }
"""


with gr.Blocks(title="audio.cpp WebUI") as demo:
    gr.Markdown(
        "# 🎙️ audio.cpp WebUI\n"
        "本地语音合成与识别 —— 声音克隆（TTS）与音频转写（ASR）。**按需加载**："
        "选择模型后由 WebUI 自动启动/切换本地 `audiocpp_server`，同一时刻只加载一个模型（省显存）。"
        "模型可在后台下载，不影响当前操作。")
    status = gr.Markdown(server_status())
    with gr.Accordion("🔐 下载设置：HF token / 代理（可选，不保存）", open=False):
        with gr.Row():
            hf_token = gr.Textbox(
                label="HF token (下载受限模型时用)", type="password",
                placeholder="hf_xxx —— 或先在命令行运行 huggingface-cli login")
            proxy = gr.Textbox(
                label="代理 (仅下载子进程使用)",
                placeholder="http://127.0.0.1:7890")

    tts_init = choices_for_tasks(TTS_TASKS)
    asr_init = choices_for_tasks(ASR_TASKS)

    # ---------------- TTS / 声音克隆 ----------------
    with gr.Tab("🗣️ TTS / 声音克隆"):
        with gr.Row(equal_height=False):
            # 左列：模型管理 + 参考音频（声音克隆）
            with gr.Column(scale=1):
                with gr.Group():
                    gr.Markdown("#### 🧩 模型管理")
                    tts_model = gr.Dropdown(
                        label="模型列表 (task=tts)", choices=tts_init,
                        value=(tts_init[0][1] if tts_init else None))
                    with gr.Row(elem_classes="mm-btn-row"):
                        tts_load_btn = gr.Button("📥 加载模型", variant="primary",
                                                 size="lg", min_width=100)
                        tts_refresh_btn = gr.Button("🔄 刷新列表", variant="primary",
                                                    size="lg", min_width=100)
                        tts_dl_btn = gr.Button("⬇️ 下载模型", variant="primary",
                                               size="lg", min_width=100)
                    tts_load_status = gr.Markdown("")
                    tts_dl_status = gr.Markdown("")
                    tts_dl_timer = gr.Timer(3, active=False)

                with gr.Group():
                    gr.Markdown("#### 🎧 参考音频（声音克隆）")
                    tts_builtin = gr.Dropdown(
                        label="内置参考音色",
                        choices=["(none)"] + builtin_voices(), value="(none)",
                        info="上传/录音的音色优先于内置音色")
                    tts_upload = gr.Audio(
                        label="上传/录制参考音色（可选）", type="filepath",
                        elem_classes="audio-default")
                    gr.Markdown(
                        "*参考音色几秒到几十秒即可，几分钟的大文件预览可能要等几秒才出声波图。*",
                        elem_classes="hint-small")
                    tts_ref_text = gr.Textbox(
                        label="参考文本 (克隆时填参考音频里说的内容，越准越好)", lines=2,
                        value="okay, I'm Cemo and what you just heard wasn't a human voice.")

                # 切换模型后的提示，显示在参考音频整块下面
                tts_hint = gr.Markdown(
                    model_hint_for(tts_init[0][1] if tts_init else None))

            # 右列：合成设置 + 合成内容 + 生成 + 输出
            with gr.Column(scale=1):
                with gr.Group():
                    gr.Markdown("#### ⚙️ 合成设置")
                    with gr.Row():
                        tts_seed = gr.Number(label="seed", value=1234, precision=0)
                        tts_maxtok = gr.Number(label="max_tokens", value=1200, precision=0)
                    tts_adv_state = gr.State({})
                    with gr.Accordion("高级参数（按所选模型自动生成，只发送改动过的项）", open=False):
                        @gr.render(inputs=tts_model)
                        def _render_tts_params(model_id):
                            specs = params_for(model_id)
                            if not specs:
                                gr.Markdown("*该模型无可调高级参数。*")
                                return
                            for p in specs:
                                comp = _make_param_component(p)
                                comp.change(_adv_updater(p["name"]),
                                            [tts_adv_state, comp], tts_adv_state)

                    with gr.Accordion("其它参数（可选，JSON；覆盖上面控件）", open=False):
                        tts_adv = gr.Textbox(
                            label="",
                            placeholder='{"num_inference_steps": 10, "voice_samples": "D:/a.wav,D:/b.wav"}',
                            lines=3)

                with gr.Group():
                    gr.Markdown("#### ✍️ 合成内容")
                    tts_text = gr.Textbox(
                        label="要合成的文字", lines=5,
                        value="Hello, this is audio dot cpp speaking from a web page.")
                    tts_lang = gr.Dropdown(
                        label="语言 (Auto=自动 / 留空=用模型默认)", choices=LANGS,
                        value="Auto")

                tts_btn = gr.Button("🎵 生成语音", variant="primary", size="lg")
                with gr.Group():
                    gr.Markdown("#### 🔊 输出音频")
                    tts_out = gr.Audio(label="输出音频", type="filepath",
                                       elem_classes="audio-default")
                    tts_msg = gr.Markdown("")

        tts_load_btn.click(load_tts, tts_model, [tts_load_status, status])
        tts_dl_btn.click(download_start, [tts_model, hf_token, proxy],
                         [tts_dl_status, tts_dl_timer])
        tts_dl_timer.tick(download_status_tick, tts_model,
                          [tts_dl_status, tts_dl_timer])
        tts_model.change(model_hint_for, tts_model, tts_hint)
        tts_model.change(lambda: {}, None, tts_adv_state)  # reset knobs on model switch
        tts_builtin.change(on_builtin_voice_change, tts_builtin,
                           [tts_upload, tts_ref_text])
        tts_btn.click(do_tts,
                      [tts_model, tts_text, tts_lang, tts_upload, tts_builtin,
                       tts_ref_text, tts_seed, tts_maxtok, tts_adv_state, tts_adv],
                      [tts_out, tts_msg])

    # ---------------- ASR / 音频转写 ----------------
    with gr.Tab("📝 ASR / 音频转写"):
        with gr.Row(equal_height=False):
            # 左列：模型管理 + 音频输入
            with gr.Column(scale=1):
                with gr.Group():
                    gr.Markdown("#### 🧩 模型管理")
                    asr_model = gr.Dropdown(
                        label="模型列表 (task=asr)", choices=asr_init,
                        value=(asr_init[0][1] if asr_init else None))
                    with gr.Row(elem_classes="mm-btn-row"):
                        asr_load_btn = gr.Button("📥 加载模型", variant="primary",
                                                 size="lg", min_width=100)
                        asr_refresh_btn = gr.Button("🔄 刷新列表", variant="primary",
                                                    size="lg", min_width=100)
                        asr_dl_btn = gr.Button("⬇️ 下载模型", variant="primary",
                                               size="lg", min_width=100)
                    asr_load_status = gr.Markdown("")
                    asr_dl_status = gr.Markdown("")
                    asr_dl_timer = gr.Timer(3, active=False)

                with gr.Group():
                    gr.Markdown("#### 🎤 音频输入")
                    asr_audio = gr.Audio(label="上传/录制音频", type="filepath",
                                         elem_classes="audio-default")
                    gr.Markdown(
                        "*大文件预览可能要等几秒才出声波图（后台是正常的，可忽略命令窗口"
                        "偶尔一闪而过的网络重试信息）。*",
                        elem_classes="hint-small")
                asr_hint = gr.Markdown(
                    model_hint_for(asr_init[0][1] if asr_init else None))
                asr_btn = gr.Button("📝 开始转写", variant="primary", size="lg")

            with gr.Column(scale=1):
                with gr.Group():
                    gr.Markdown("#### 📄 识别结果")
                    asr_out = gr.Textbox(
                        label="转写文本", lines=10,
                        placeholder="转写结果将显示在这里……")
                    asr_msg = gr.Markdown("")

        asr_load_btn.click(load_asr, asr_model, [asr_load_status, status])
        asr_dl_btn.click(download_start, [asr_model, hf_token, proxy],
                         [asr_dl_status, asr_dl_timer])
        asr_dl_timer.tick(download_status_tick, asr_model,
                          [asr_dl_status, asr_dl_timer])
        asr_model.change(model_hint_for, asr_model, asr_hint)
        asr_btn.click(do_asr, [asr_model, asr_audio], [asr_out, asr_msg])

    tts_refresh_btn.click(refresh, None,
                          [tts_model, asr_model, status, tts_hint, asr_hint])
    asr_refresh_btn.click(refresh, None,
                          [tts_model, asr_model, status, tts_hint, asr_hint])
    gr.Markdown(
        "---\n<center><small>audio.cpp WebUI · 按需加载，同一时刻只驻留一个模型 · "
        "模型下载在后台进行，进度会自动刷新显示</small></center>")


if __name__ == "__main__":
    open_browser = os.environ.get("AUDIOCPP_NO_BROWSER") != "1"
    # Gradio 6 moved css/theme from the Blocks constructor to launch().
    demo.launch(server_name="127.0.0.1", server_port=7860, inbrowser=open_browser,
                css=CUSTOM_CSS)
