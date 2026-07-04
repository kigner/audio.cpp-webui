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
    AUDIOCPP_BACKEND=gpu|cpu     which bin dir to launch the server from
                                 (default: auto — gpu when an NVIDIA driver and the
                                 gpu server build are both present, else cpu)
    AUDIOCPP_THREADS=N           ggml compute threads (default 1; cpu backend
                                 defaults to all cores minus one)
    AUDIOCPP_SERVER=http://...   talk to an already-running server instead of managing one
    AUDIOCPP_LOAD_TIMEOUT=300    seconds to wait for a model to finish loading
    AUDIOCPP_NO_BROWSER=1        don't open a browser tab
"""
import atexit
import base64
import io
import json
import logging
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import warnings
import wave
from urllib.parse import urlparse

import numpy as np
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

def _detect_backend():
    """Which bundle build (gpu/ or cpu/) to launch. AUDIOCPP_BACKEND=gpu|cuda|cpu
    wins; otherwise auto-detect: gpu when an NVIDIA driver AND the gpu server
    build are both present, else cpu (the server runs fine on the cpu backend,
    just slower and with lower model coverage)."""
    env = os.environ.get("AUDIOCPP_BACKEND", "").strip().lower()
    if env in ("gpu", "cuda"):
        return "gpu"
    if env:
        return env
    if os.name == "nt":
        has_nvidia = os.path.isfile(os.path.join(
            os.environ.get("SystemRoot", r"C:\Windows"), "System32", "nvcuda.dll"))
    else:
        has_nvidia = shutil.which("nvidia-smi") is not None
    if has_nvidia and os.path.isfile(os.path.join(BUNDLE_ROOT, "gpu", "audiocpp_server.exe")):
        return "gpu"
    if os.path.isfile(os.path.join(BUNDLE_ROOT, "cpu", "audiocpp_server.exe")):
        return "cpu"
    return "gpu"


BACKEND = _detect_backend()
# The server's own backend name: bin dirs are gpu/ vs cpu/, but the server takes
# cuda|cpu|vulkan|metal, and its config default is "cuda" — which a CPU-only
# build rejects at startup, so the temp config must always spell it out.
SERVER_BACKEND = "cuda" if BACKEND == "gpu" else BACKEND
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


def _detect_vram_gb():
    """本机 NVIDIA 显卡显存总量（GB，多卡取最大）；无 nvidia-smi/无 N 卡返回 None。
    用于对照 catalog 条目的 min_vram_gb 估算值，提示“下载了也可能跑不动”。"""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5)
        vals = [float(line) for line in out.stdout.split() if line.strip()]
        return round(max(vals) / 1024, 1) if vals else None
    except Exception:
        return None


LOCAL_VRAM_GB = _detect_vram_gb()


def _vram_shortfall(entry):
    """条目估算显存超过本机显存时返回 (需要GB, 本机GB)，否则 None。"""
    if BACKEND == "cpu":
        return None  # CPU 后端跑在系统内存里，显存对照不适用
    need = entry.get("min_vram_gb")
    if need and LOCAL_VRAM_GB and float(need) > LOCAL_VRAM_GB:
        return float(need), LOCAL_VRAM_GB
    return None

LANGS = ["", "english", "chinese", "french", "german", "italian",
         "japanese", "korean", "portuguese", "russian", "spanish", "Auto"]

# Which catalog task tokens each tab can drive. do_tts sends text + optional
# reference voice, which fits both plain TTS ("tts") and voice cloning ("clon").
TTS_TASKS = ("tts", "clon")
ASR_TASKS = ("asr",)
GEN_TASKS = ("gen",)   # music/SFX generation, served via the generic /v1/tasks/run route
VC_TASKS = ("vc", "svc", "s2s")           # 声音转换：源音频 + 目标音色，走 /v1/tasks/run
SEP_TASKS = ("sep",)                      # 音源分离：多轨 named_audio_outputs
ANALYZE_TASKS = ("vad", "diar", "align")  # 音频分析：segments / speaker_turns / words
VDES_TASKS = ("vdes",)                    # 声音设计：文字 + 音色描述，走 /v1/audio/speech

# Per-family behavior for the TTS tab, keyed by catalog `family`. This is how we
# cope with each model wanting different input formats / options: the shared UI
# stays simple, and each family gets its own hint, optional text transform, and
# default request options. A catalog entry can also carry its own `input_hint` /
# `default_options` to override the family profile without editing this file, and
# the "高级参数 (JSON)" box lets you pass ANY model-specific option at run time.
MODEL_PROFILES = {
    "vibevoice": {
        "input_hint": (
            "**VibeVoice** 要求多说话人脚本，每行 `Speaker N: 内容`（N 从 0 起）。"
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
            "**Qwen3-TTS** 是声音克隆：建议上传/选一段干净的单人参考音色，并在“参考文本”里"
            "填该音频对应的原话，否则可能很快截断。"),
    },
    "pocket_tts": {
        "input_hint": "**PocketTTS** 需要参考音色：必须上传/录制或选一个内置参考音色，否则会报错。",
    },
    "chatterbox": {
        "input_hint": (
            "**Chatterbox**（声音克隆）：需要一段参考音色（上传/录音），否则会报错。"
            "语言只支持 english / spanish / french / german / italian / portuguese / korean"
            "（**无中文/日文/俄文，也没有自动检测**）；选“留空”用默认（英语）。"),
        # Chatterbox validates against 2-letter ISO codes (no zh/ja/ru, no auto),
        # so the shared dropdown's friendly names are translated here; names not
        # listed are genuinely unsupported by the model and rejected up front.
        "lang_map": {
            "english": "en", "spanish": "es", "french": "fr", "german": "de",
            "italian": "it", "portuguese": "pt", "korean": "ko",
        },
    },
    "qwen3_asr": {
        # Encoder cap: max_source_positions=1500 tokens at 13 tokens/second
        # (qwen3_asr_audio_encoder_token_count) -> ~115 s of audio per request.
        "input_hint": "**Qwen3-ASR** 单次最长约 115 秒；更长的音频请先剪短或分段转写。",
    },
    "ace_step": {
        "input_hint": (
            "**ACE-Step** 音乐生成/编辑：提示词写风格/乐器/情绪（英文效果最好），可选填歌词。"
            "“高级参数”里的 task_route 默认 text2music（纯文生曲）；cover/repaint/extract 等"
            "编辑类 route 需上传源音频。时长填 -1 表示自动。"),
    },
    "stable_audio": {
        "input_hint": (
            "**Stable Audio** 音乐/音效生成：提示词**仅支持英文**。music 版生成音乐、sfx 版生成"
            "音效；上传源音频可做 init_audio/inpaint（在“高级参数”里选 audio_input_kind）。"
            "不使用歌词。"),
    },
    "heartmula": {
        "input_hint": (
            "**HeartMuLa** 歌词+标签生成歌曲：必须在“高级参数”里填 `tags`（逗号分隔，如 "
            "pop,bright,drums,female vocals），“歌词”填唱词。3B 模型，官方 120 秒长歌实测"
            "峰值显存 ~25G（docs/memory_saver.md），8G 显卡基本跑不动；已默认开 mem_saver，"
            "长歌曲可开 infinite_mode。"),
    },
    "vevo2": {
        "input_hint": (
            "**Vevo2 语音转换**：上传源语音 + 目标音色参考，默认 route=style_preserved_vc"
            "（保留源语音的说话风格，只换音色）。style_converted_vc 等风格转换 route 需在"
            "『其它参数(JSON)』里补 `style_ref`（服务器本地 wav 路径）/ `style_ref_text` / `target_text`。"),
    },
    "seed_vc": {
        "input_hint": (
            "**Seed-VC 语音转换**：上传源语音 + 目标音色参考（几秒到几十秒干净人声），"
            "默认 route=v2_vc；v1_whisper_bigvgan_vc / v1_xlsr_hift_vc 旧路线可在高级参数里切换。"),
    },
    "miocodec": {
        "input_hint": (
            "**MioCodec 声音转换**：codec 重建式转换——源音频提供内容，参考音色提供说话人特征。"
            "它同时也是 MioTTS 的依赖组件。"),
    },
    "htdemucs": {
        "input_hint": "**HTDemucs 音源分离**：上传歌曲，输出 drums / bass / other / vocals 四条分轨；长音频耗时较长。",
    },
    "mel_band_roformer": {
        "input_hint": "**Mel-Band RoFormer 人声分离**：上传歌曲，输出人声轨 + 伴奏轨（mixture − vocals）。",
    },
    "silero_vad": {
        "input_hint": "**Silero VAD**：检测音频中的语音段。WAV 输入会自动转成 16 kHz 单声道后送模型。",
    },
    "marblenet_vad": {
        "input_hint": "**MarbleNet VAD**：帧级语音活动检测，输出语音段列表。WAV 输入会自动转成 16 kHz 单声道。",
    },
    "sortformer_diar": {
        "input_hint": (
            "**Sortformer 说话人分离**：区分“谁在什么时间说话”，最多 4 个说话人。"
            "WAV 输入会自动转成 16 kHz 单声道。"),
    },
    "qwen3_forced_aligner": {
        "input_hint": (
            "**Qwen3 强制对齐**：上传音频并在『对齐文本』里填音频中说的原文，输出逐词时间戳。"
            "单次音频长度上限与 Qwen3-ASR 相同（约 115 秒）。"),
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
    if not entry:
        return ""
    hint = profile_for(entry)["input_hint"]
    short = _vram_shortfall(entry)
    if short:
        warn = (f"⚠️ **显存提示**：该模型按默认设置估算需 **≥{short[0]:g}G** 显存，"
                f"本机检测到 **{short[1]:g}G**——即使能加载也会溢出到共享显存而大幅变慢"
                + ("，下载前请三思。" if not entry["installed"] else "。"))
        hint = warn + ("\n\n" + hint if hint else "")
    return hint


def resolve_language(prof, language):
    """Translate the shared language dropdown into what the selected family
    expects. Most families (Qwen3-TTS, VibeVoice, …) take the UI's friendly
    names as-is, so they have no `lang_map` and the value passes through. A
    family with a restricted language set (Chatterbox: 2-letter ISO codes, no
    Chinese/Japanese/Russian, no auto-detect) supplies a `lang_map`; its names
    are converted and anything it can't do — including "Auto" — is rejected here
    with an actionable message instead of a raw server 500."""
    lang = (language or "").strip()
    lang_map = prof.get("lang_map")
    if not lang_map:
        return lang
    if not lang:
        return ""                       # 留空 = 用模型默认
    code = lang_map.get(lang.lower())
    if code is not None:
        return code
    raise gr.Error(
        f"所选模型不支持语言「{language}」。请改选：{' / '.join(lang_map)}，"
        "或“留空”用模型默认。")


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


def _to_16k_mono_wav(path, target_sr=16000):
    """VAD / 说话人分离 / 强制对齐族要求 16 kHz 单声道输入（Silero、Sortformer 对
    非 16k 直接报错），这里用 wave+numpy 把 PCM WAV 转换成 16k 单声道临时文件。
    已是 16k 单声道、或非 PCM WAV（wave 读不了）时原样透传，由 server 决定成败。"""
    try:
        with wave.open(path, "rb") as w:
            sr, ch, sw = w.getframerate(), w.getnchannels(), w.getsampwidth()
            raw = w.readframes(w.getnframes())
    except Exception:
        return path
    if sr == target_sr and ch == 1:
        return path
    if sw == 2:
        data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sw == 4:
        data = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    elif sw == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        i24 = (b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) |
               (b[:, 2].astype(np.int32) << 16))
        i24 -= (i24 & 0x800000) << 1  # sign-extend 24-bit
        data = i24.astype(np.float32) / 8388608.0
    elif sw == 1:
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        return path
    if ch > 1:
        data = data[: len(data) // ch * ch].reshape(-1, ch).mean(axis=1)
    if sr != target_sr and len(data) > 0:
        n_out = max(1, int(round(len(data) * target_sr / sr)))
        x_old = np.arange(len(data), dtype=np.float64) / sr
        x_new = np.arange(n_out, dtype=np.float64) / target_sr
        data = np.interp(x_new, x_old, data).astype(np.float32)
    fd, out = tempfile.mkstemp(prefix="audiocpp_16k_", suffix=".wav")
    os.close(fd)
    pcm = np.clip(data * 32767.0, -32768, 32767).astype(np.int16)
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(target_sr)
        w.writeframes(pcm.tobytes())
    return out


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
    (re.compile(r"unsupported Chatterbox language", re.I),
     "🌐 Chatterbox 只支持 en/es/fr/de/it/pt/ko（无中文/日文/俄文，也没有自动检测）。"
     "请在“语言”里改选受支持的语言，或“留空”用默认（英语）。"),
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
THREADS = int(os.environ.get("AUDIOCPP_THREADS") or CATALOG.get("threads", 1))
if BACKEND == "cpu" and THREADS <= 1:
    # catalog 里的 threads=1 是按 CUDA 调的（GPU 路径不吃这个值）；CPU 后端的
    # ggml 计算线程数就是它，单线程没法用 —— 默认全核减一，留一个核给 UI/系统。
    THREADS = max(1, (os.cpu_count() or 4) - 1)

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
    """[(label, id)] for catalog models whose task is in `tasks`; missing ones flagged.
    未安装且估算显存超过本机的条目额外标注最低显存，防止白下载。"""
    out = []
    for m in catalog_models():
        if m.get("task") not in tasks:
            continue
        label = m["label"]
        if not m["installed"]:
            label += " · 未安装"
            short = _vram_shortfall(m)
            if short:
                label += f" ⚠️估算需≥{short[0]:g}G显存"
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
    cfg = {"host": HOST, "port": PORT, "backend": SERVER_BACKEND, "device": DEVICE,
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
    extra = f"，threads={THREADS}" if SERVER_BACKEND == "cpu" else ""
    _ui_log(f"启动 audiocpp_server（backend={SERVER_BACKEND}{extra}），加载模型 {entry['label']} …")
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
        ids = ", ".join(loaded_ids()) or "(none)"
        return f"✅ server @ {SERVER} · backend={BACKEND} · model id={ids}"
    return f"⚪ server 未运行 @ {SERVER} — 选择模型并点『📥 加载模型』会自动启动"


def _api_usage_md():
    """状态行下方折叠区的第三方调用说明。端点/字段以 app/server/README.md 为准；
    URL 取运行时的 SERVER，避免和 AUDIOCPP_SERVER / catalog 配置不一致。"""
    return f"""
