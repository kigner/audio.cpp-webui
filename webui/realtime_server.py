"""
Background FastAPI server for the realtime voice pipeline.

Runs in a daemon thread inside the Gradio webui process.  Exposes::

    ws://127.0.0.1:8765/v1/realtime   — OpenAI Realtime protocol WebSocket
    http://127.0.0.1:8765/realtime/   — static orb frontend
    GET /health                         — liveness check

These are only *defaults*; the browser Settings panel overrides them per session
via ``session.update`` (see ``_config_from_session``).

Environment variables::

    AUDIOCPP_LLM_API_KEY     DeepSeek / OpenAI-compatible API key
    AUDIOCPP_LLM_BASE_URL    Chat Completions endpoint (default: https://api.deepseek.com/v1)
    AUDIOCPP_LLM_MODEL       Model ID (default: deepseek-chat)
    AUDIOCPP_TTS_SERVER      C++ TTS server URL (default: http://127.0.0.1:8088)
    AUDIOCPP_TTS_MODEL       TTS model id loaded in that server (default: qwen3-tts)
    AUDIOCPP_TTS_VOICE       Named cached voice id (optional; else use voice_ref)
    AUDIOCPP_TTS_VOICE_REF   Reference audio path for voice cloning
    AUDIOCPP_TTS_SERVER_SOURCE managed|external (default: managed)
    AUDIOCPP_TTS_PLAYBACK_MODE auto|streaming|offline (default: auto)
    AUDIOCPP_TTS_REF_TEXT    Text of the reference audio
    AUDIOCPP_ASR_SERVER      C++ ASR server URL (default: http://127.0.0.1:8081)
    AUDIOCPP_ASR_MODEL       ASR model id loaded in that server (default: qwen3-asr)
    AUDIOCPP_ASR_LANGUAGE    Optional language hint for the ASR model
    AUDIOCPP_INSTRUCTIONS    System prompt for the assistant
    AUDIOCPP_REALTIME_PORT   WebSocket server port (default: 8765)
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import threading
from typing import Any, Callable, Optional

import uvicorn
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from realtime_pipeline import (
    AssistantText,
    AudioChunk,
    AudioSegmentDone,
    PipelineEvent,
    RealtimePipeline,
    ResponseDone,
    SpeechStarted,
    SpeechStopped,
    TurnDiscarded,
    UserTranscript,
)

logger = logging.getLogger("realtime.server")

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "realtime_static")

ModelCatalogProvider = Callable[[], list[dict[str, Any]]]
ManagedTtsLoader = Callable[[str, str], str]

# ── helpers ─────────────────────────────────────────────────────────────


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip()


def _generate_id(prefix: str = "id") -> str:
    import uuid
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _join_transcript(parts: list[str]) -> str:
    out = ""
    for part in parts:
        text = (part or "").strip()
        if not text:
            continue
        if not out:
            out = text
        elif (out[-1].isspace() or text[0].isspace()
              or text[0] in ",.;:!?，。！？、；：）]}》”’"
              or out[-1] in "([{（《“‘"
              or "\u3400" <= out[-1] <= "\u9fff"
              or "\u3400" <= text[0] <= "\u9fff"):
            out += text
        else:
            out += " " + text
    return out.strip()


def _resolve_voice_ref(path: str) -> str:
    """If *path* is relative, resolve it against the webui/ directory so the
    C++ TTS server (whose CWD may be anywhere) can open it."""
    if not path:
        return path
    if os.path.isabs(path):
        return path
    return os.path.normpath(os.path.join(HERE, path))


def _default_config() -> dict:
    """Pipeline config from environment (browser Settings override per session)."""
    return {
        "tts_server": _env("AUDIOCPP_TTS_SERVER", "http://127.0.0.1:8088"),
        "tts_model": _env("AUDIOCPP_TTS_MODEL", "qwen3-tts"),
        "tts_voice": _env("AUDIOCPP_TTS_VOICE", ""),
        "tts_voice_ref": _resolve_voice_ref(_env("AUDIOCPP_TTS_VOICE_REF", "")),
        "tts_reference_text": _env("AUDIOCPP_TTS_REF_TEXT", ""),
        "tts_server_source": _env("AUDIOCPP_TTS_SERVER_SOURCE", "managed"),
        "tts_playback_mode": _env("AUDIOCPP_TTS_PLAYBACK_MODE", "auto"),
        "tts_streaming": False,
        "tts_stream_sample_rate": 0,
        "tts_options": {},
        "asr_server": _env("AUDIOCPP_ASR_SERVER", "http://127.0.0.1:8081"),
        "asr_model": _env("AUDIOCPP_ASR_MODEL", "qwen3-asr"),
        "asr_language": _env("AUDIOCPP_ASR_LANGUAGE", ""),
        "llm_base_url": _env("AUDIOCPP_LLM_BASE_URL", "https://api.deepseek.com/v1"),
        "llm_api_key": _env("AUDIOCPP_LLM_API_KEY", ""),
        "llm_model": _env("AUDIOCPP_LLM_MODEL", "deepseek-chat"),
        "instructions": _env("AUDIOCPP_INSTRUCTIONS", ""),
    }


# Keys the browser is allowed to override via session.update -> session.audiocpp.
_OVERRIDABLE_KEYS = {
    "tts_server", "tts_model", "tts_voice", "tts_voice_ref", "tts_reference_text",
    "tts_server_source", "tts_playback_mode", "tts_options",
    "asr_server", "asr_model", "asr_language",
    "llm_base_url", "llm_api_key", "llm_model", "instructions",
}


def _config_from_session(session: dict) -> dict:
    """Extract pipeline overrides from a session.update payload.  Custom fields
    live under ``session.audiocpp``; the standard OpenAI Realtime fields
    ``instructions`` and ``audio.output.voice`` are also honored."""
    cfg: dict[str, Any] = {}
    audiocpp = session.get("audiocpp")
    if isinstance(audiocpp, dict):
        for key, value in audiocpp.items():
            if key in _OVERRIDABLE_KEYS:
                cfg[key] = value
    if isinstance(session.get("instructions"), str):
        cfg["instructions"] = session["instructions"]
    audio = session.get("audio")
    if isinstance(audio, dict):
        output = audio.get("output")
        if isinstance(output, dict) and isinstance(output.get("voice"), str) and output["voice"]:
            cfg["tts_voice"] = output["voice"]
    # Resolve relative voice_ref paths against webui/ so the C++ TTS server
    # finds them regardless of its own working directory.
    if "tts_voice_ref" in cfg:
        cfg["tts_voice_ref"] = _resolve_voice_ref(cfg["tts_voice_ref"])
    return cfg


def _safe_tts_models(provider: Optional[ModelCatalogProvider]) -> list[dict[str, Any]]:
    if provider is None:
        return []
    try:
        models = provider()
    except Exception:
        logger.exception("Realtime TTS catalog provider failed")
        return []
    return [dict(model) for model in models if isinstance(model, dict) and model.get("id")]


def _resolve_tts_config(
    cfg: dict[str, Any],
    provider: Optional[ModelCatalogProvider],
) -> dict[str, Any]:
    """Resolve user-facing playback mode into the pipeline/server contract."""
    out = dict(cfg)
    models = _safe_tts_models(provider)
    model_id = str(out.get("tts_model") or "").strip()
    meta = next((model for model in models if model.get("id") == model_id), None)

    source = str(out.get("tts_server_source") or "managed").strip().lower()
    if source not in {"managed", "external"}:
        raise ValueError("tts_server_source must be managed or external")
    playback = str(out.get("tts_playback_mode") or "auto").strip().lower()
    if playback not in {"auto", "streaming", "smooth", "offline"}:
        raise ValueError(
            "tts_playback_mode must be auto, streaming, smooth, or offline")

    supports_streaming = bool(meta and meta.get("supports_streaming"))
    streaming = supports_streaming if playback in {"auto", "smooth"} else playback == "streaming"
    if streaming and not supports_streaming:
        raise ValueError(f"TTS model {model_id or '(empty)'} does not support streaming")
    stream_rate = int((meta or {}).get("stream_sample_rate") or 0)
    if streaming and stream_rate <= 0:
        raise ValueError(f"TTS model {model_id} has no streaming sample-rate profile")

    defaults = (meta or {}).get("realtime_defaults")
    options = dict(defaults) if isinstance(defaults, dict) else {}
    requested_options = out.get("tts_options")
    if isinstance(requested_options, dict):
        options.update(requested_options)

    out.update({
        "tts_server_source": source,
        "tts_playback_mode": playback,
        "tts_streaming": streaming,
        "tts_stream_sample_rate": stream_rate if streaming else 0,
        "tts_options": options,
    })
    return out


_PIPELINE_CONFIG_KEYS = {
    "tts_server", "tts_model", "tts_voice", "tts_voice_ref", "tts_reference_text",
    "tts_streaming", "tts_stream_sample_rate", "tts_options",
    "asr_server", "asr_model", "asr_language",
    "llm_base_url", "llm_api_key", "llm_model", "instructions",
}


def _pipeline_config(cfg: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in cfg.items() if key in _PIPELINE_CONFIG_KEYS}


# ── FastAPI app factory ─────────────────────────────────────────────────


def create_app(
    model_catalog_provider: Optional[ModelCatalogProvider] = None,
    managed_tts_loader: Optional[ManagedTtsLoader] = None,
) -> FastAPI:
    app = FastAPI(title="audio.cpp Realtime")

    defaults = _default_config()

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/config")
    async def config():
        """Return defaults and installed TTS capabilities for the Settings panel.

        TTS/ASR/LLM URLs, model ids and voice_ref pre-fill the form; tts_models
        contains only entries supplied by the local WebUI's installed catalog.
        Do not echo the LLM API key back to the browser; the pipeline can still
        use the env-provided key as its server-side default."""
        public_defaults = dict(defaults)
        public_defaults["llm_api_key"] = ""
        public_defaults["llm_api_key_set"] = bool(defaults.get("llm_api_key"))
        public_defaults["tts_models"] = _safe_tts_models(model_catalog_provider)
        public_defaults["managed_tts_available"] = managed_tts_loader is not None
        return public_defaults

    @app.post("/activate")
    async def activate(config: dict[str, Any]):
        """Resolve TTS mode and prepare the local managed server before capture."""
        merged = dict(defaults)
        merged.update({key: value for key, value in config.items()
                       if key in _OVERRIDABLE_KEYS})
        try:
            resolved = _resolve_tts_config(merged, model_catalog_provider)
            status = "external server; model loading is caller-managed"
            if resolved["tts_server_source"] == "managed":
                if managed_tts_loader is None:
                    status = "managed loader unavailable; using the existing server"
                else:
                    mode = "streaming" if resolved["tts_streaming"] else "offline"
                    status = await asyncio.to_thread(
                        managed_tts_loader, resolved["tts_model"], mode)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("Failed to activate realtime TTS model")
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {
            "status": "ok",
            "message": status,
            "tts_model": resolved["tts_model"],
            "tts_streaming": resolved["tts_streaming"],
            "tts_stream_sample_rate": resolved["tts_stream_sample_rate"],
        }

    @app.websocket("/v1/realtime")
    async def ws_realtime(ws: WebSocket):
        await ws.accept()
        session_id = _generate_id("session")

        initial_cfg = _resolve_tts_config(defaults, model_catalog_provider)
        session_cfg = dict(initial_cfg)
        pipeline = RealtimePipeline(**_pipeline_config(initial_cfg))
        pipeline.start()

        # ── Send session.created ──
        await ws.send_json({
            "type": "session.created",
            "session": {
                "id": session_id,
                "type": "realtime",
                "audio": {
                    "input": {"format": {"type": "pcm16", "sample_rate": 16000, "channels": 1}},
                    "output": {"format": {"type": "pcm16", "sample_rate": 16000, "channels": 1}},
                },
            },
        })

        async def send_events():
            """Poll pipeline events and send them over the WebSocket."""
            current_resp_id: Optional[str] = None  # stable across one assistant turn
            _full_parts: list[str] = []    # committed sentences for response.done

            def _ensure_resp_id() -> str:
                nonlocal current_resp_id
                if current_resp_id is None:
                    current_resp_id = _generate_id("resp")
                return current_resp_id

            while True:
                await asyncio.sleep(0.01)
                for event in pipeline.drain_events():
                    if isinstance(event, SpeechStarted):
                        current_resp_id = None  # barge-in: new turn, new response
                        _full_parts = []
                        item_id = _generate_id("item")
                        await ws.send_json({
                            "type": "input_audio_buffer.speech_started",
                            "item_id": item_id,
                        })
                    elif isinstance(event, SpeechStopped):
                        await ws.send_json({
                            "type": "input_audio_buffer.speech_stopped",
                        })
                    elif isinstance(event, TurnDiscarded):
                        await ws.send_json({
                            "type": "input_audio_buffer.turn_discarded",
                            "reason": event.reason,
                        })
                    elif isinstance(event, UserTranscript):
                        item_id = _generate_id("item")
                        await ws.send_json({
                            "type": "conversation.item.input_audio_transcription.completed",
                            "item_id": item_id,
                            "transcript": event.text,
                        })
                    elif isinstance(event, AssistantText):
                        # Each delta is now a complete sentence, emitted when
                        # its TTS audio starts being sent — so the frontend
                        # shows the text synchronised with audio playback.
                        rid = _ensure_resp_id()
                        await ws.send_json({
                            "type": "response.output_audio_transcript.delta",
                            "response_id": rid,
                            "delta": event.text,
                        })
                        # Immediately commit as a done segment (the pipeline
                        # already split on sentence boundaries).
                        _full_parts.append(event.text)
                        await ws.send_json({
                            "type": "response.output_audio_transcript.done",
                            "response_id": rid,
                            "transcript": event.text,
                        })
                    elif isinstance(event, AudioChunk):
                        b64 = base64.b64encode(event.pcm).decode("ascii")
                        await ws.send_json({
                            "type": "response.output_audio.delta",
                            "response_id": _ensure_resp_id(),
                            "delta": b64,
                        })
                    elif isinstance(event, AudioSegmentDone):
                        await ws.send_json({
                            "type": "response.output_audio.segment_done",
                            "response_id": _ensure_resp_id(),
                            "duration_ms": round(event.duration_ms, 3),
                            "elapsed_ms": round(event.elapsed_ms, 3),
                            "rtf": round(event.rtf, 4),
                            "streaming": event.streaming,
                        })
                    elif isinstance(event, ResponseDone):
                        rid = current_resp_id or _ensure_resp_id()
                        full_transcript = _join_transcript(_full_parts)
                        await ws.send_json({
                            "type": "response.done",
                            "response": {
                                "id": rid,
                                "status": "completed",
                                "output": [{
                                    "type": "message",
                                    "content": [{
                                        "type": "audio",
                                        "transcript": full_transcript,
                                    }],
                                }] if full_transcript else [],
                            },
                        })
                        current_resp_id = None
                        _full_parts = []

        # Start the event sender as a background task
        send_task = asyncio.create_task(send_events())

        try:
            while True:
                raw = await ws.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                msg_type = msg.get("type", "")

                if msg_type == "session.update":
                    session = msg.get("session")
                    if isinstance(session, dict):
                        cfg = _config_from_session(session)
                        if cfg:
                            candidate = dict(session_cfg)
                            candidate.update(cfg)
                            try:
                                resolved = _resolve_tts_config(
                                    candidate, model_catalog_provider)
                                if (resolved["tts_server_source"] == "managed"
                                        and managed_tts_loader is not None):
                                    mode = ("streaming" if resolved["tts_streaming"]
                                            else "offline")
                                    await asyncio.to_thread(
                                        managed_tts_loader, resolved["tts_model"], mode)
                                pipeline.configure(_pipeline_config(resolved))
                                session_cfg = resolved
                            except Exception as exc:
                                await ws.send_json({
                                    "type": "error",
                                    "error": {
                                        "type": "audiocpp_tts_activation_error",
                                        "code": "audiocpp_tts_activation_error",
                                        "message": str(exc),
                                    },
                                })
                                continue
                    await ws.send_json({"type": "session.updated"})

                elif msg_type == "input_audio_buffer.append":
                    audio_b64 = msg.get("audio", "")
                    if audio_b64:
                        try:
                            pcm = base64.b64decode(audio_b64)
                            pipeline.feed_audio(pcm)
                        except Exception:
                            pass

                elif msg_type == "response.cancel":
                    pipeline.cancel()

                elif msg_type == "input_audio_buffer.commit":
                    pass  # VAD handles boundaries automatically

                elif msg_type == "response.create":
                    pass  # LLM is triggered automatically after STT

        except WebSocketDisconnect:
            logger.info("WebSocket client disconnected: %s", session_id)
        finally:
            send_task.cancel()
            try:
                await send_task
            except asyncio.CancelledError:
                pass
            pipeline.stop()

    # Serve static orb frontend
    if os.path.isdir(STATIC_DIR):
        app.mount("/realtime", StaticFiles(directory=STATIC_DIR, html=True), name="static")

    return app


# ── server launcher (called from webui.py) ──────────────────────────────


class RealtimeServerThread:
    """Manages a uvicorn server in a background daemon thread."""

    def __init__(
        self,
        port: int = 8765,
        model_catalog_provider: Optional[ModelCatalogProvider] = None,
        managed_tts_loader: Optional[ManagedTtsLoader] = None,
    ):
        self.port = port
        self._model_catalog_provider = model_catalog_provider
        self._managed_tts_loader = managed_tts_loader
        self._thread: Optional[threading.Thread] = None
        self._server: Optional[uvicorn.Server] = None

    @property
    def running(self) -> bool:
        return self._server is not None

    def start(self) -> None:
        if self._server is not None:
            return
        app = create_app(self._model_catalog_provider, self._managed_tts_loader)
        config = uvicorn.Config(app, host="127.0.0.1", port=self.port, log_level="warning")
        self._server = uvicorn.Server(config)

        def _run():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            loop.run_until_complete(self._server.serve())  # type: ignore[union-attr]

        self._thread = threading.Thread(target=_run, daemon=True, name="realtime-server")
        self._thread.start()
        logger.info("Realtime server started on ws://127.0.0.1:%d/v1/realtime", self.port)

    def stop(self) -> None:
        if self._server is None:
            return
        self._server.should_exit = True
        logger.info("Realtime server stopped")


# Module-level singleton
_server: Optional[RealtimeServerThread] = None


def get_server(
    port: int = 8765,
    model_catalog_provider: Optional[ModelCatalogProvider] = None,
    managed_tts_loader: Optional[ManagedTtsLoader] = None,
) -> RealtimeServerThread:
    global _server
    if _server is None:
        _server = RealtimeServerThread(
            port=port,
            model_catalog_provider=model_catalog_provider,
            managed_tts_loader=managed_tts_loader,
        )
    return _server


# ── direct execution ──────────────────────────────────────────────────
if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("AUDIOCPP_REALTIME_PORT", "8765"))
    server = get_server(port)
    server.start()
    print(f"Realtime server running at http://127.0.0.1:{port}/realtime/")
    print(f"WebSocket at ws://127.0.0.1:{port}/v1/realtime")
    try:
        import time
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        server.stop()
        print("Server stopped.")