第三方应用可以直接调用本 WebUI 启动的 `audiocpp_server`（OpenAI 风格 HTTP API），不经过本页面。

- **URL 怎么填**：API 地址是 `{SERVER}`；OpenAI 兼容客户端的 Base URL 填 `{SERVER}/v1`。
  生成语音：`POST {SERVER}/v1/audio/speech` · 音频转写：`POST {SERVER}/v1/audio/transcriptions`
- **模型名称怎么填**：`model` 填模型 id（与本页模型列表一致，如 `qwen3-tts`、`vibevoice`），
  且必须是**当前已加载**的那个 —— server 同一时刻只驻留一个模型，先在本页点『📥 加载模型』；
  可用 `GET {SERVER}/v1/models` 查看当前可用的 id。
- **TTS 请求示例**（响应默认是 WAV 音频；加 `"response_format": "json"` 改为返回 base64 的 JSON）：

```bash
curl {SERVER}/v1/audio/speech -H "Content-Type: application/json" -o out.wav \\
  -d '{{"model": "qwen3-tts", "input": "你好，audio.cpp。", "voice_ref": "D:/voices/ref.wav", "reference_text": "参考音频里的原话", "seed": 1234}}'
```

- **ASR 请求示例**：`-d '{{"model": "qwen3-asr", "audio": "D:/audio/in.wav"}}'`。
  注意 `voice_ref` / `audio` 填的都是 **server 所在机器上的文件路径**（不是浏览器上传）。
- **音乐生成（gen 模型）**：走通用路由 `POST {SERVER}/v1/tasks/run`，body 形如
  `{{"model": "ace-step", "request": {{"text": "提示词", "lyrics": "歌词", "duration_seconds": 30,
  "options": {{"tags": "pop,bright"}}}}}}`，响应 JSON 的 `audio` 字段是 base64 WAV。
- **其它任务（vc/svc/s2s/sep/vad/diar/align）**：同样走 `POST {SERVER}/v1/tasks/run`，`request` 里用
  `audio`（源音频路径）/ `voice_ref`（目标音色）/ `text`（对齐文本）等字段；分离多轨在响应的
  `named_audio_outputs`，VAD/说话人/对齐结果在 `segments` / `speaker_turns` / `words`。
- server 的生命周期跟随本 WebUI 的**命令行窗口**：只关浏览器页面不影响，server 仍可被第三方调用；
  关掉命令窗口（webui.py 退出）才会连带关闭它。也可单独启动 server（如 run_server.bat）
  供第三方应用调用。
"""


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
    short = _vram_shortfall(entry)
    if short:
        warn = (f"⚠️ **显存不足警告**：该模型估算需 **≥{short[0]:g}G** 显存，本机只有 "
                f"**{short[1]:g}G**——下载后大概率溢出到共享显存、速度很慢甚至跑不动。\n\n") + warn

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
            f"下方进度每几秒自动刷新。\n完成后点旁边的『🔄 刷新列表』即可加载。\n日志：{log}")


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
        return f"✅ {entry['label']} 下载进程完成，点旁边的『🔄 刷新列表』刷新可用列表。\n```\n{tail}\n```"
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
def _merged_options(prof, adv_values, adv_options):
    """请求 options 合并：family 默认值 -> 生成控件（仅用户改过的项）-> JSON 兜底框。"""
    options = dict(prof.get("default_options", {}))
    if isinstance(adv_values, dict):
        options.update({k: v for k, v in adv_values.items()
                        if v is not None and v != ""})
    options.update(_parse_adv_options(adv_options))
    return options


def _run_task(entry, model, req, timeout, log_label):
    """POST /v1/tasks/run（通用任务路由）并返回响应 JSON；
    连接失败 / 非 200 统一转成带提示的 gr.Error。"""
    try:
        r = requests.post(f"{SERVER}/v1/tasks/run",
                          json={"model": model, "request": req}, timeout=timeout)
    except requests.RequestException as e:
        _ui_log(f"{log_label}失败：无法连接 server")
        raise gr.Error(f"无法连接 server @ {SERVER}：{e}\n💡 server 可能已退出，重新点『📥 加载模型』。")
    if r.status_code != 200:
        _ui_log(f"{log_label}失败：server {r.status_code}")
        raise server_error(entry, r.status_code, r.text)
    return r.json()


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
        options = _merged_options(prof, adv_values, adv_options)

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
            "language": resolve_language(prof, language),
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


def do_music_gen(model, text, lyrics, source_audio, duration, seed,
                 adv_values, adv_options):
    """Music/SFX generation via the generic /v1/tasks/run route. The request
    object uses the CLI request-JSON fields (text/lyrics/duration_seconds/
    task_route/audio + an options map); the response carries base64 WAV."""
    try:
        if not (text or "").strip():
            raise gr.Error("请输入提示词（想要什么样的音乐/音效）")
        ensure_model_loaded(model, GEN_TASKS)
        entry = catalog_by_id(model)
        prof = profile_for(entry) if entry else DEFAULT_PROFILE
        options = _merged_options(prof, adv_values, adv_options)

        req = {"text": text, "seed": int(seed)}
        # task_route is a top-level request field (not a model option); the
        # generated controls funnel everything through `options`, so lift it out.
        route = options.pop("task_route", None)
        if route:
            req["task_route"] = route
        if (lyrics or "").strip():
            req["lyrics"] = lyrics
        if duration is not None and float(duration) != 0:
            req["duration_seconds"] = float(duration)
        if source_audio:
            req["audio"] = source_audio
        if options:
            req["options"] = options

        dur_note = req.get("duration_seconds", "自动")
        _ui_log(f"音乐生成开始：model={model}，目标时长 {dur_note}s")
        t_start = time.time()
        data = _run_task(entry, model, req, timeout=1800, log_label="音乐生成")
        b64 = data.get("audio")
        if not b64 and data.get("named_audio_outputs"):
            b64 = data["named_audio_outputs"][0].get("audio")
        if not b64:
            raise gr.Error("server 返回里没有音频数据（该模型可能不输出音频）")
        out = os.path.join(OUTPUT_DIR, f"audiocpp_gen_{int(time.time()*1000)}.wav")
        with open(out, "wb") as f:
            f.write(base64.b64decode(b64))
        elapsed = time.time() - t_start
        _ui_log(f"音乐生成完成：{out}，用时 {elapsed:.1f}s")
        return out, f"✅ 生成完成，用时 {elapsed:.1f}s。"
    except gr.Error as e:
        return None, _msg_from_error(e)
    except Exception as e:
        return None, f"❌ 生成失败：{e}"


def do_vc(model, source_audio, target_upload, builtin_voice, seed,
          adv_values, adv_options):
    """声音/歌声转换（vc/svc/s2s），走通用 /v1/tasks/run 路由：`audio` 是源音频，
    `voice_ref` 是目标音色。seed_vc/miocodec 直接用这两个字段；vevo2 也接受它们
    （audio_input/voice speaker 是 source_audio/target_voice 选项的回退），
    风格转换类 route 的额外字段（style_ref 等）由“其它参数(JSON)”兜底。"""
    try:
        if not source_audio:
            raise gr.Error("请上传要转换的源音频")
        ensure_model_loaded(model, VC_TASKS)
        entry = catalog_by_id(model)
        prof = profile_for(entry) if entry else DEFAULT_PROFILE
        options = _merged_options(prof, adv_values, adv_options)

        req = {"audio": source_audio, "seed": int(seed)}
        voice_path = target_upload or (
            os.path.join(PROMPTS_DIR, builtin_voice)
            if builtin_voice and builtin_voice != "(none)" else None)
        if voice_path:
            req["voice_ref"] = voice_path
        if options:
            req["options"] = options

        dur = _audio_duration_seconds(source_audio)
        dur_note = f"{dur:.1f}s" if dur is not None else "未知"
        _ui_log(f"声音转换开始：model={model}，源音频 {dur_note}")
        t_start = time.time()
        data = _run_task(entry, model, req, timeout=1800, log_label="声音转换")
        b64 = data.get("audio")
        if not b64 and data.get("named_audio_outputs"):
            b64 = data["named_audio_outputs"][0].get("audio")
        if not b64:
            raise gr.Error("server 返回里没有音频数据")
        out = os.path.join(OUTPUT_DIR, f"audiocpp_vc_{int(time.time()*1000)}.wav")
        with open(out, "wb") as f:
            f.write(base64.b64decode(b64))
        elapsed = time.time() - t_start
        _ui_log(f"声音转换完成：{out}，用时 {elapsed:.1f}s")
        return out, f"✅ 转换完成，用时 {elapsed:.1f}s。"
    except gr.Error as e:
        return None, _msg_from_error(e)
    except Exception as e:
        return None, f"❌ 转换失败：{e}"


# 分轨 id -> 中文标签；未收录的 id 原样显示。
STEM_LABELS = {"vocals": "人声", "drums": "鼓", "bass": "贝斯", "other": "其它",
               "instrumental": "伴奏", "accompaniment": "伴奏", "audio": "输出"}
MAX_SEP_STEMS = 4


def do_sep(model, audio_path):
    """音源分离：响应里的 named_audio_outputs 每轨落盘成一个 wav，
    前 MAX_SEP_STEMS 轨直接放进播放器，全部轨放进文件下载列表。"""
    empty = [gr.update(value=None, visible=False) for _ in range(MAX_SEP_STEMS)]
    try:
        if not audio_path:
            raise gr.Error("请上传要分离的音频")
        ensure_model_loaded(model, SEP_TASKS)
        entry = catalog_by_id(model)
        dur = _audio_duration_seconds(audio_path)
        dur_note = f"{dur:.1f}s" if dur is not None else "未知"
        _ui_log(f"音源分离开始：model={model}，音频时长 {dur_note}")
        t_start = time.time()
        data = _run_task(entry, model, {"audio": audio_path},
                         timeout=1800, log_label="音源分离")
        stems = data.get("named_audio_outputs") or []
        if not stems and data.get("audio"):
            stems = [{"id": "audio", "audio": data["audio"]}]
        if not stems:
            raise gr.Error("server 返回里没有音轨数据")
        ts = int(time.time() * 1000)
        paths = []
        for stem in stems:
            sid = stem.get("id") or f"stem{len(paths)}"
            safe = re.sub(r"[^A-Za-z0-9_.-]", "_", sid)
            p = os.path.join(OUTPUT_DIR, f"audiocpp_sep_{ts}_{safe}.wav")
            with open(p, "wb") as f:
                f.write(base64.b64decode(stem["audio"]))
            paths.append((sid, p))
        updates = []
        for i in range(MAX_SEP_STEMS):
            if i < len(paths):
                sid, p = paths[i]
                zh = STEM_LABELS.get(sid)
                updates.append(gr.update(
                    value=p, visible=True, label=f"{zh}（{sid}）" if zh else sid))
            else:
                updates.append(gr.update(value=None, visible=False))
        elapsed = time.time() - t_start
        _ui_log(f"音源分离完成：{len(paths)} 轨，用时 {elapsed:.1f}s")
        note = ("" if len(paths) <= MAX_SEP_STEMS
                else f"，其余 {len(paths) - MAX_SEP_STEMS} 轨见下载列表")
        return (*updates, [p for _, p in paths],
                f"✅ 分离完成（{len(paths)} 轨）{note}，用时 {elapsed:.1f}s。")
    except gr.Error as e:
        return (*empty, None, _msg_from_error(e))
    except Exception as e:
        return (*empty, None, f"❌ 分离失败：{e}")


# VAD/diar/align 输入统一转成 16 kHz 单声道后再发（见 _to_16k_mono_wav），
# 所以响应里的 start_sample/end_sample 一律按 16000 换算成秒。
SR_ANALYZE = 16000


def _fmt_ts(samples):
    return f"{samples / SR_ANALYZE:.2f}s"


def do_analyze(model, audio_path, transcript, language):
    """音频分析（vad/diar/align）：格式化 segments / speaker_turns / words 为
    可读文本，原始 JSON 落盘供下载。"""
    try:
        if not audio_path:
            raise gr.Error("请上传或录制音频")
        ensure_model_loaded(model, ANALYZE_TASKS)
        entry = catalog_by_id(model)
        task = entry.get("task") if entry else ""
        req = {"audio": _to_16k_mono_wav(audio_path)}
        if task == "align":
            if not (transcript or "").strip():
                raise gr.Error("强制对齐需要在『对齐文本』里填音频中说的原文")
            req["text"] = transcript.strip()
            if (language or "").strip():
                req["language"] = language.strip()
        dur = _audio_duration_seconds(req["audio"])
        dur_note = f"{dur:.1f}s" if dur is not None else "未知"
        _ui_log(f"音频分析开始：model={model}（task={task}），音频 {dur_note}")
        t_start = time.time()
        data = _run_task(entry, model, req, timeout=900, log_label="音频分析")

        lines = []
        if data.get("segments"):
            segs = data["segments"]
            lines.append(f"共 {len(segs)} 个语音段：")
            speech = 0
            for i, s in enumerate(segs, 1):
                lines.append(f"{i:3d}. {_fmt_ts(s['start_sample'])} → {_fmt_ts(s['end_sample'])}"
                             f"　置信度 {s.get('confidence', 0):.2f}")
                speech += s["end_sample"] - s["start_sample"]
            lines.append(f"语音总时长约 {speech / SR_ANALYZE:.1f}s")
        if data.get("speaker_turns"):
            turns = data["speaker_turns"]
            spk = sorted({t.get("speaker_id", "?") for t in turns})
            lines.append(f"共 {len(turns)} 个发言段、{len(spk)} 个说话人（{', '.join(spk)}）：")
            for i, t in enumerate(turns, 1):
                lines.append(f"{i:3d}. {_fmt_ts(t['start_sample'])} → {_fmt_ts(t['end_sample'])}"
                             f"　{t.get('speaker_id', '?')}　置信度 {t.get('confidence', 0):.2f}")
        if data.get("words"):
            lines.append(f"共 {len(data['words'])} 个词的时间戳：")
            for w in data["words"]:
                lines.append(f"{_fmt_ts(w['start_sample'])} → {_fmt_ts(w['end_sample'])}"
                             f"　{w.get('word', '')}")
        if data.get("text"):
            lines.append(f"文本输出：{data['text']}")
        if not lines:
            lines.append("（模型没有返回可显示的分析结果——音频里可能没有检测到语音）")

        json_path = os.path.join(OUTPUT_DIR, f"audiocpp_analyze_{int(time.time()*1000)}.json")
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        elapsed = time.time() - t_start
        _ui_log(f"音频分析完成：用时 {elapsed:.1f}s")
        return ("\n".join(lines), json_path,
                f"✅ 分析完成（音频 {dur_note}），用时 {elapsed:.1f}s。")
    except gr.Error as e:
        return "", None, _msg_from_error(e)
    except Exception as e:
        return "", None, f"❌ 分析失败：{e}"


def _align_fields_visibility(model_id):
    """音频分析页：只有 align 任务的模型才显示『对齐文本/语言』输入。"""
    entry = catalog_by_id(model_id) if model_id else None
    show = bool(entry) and entry.get("task") == "align"
    return gr.update(visible=show), gr.update(visible=show)


def do_vdes(model, text, instruct, seed, max_tokens, adv_values, adv_options):
    """声音设计（vdes）：文字 + 音色描述走 /v1/audio/speech（instructions 字段
    映射到模型的 instruct 选项），响应是 WAV 音频。"""
    try:
        if not (text or "").strip():
            raise gr.Error("请输入要合成的文字")
        if not (instruct or "").strip():
            raise gr.Error("请填写『音色描述』——声音设计模型靠它决定生成什么样的声音")
        ensure_model_loaded(model, VDES_TASKS)
        entry = catalog_by_id(model)
        prof = profile_for(entry) if entry else DEFAULT_PROFILE
        options = _merged_options(prof, adv_values, adv_options)

        payload = {"model": model, "input": text, "instructions": instruct,
                   "seed": int(seed), "max_tokens": int(max_tokens)}
        if options:
            payload["options"] = options
        _ui_log(f"声音设计开始：model={model}，{len(text)} 字")
        t_start = time.time()
        try:
            r = requests.post(f"{SERVER}/v1/audio/speech", json=payload, timeout=900)
        except requests.RequestException as e:
            _ui_log("声音设计失败：无法连接 server")
            raise gr.Error(f"无法连接 server @ {SERVER}：{e}\n💡 server 可能已退出，重新点『📥 加载模型』。")
        if r.status_code != 200:
            _ui_log(f"声音设计失败：server {r.status_code}")
            raise server_error(entry, r.status_code, r.text)
        out = os.path.join(OUTPUT_DIR, f"audiocpp_vdes_{int(time.time()*1000)}.wav")
        with open(out, "wb") as f:
            f.write(r.content)
        elapsed = time.time() - t_start
        _ui_log(f"声音设计完成：{out}，用时 {elapsed:.1f}s")
        return out, f"✅ 生成完成，用时 {elapsed:.1f}s。"
    except gr.Error as e:
        return None, _msg_from_error(e)
    except Exception as e:
        return None, f"❌ 生成失败：{e}"


def _make_load_handler(tasks):
    """『📥 加载模型』按钮的处理器工厂：按标签页各自的 task 集合校验并加载。"""
    def _load(model):
        try:
            s = ensure_model_loaded(model, tasks)
        except gr.Error as e:
            s = _msg_from_error(e)
        return s, server_status()
    return _load


# 标签页顺序（与 refresh() 的输出、_refresh_outputs 列表一一对应）：
# TTS、ASR、音乐生成、声音转换、音源分离、音频分析、声音设计。
TAB_SPECS = [TTS_TASKS, ASR_TASKS, GEN_TASKS, VC_TASKS,
             SEP_TASKS, ANALYZE_TASKS, VDES_TASKS]


def refresh():
    """重读 catalog / 参数配置，刷新每个标签页的模型下拉和提示。
    返回顺序：各页下拉更新（按 TAB_SPECS 顺序）、状态行、各页提示。"""
    global CATALOG, MODEL_PARAMS
    CATALOG = _load_catalog()
    MODEL_PARAMS = _load_model_params()
    dropdowns, hints = [], []
    for tasks in TAB_SPECS:
        choices = choices_for_tasks(tasks)
        value = choices[0][1] if choices else None
        dropdowns.append(gr.update(choices=choices, value=value))
        hints.append(model_hint_for(value))
    return (*dropdowns, server_status(), *hints)


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

.hint-small { opacity: 0.7; font-size: 0.85em; margin-top: 2px; }
"""


with gr.Blocks(title="audio.cpp WebUI") as demo:
    gr.Markdown("# 🎙️ audio.cpp WebUI")
    status = gr.Markdown(server_status())
    with gr.Accordion("🔌 API 调用说明：第三方应用如何用本 server 生成语音", open=False):
        gr.Markdown(_api_usage_md())
    with gr.Accordion("🔐 下载设置：HF token / 代理（可选，不保存）", open=False):
        with gr.Row():
            hf_token = gr.Textbox(
                label="HF token (下载受限模型时用)", type="password",
                placeholder="hf_xxx —— 或先在命令行运行 huggingface-cli login")
            proxy = gr.Textbox(
                label="代理 (仅下载子进程使用)",
                placeholder="http://127.0.0.1:7890")

    # ---- 每个标签页共用的“模型管理”卡片、接线与高级参数渲染 ----
    def _model_manager_block(task_label, tasks):
        """标准“模型管理”卡片：模型下拉 + 加载/刷新/下载/进度按钮 + 状态区。
        返回组件 dict；接线见 _wire_model_manager（刷新按钮统一接在文件末尾）。"""
        choices = choices_for_tasks(tasks)
        with gr.Group():
            gr.Markdown("#### 🧩 模型管理")
            model = gr.Dropdown(
                label=f"模型列表 (task={task_label})", choices=choices,
                value=(choices[0][1] if choices else None))
            with gr.Row(elem_classes="mm-btn-row"):
                load_btn = gr.Button("📥 加载模型", variant="primary",
                                     size="lg", min_width=100)
                refresh_btn = gr.Button("🔄 刷新列表", variant="primary",
                                        size="lg", min_width=100)
                dl_btn = gr.Button("⬇️ 下载模型", variant="primary",
                                   size="lg", min_width=100)
                dl_stat_btn = gr.Button("📊 下载进度", variant="primary",
                                        size="lg", min_width=100)
            load_status = gr.Markdown("")
            dl_status = gr.Markdown("")
            timer = gr.Timer(3, active=False)
        return {"model": model, "load_btn": load_btn, "refresh_btn": refresh_btn,
                "dl_btn": dl_btn, "dl_stat_btn": dl_stat_btn,
                "load_status": load_status, "dl_status": dl_status, "timer": timer}

    def _wire_model_manager(mm, tasks, hint):
        mm["load_btn"].click(_make_load_handler(tasks), mm["model"],
                             [mm["load_status"], status])
        mm["dl_btn"].click(download_start, [mm["model"], hf_token, proxy],
                           [mm["dl_status"], mm["timer"]])
        mm["timer"].tick(download_status_tick, mm["model"],
                         [mm["dl_status"], mm["timer"]])
        mm["dl_stat_btn"].click(download_status, mm["model"], mm["dl_status"])
        mm["model"].change(model_hint_for, mm["model"], hint)

    def _render_param_controls(model_comp, state_comp, skip=()):
        """“高级参数”折叠区内容：按所选模型的 family 动态生成控件（gr.render），
        控件值写进共享 state（只有用户改过的项会随请求发送）。"""
        @gr.render(inputs=model_comp)
        def _render(model_id):
            specs = [p for p in params_for(model_id) if p.get("name") not in skip]
            if not specs:
                gr.Markdown("*该模型无可调高级参数。*")
                return
            for p in specs:
                comp = _make_param_component(p)
                comp.change(_adv_updater(p["name"]), [state_comp, comp], state_comp)

    # ---------------- TTS / 声音克隆 ----------------
    with gr.Tab("🗣️ TTS / 声音克隆"):
        with gr.Row(equal_height=False):
            # 左列：模型管理 + 参考音频（声音克隆）
            with gr.Column(scale=1):
                tts_mm = _model_manager_block("tts", TTS_TASKS)
                tts_model = tts_mm["model"]

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
                        "*参考音色几秒到几十秒即可；大文件预览需等几秒才出声波图。*",
                        elem_classes="hint-small")
                    tts_ref_text = gr.Textbox(
                        label="参考文本 (克隆时填参考音频里说的内容，越准越好)", lines=2,
                        value="okay, I'm Cemo and what you just heard wasn't a human voice.")

                # 切换模型后的提示，显示在参考音频整块下面
                tts_hint = gr.Markdown(model_hint_for(tts_model.value))

            # 右列：合成设置 + 合成内容 + 生成 + 输出
            with gr.Column(scale=1):
                with gr.Group():
                    gr.Markdown("#### ⚙️ 合成设置")
                    with gr.Row():
                        tts_seed = gr.Number(label="seed", value=1234, precision=0)
                        tts_maxtok = gr.Number(label="max_tokens", value=1200, precision=0)
                    tts_adv_state = gr.State({})
                    with gr.Accordion("高级参数（按所选模型自动生成，只发送改动过的项）", open=False):
                        _render_param_controls(tts_model, tts_adv_state)

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
                        value="chinese")

                tts_btn = gr.Button("🎵 生成语音", variant="primary", size="lg")
                with gr.Group():
                    gr.Markdown("#### 🔊 输出音频")
                    tts_out = gr.Audio(label="输出音频", type="filepath",
                                       elem_classes="audio-default")
                    tts_msg = gr.Markdown("")

        _wire_model_manager(tts_mm, TTS_TASKS, tts_hint)
        tts_model.change(lambda: {}, None, tts_adv_state)  # reset knobs on model switch
        tts_builtin.change(on_builtin_voice_change, tts_builtin,
                           [tts_upload, tts_ref_text])
        # Clear the previous run's audio + status message the moment 生成 is
        # clicked, so a prior message doesn't linger next to the new run's
        # progress indicator (outputs otherwise update only when do_tts returns).
        tts_btn.click(lambda: (None, ""), None, [tts_out, tts_msg]).then(
            do_tts,
            [tts_model, tts_text, tts_lang, tts_upload, tts_builtin,
             tts_ref_text, tts_seed, tts_maxtok, tts_adv_state, tts_adv],
            [tts_out, tts_msg])

    # ---------------- ASR / 音频转写 ----------------
    with gr.Tab("📝 ASR / 音频转写"):
        with gr.Row(equal_height=False):
            # 左列：模型管理 + 音频输入
            with gr.Column(scale=1):
                asr_mm = _model_manager_block("asr", ASR_TASKS)
                asr_model = asr_mm["model"]

                with gr.Group():
                    gr.Markdown("#### 🎤 音频输入")
                    asr_audio = gr.Audio(label="上传/录制音频", type="filepath",
                                         elem_classes="audio-default")
                    gr.Markdown(
                        "*大文件预览需等几秒才出声波图，属正常现象。*",
                        elem_classes="hint-small")
                asr_hint = gr.Markdown(model_hint_for(asr_model.value))
                asr_btn = gr.Button("📝 开始转写", variant="primary", size="lg")

            with gr.Column(scale=1):
                with gr.Group():
                    gr.Markdown("#### 📄 识别结果")
                    asr_out = gr.Textbox(
                        label="转写文本", lines=10,
                        placeholder="转写结果将显示在这里……")
                    asr_msg = gr.Markdown("")

        _wire_model_manager(asr_mm, ASR_TASKS, asr_hint)
        asr_btn.click(lambda: ("", ""), None, [asr_out, asr_msg]).then(
            do_asr, [asr_model, asr_audio], [asr_out, asr_msg])

    # ---------------- 音乐 / 音效生成 ----------------
    with gr.Tab("🎵 音乐生成"):
        with gr.Row(equal_height=False):
            # 左列：模型管理 + 源音频（编辑类用法）
            with gr.Column(scale=1):
                gen_mm = _model_manager_block("gen", GEN_TASKS)
                gen_model = gen_mm["model"]

                with gr.Group():
                    gr.Markdown("#### 🎧 源音频（可选，仅编辑类用法）")
                    gen_audio = gr.Audio(
                        label="上传源音频（ACE-Step cover/repaint 等、Stable Audio init/inpaint 用）",
                        type="filepath", elem_classes="audio-default")

                gen_hint = gr.Markdown(model_hint_for(gen_model.value))

            # 右列：生成设置 + 提示词/歌词 + 生成 + 输出
            with gr.Column(scale=1):
                with gr.Group():
                    gr.Markdown("#### ⚙️ 生成设置")
                    with gr.Row():
                        gen_duration = gr.Number(
                            label="时长(秒)（ACE-Step 可填 -1 自动）", value=30, precision=1)
                        gen_seed = gr.Number(label="seed", value=1234, precision=0)
                    gen_adv_state = gr.State({})
                    with gr.Accordion("高级参数（按所选模型自动生成，只发送改动过的项）", open=False):
                        _render_param_controls(gen_model, gen_adv_state)

                    with gr.Accordion("其它参数（可选，JSON；覆盖上面控件）", open=False):
                        gen_adv = gr.Textbox(
                            label="",
                            placeholder='{"tags": "pop,bright,drums", "num_inference_steps": 8}',
                            lines=3)

                with gr.Group():
                    gr.Markdown("#### ✍️ 提示词与歌词")
                    gen_text = gr.Textbox(
                        label="提示词（风格/乐器/情绪，英文效果最好）", lines=3,
                        value="uplifting pop with bright synths and driving drums")
                    gen_lyrics = gr.Textbox(
                        label="歌词（可选；ACE-Step / HeartMuLa 用）", lines=4)

                gen_btn = gr.Button("🎵 生成音乐", variant="primary", size="lg")
                with gr.Group():
                    gr.Markdown("#### 🔊 输出音频")
                    gen_out = gr.Audio(label="输出音频", type="filepath",
                                       elem_classes="audio-default")
                    gen_msg = gr.Markdown("")

        _wire_model_manager(gen_mm, GEN_TASKS, gen_hint)
        gen_model.change(lambda: {}, None, gen_adv_state)  # reset knobs on model switch
        gen_btn.click(lambda: (None, ""), None, [gen_out, gen_msg]).then(
            do_music_gen,
            [gen_model, gen_text, gen_lyrics, gen_audio, gen_duration, gen_seed,
             gen_adv_state, gen_adv],
            [gen_out, gen_msg])

    # ---------------- 声音转换 (vc / svc / s2s) ----------------
    with gr.Tab("🎭 声音转换"):
        with gr.Row(equal_height=False):
            # 左列：模型管理 + 源音频 + 目标音色
            with gr.Column(scale=1):
                vc_mm = _model_manager_block("vc/svc/s2s", VC_TASKS)
                vc_model = vc_mm["model"]

                with gr.Group():
                    gr.Markdown("#### 🎙️ 源音频（要转换的内容）")
                    vc_source = gr.Audio(label="上传/录制源音频", type="filepath",
                                         elem_classes="audio-default")
                with gr.Group():
                    gr.Markdown("#### 🎧 目标音色（转换成谁的声音）")
                    vc_builtin = gr.Dropdown(
                        label="内置参考音色",
                        choices=["(none)"] + builtin_voices(), value="(none)",
                        info="上传的音色优先于内置音色")
                    vc_target = gr.Audio(label="上传/录制目标音色", type="filepath",
                                         elem_classes="audio-default")

                vc_hint = gr.Markdown(model_hint_for(vc_model.value))

            # 右列：转换设置 + 转换 + 输出
            with gr.Column(scale=1):
                with gr.Group():
                    gr.Markdown("#### ⚙️ 转换设置")
                    vc_seed = gr.Number(label="seed", value=1234, precision=0)
                    vc_adv_state = gr.State({})
                    with gr.Accordion("高级参数（按所选模型自动生成，只发送改动过的项）", open=False):
                        _render_param_controls(vc_model, vc_adv_state)
                    with gr.Accordion("其它参数（可选，JSON；覆盖上面控件）", open=False):
                        vc_adv = gr.Textbox(
                            label="",
                            placeholder='{"route": "style_converted_vc", "style_ref": "D:/style.wav", "target_text": "……"}',
                            lines=3)

                vc_btn = gr.Button("🎭 开始转换", variant="primary", size="lg")
                with gr.Group():
                    gr.Markdown("#### 🔊 输出音频")
                    vc_out = gr.Audio(label="输出音频", type="filepath",
                                      elem_classes="audio-default")
                    vc_msg = gr.Markdown("")

        _wire_model_manager(vc_mm, VC_TASKS, vc_hint)
        vc_model.change(lambda: {}, None, vc_adv_state)  # reset knobs on model switch
        vc_builtin.change(lambda n: on_builtin_voice_change(n)[0], vc_builtin, vc_target)
        vc_btn.click(lambda: (None, ""), None, [vc_out, vc_msg]).then(
            do_vc,
            [vc_model, vc_source, vc_target, vc_builtin, vc_seed,
             vc_adv_state, vc_adv],
            [vc_out, vc_msg])

    # ---------------- 音源分离 (sep) ----------------
    with gr.Tab("🎚️ 音源分离"):
        with gr.Row(equal_height=False):
            # 左列：模型管理 + 输入音频
            with gr.Column(scale=1):
                sep_mm = _model_manager_block("sep", SEP_TASKS)
                sep_model = sep_mm["model"]

                with gr.Group():
                    gr.Markdown("#### 🎵 输入音频")
                    sep_audio = gr.Audio(label="上传要分离的歌曲/音频", type="filepath",
                                         elem_classes="audio-default")
                sep_hint = gr.Markdown(model_hint_for(sep_model.value))
                sep_btn = gr.Button("🎚️ 开始分离", variant="primary", size="lg")

            # 右列：分离结果（各分轨播放器 + 文件下载）
            with gr.Column(scale=1):
                with gr.Group():
                    gr.Markdown("#### 🔊 分离结果")
                    sep_stems = [gr.Audio(label=f"音轨 {i + 1}", type="filepath",
                                          visible=False, elem_classes="audio-default")
                                 for i in range(MAX_SEP_STEMS)]
                    sep_files = gr.File(label="全部音轨文件", file_count="multiple",
                                        interactive=False)
                    sep_msg = gr.Markdown("")

        _wire_model_manager(sep_mm, SEP_TASKS, sep_hint)
        sep_btn.click(
            lambda: (*(gr.update(value=None, visible=False)
                       for _ in range(MAX_SEP_STEMS)), None, ""),
            None, [*sep_stems, sep_files, sep_msg]).then(
            do_sep, [sep_model, sep_audio], [*sep_stems, sep_files, sep_msg])

    # ---------------- 音频分析 (vad / diar / align) ----------------
    with gr.Tab("🔎 音频分析"):
        with gr.Row(equal_height=False):
            # 左列：模型管理 + 音频输入（align 模型多出对齐文本/语言）
            with gr.Column(scale=1):
                ana_mm = _model_manager_block("vad/diar/align", ANALYZE_TASKS)
                ana_model = ana_mm["model"]

                with gr.Group():
                    gr.Markdown("#### 🎤 音频输入")
                    ana_audio = gr.Audio(label="上传/录制音频", type="filepath",
                                         elem_classes="audio-default")
                    gr.Markdown(
                        "*WAV 输入会自动转成 16 kHz 单声道后送模型，结果时间轴也按 16 kHz 换算。*",
                        elem_classes="hint-small")
                    _ana_is_align = bool(
                        ana_model.value and
                        (catalog_by_id(ana_model.value) or {}).get("task") == "align")
                    ana_text = gr.Textbox(
                        label="对齐文本（align 模型必填：音频中说的原文）", lines=3,
                        visible=_ana_is_align)
                    ana_lang = gr.Textbox(
                        label="语言（可选，如 English / Chinese）",
                        visible=_ana_is_align)
                ana_hint = gr.Markdown(model_hint_for(ana_model.value))
                ana_btn = gr.Button("🔎 开始分析", variant="primary", size="lg")

            # 右列：分析结果
            with gr.Column(scale=1):
                with gr.Group():
                    gr.Markdown("#### 📄 分析结果")
                    ana_out = gr.Textbox(
                        label="结果（时间单位：秒）", lines=14,
                        placeholder="语音段 / 说话人 / 逐词时间戳将显示在这里……")
                    ana_json = gr.File(label="原始 JSON 结果", interactive=False)
                    ana_msg = gr.Markdown("")

        _wire_model_manager(ana_mm, ANALYZE_TASKS, ana_hint)
        ana_model.change(_align_fields_visibility, ana_model, [ana_text, ana_lang])
        ana_btn.click(lambda: ("", None, ""), None, [ana_out, ana_json, ana_msg]).then(
            do_analyze, [ana_model, ana_audio, ana_text, ana_lang],
            [ana_out, ana_json, ana_msg])

    # ---------------- 声音设计 (vdes) ----------------
    with gr.Tab("🎨 声音设计"):
        with gr.Row(equal_height=False):
            # 左列：模型管理 + 生成设置
            with gr.Column(scale=1):
                vdes_mm = _model_manager_block("vdes", VDES_TASKS)
                vdes_model = vdes_mm["model"]

                with gr.Group():
                    gr.Markdown("#### ⚙️ 生成设置")
                    with gr.Row():
                        vdes_seed = gr.Number(label="seed", value=1234, precision=0)
                        vdes_maxtok = gr.Number(label="max_tokens", value=1200, precision=0)
                    vdes_adv_state = gr.State({})
                    with gr.Accordion("高级参数（按所选模型自动生成，只发送改动过的项）", open=False):
                        # instruct 有专用的『音色描述』输入框，这里不重复生成
                        _render_param_controls(vdes_model, vdes_adv_state, skip=("instruct",))
                    with gr.Accordion("其它参数（可选，JSON；覆盖上面控件）", open=False):
                        vdes_adv = gr.Textbox(label="", placeholder='{"temperature": 0.9}',
                                              lines=3)
                vdes_hint = gr.Markdown(model_hint_for(vdes_model.value))

            # 右列：设计内容 + 生成 + 输出
            with gr.Column(scale=1):
                with gr.Group():
                    gr.Markdown("#### ✍️ 设计内容")
                    vdes_instruct = gr.Textbox(
                        label="音色描述（用文字描述想要的声音）", lines=3,
                        placeholder="例：低沉磁性的中年男声，语速偏慢，带播音腔")
                    vdes_text = gr.Textbox(
                        label="要合成的文字", lines=5,
                        value="你好，这是 audio.cpp 用文字描述设计出来的声音。")

                vdes_btn = gr.Button("🎨 生成语音", variant="primary", size="lg")
                with gr.Group():
                    gr.Markdown("#### 🔊 输出音频")
                    vdes_out = gr.Audio(label="输出音频", type="filepath",
                                        elem_classes="audio-default")
                    vdes_msg = gr.Markdown("")

        _wire_model_manager(vdes_mm, VDES_TASKS, vdes_hint)
        vdes_model.change(lambda: {}, None, vdes_adv_state)  # reset knobs on model switch
        vdes_btn.click(lambda: (None, ""), None, [vdes_out, vdes_msg]).then(
            do_vdes,
            [vdes_model, vdes_text, vdes_instruct, vdes_seed, vdes_maxtok,
             vdes_adv_state, vdes_adv],
            [vdes_out, vdes_msg])

    # 顺序与 refresh()/TAB_SPECS 一致：各页下拉、状态行、各页提示。
    _refresh_outputs = [
        tts_model, asr_model, gen_model, vc_model, sep_model, ana_model, vdes_model,
        status,
        tts_hint, asr_hint, gen_hint, vc_hint, sep_hint, ana_hint, vdes_hint,
    ]
    for _mm in (tts_mm, asr_mm, gen_mm, vc_mm, sep_mm, ana_mm, vdes_mm):
        _mm["refresh_btn"].click(refresh, None, _refresh_outputs)
    gr.Markdown(
        "---\n<center><small>audio.cpp WebUI · 按需加载，同一时刻只驻留一个模型 · "
        "模型下载在后台进行，进度会自动刷新，也可随时点击「下载进度」手动刷新</small></center>")


if __name__ == "__main__":
    open_browser = os.environ.get("AUDIOCPP_NO_BROWSER") != "1"
    # Gradio 6 moved css/theme from the Blocks constructor to launch().
    demo.launch(server_name="127.0.0.1", server_port=7860, inbrowser=open_browser,
                css=CUSTOM_CSS)
