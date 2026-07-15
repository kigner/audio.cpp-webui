from __future__ import annotations

import asyncio
import io
import json
import logging
import wave
from typing import AsyncIterator, Any

import httpx

from app.config import AsrConfig, VadConfig
from app.vad import SileroVadSegmenter

from .base import TranscriptEvent


LOGGER = logging.getLogger(__name__)


def _latency_from(payload: dict[str, Any]) -> int | None:
    timing = payload.get("timing")
    if not isinstance(timing, dict):
        return None
    for key in ("ttft_ms", "first_token_ms", "first_token_latency_ms"):
        value = timing.get(key)
        if isinstance(value, (int, float)):
            return round(value)
    return None


def normalize_sse_payload(
    payload: str,
    accumulated_text: str,
    session_id: str,
    segment_id: str,
) -> tuple[TranscriptEvent | None, str, bool]:
    if payload.strip() == "[DONE]":
        return None, accumulated_text, True
    value = json.loads(payload)
    event_type = value.get("type")
    if event_type == "transcript.text.delta":
        delta = str(value.get("delta", ""))
        accumulated_text += delta
        return (
            TranscriptEvent(
                type="partial",
                text=accumulated_text,
                session_id=session_id,
                segment_id=segment_id,
                latency_ms=_latency_from(value),
            ),
            accumulated_text,
            False,
        )
    if event_type == "transcript.text.done":
        final_text = str(value.get("text", accumulated_text))
        return (
            TranscriptEvent(
                type="final",
                text=final_text,
                session_id=session_id,
                segment_id=segment_id,
                latency_ms=_latency_from(value),
            ),
            final_text,
            False,
        )
    if event_type in {"error", "transcript.error"}:
        message = str(value.get("message") or value.get("error") or "ASR service error")
        return TranscriptEvent(type="error", session_id=session_id, message=message), accumulated_text, False
    return None, accumulated_text, False


class StreamingAsrClient:
    """Silero VAD segmentation followed by ordered audio.cpp SSE requests."""

    def __init__(self, config: AsrConfig, vad_config: VadConfig) -> None:
        self.config = config
        self.vad_config = vad_config
        self._http: httpx.AsyncClient | None = None
        self._vad: SileroVadSegmenter | None = None
        self._session_id = ""
        self._segment_number = 0
        self._events: asyncio.Queue[TranscriptEvent | None] = asyncio.Queue()
        self._segments: asyncio.Queue[tuple[str, bytes] | None] = asyncio.Queue(maxsize=8)
        self._worker_task: asyncio.Task[None] | None = None
        self._worker_error: Exception | None = None

    async def connect(self) -> None:
        await self._close_http()
        self._http = httpx.AsyncClient(
            base_url=self.config.base_url,
            timeout=httpx.Timeout(self.config.final_timeout_s, connect=self.config.connect_timeout_s),
            trust_env=False,
        )
        response = await self._http.get("/health")
        response.raise_for_status()
        if self._vad is None:
            self._vad = await asyncio.to_thread(SileroVadSegmenter, self.vad_config, self.config.sample_rate)

    async def start_session(self, session_id: str) -> None:
        if self._http is None or self._vad is None:
            raise RuntimeError("ASR client is not connected")
        self._session_id = session_id
        self._segment_number = 0
        self._worker_error = None
        self._events = asyncio.Queue()
        self._segments = asyncio.Queue(maxsize=8)
        self._vad.reset()
        self._worker_task = asyncio.create_task(self._segment_worker(), name="asr-segment-worker")

    async def _queue_segment(self, pcm: bytes) -> None:
        self._segment_number += 1
        segment_id = str(self._segment_number)
        duration_s = len(pcm) / float(self.config.sample_rate * self.config.channels * 2)
        LOGGER.info("VAD queued segment=%s duration=%.3fs", segment_id, duration_s)
        await self._events.put(
            TranscriptEvent(
                type="state",
                session_id=self._session_id,
                segment_id=segment_id,
                message="segment_detected",
            )
        )
        await self._segments.put((segment_id, pcm))

    async def send_audio(self, pcm: bytes) -> None:
        if self._vad is None:
            raise RuntimeError("VAD is not initialized")
        for segment in self._vad.push(pcm):
            await self._queue_segment(segment)

    def _wav_bytes(self, pcm: bytes) -> bytes:
        output = io.BytesIO()
        with wave.open(output, "wb") as wav:
            wav.setnchannels(self.config.channels)
            wav.setsampwidth(2)
            wav.setframerate(self.config.sample_rate)
            wav.writeframes(pcm)
        return output.getvalue()

    def _request_data(self) -> dict[str, str]:
        data = {"model": self.config.model, "stream": "true"}
        if self.config.language:
            data["language"] = self.config.language
        return data

    def _pad_segment(self, pcm: bytes) -> bytes:
        tail_samples = round(self.config.sample_rate * self.config.trailing_silence_ms / 1000)
        return pcm + bytes(tail_samples * self.config.channels * 2)

    async def _segment_worker(self) -> None:
        while True:
            item = await self._segments.get()
            if item is None:
                return
            segment_id, pcm = item
            try:
                await self._transcribe_segment(segment_id, pcm)
            except Exception as exc:
                self._worker_error = exc
                await self._events.put(
                    TranscriptEvent(type="error", session_id=self._session_id, message=str(exc))
                )
                return

    async def _transcribe_segment(self, segment_id: str, pcm: bytes) -> None:
        if self._http is None:
            raise RuntimeError("ASR client is not connected")
        data = self._request_data()
        padded_pcm = self._pad_segment(pcm)
        files = {
            "file": (
                f"{self._session_id}-{segment_id}.wav",
                self._wav_bytes(padded_pcm),
                "audio/wav",
            )
        }
        LOGGER.info(
            "ASR submit segment=%s language=%s tail=%sms",
            segment_id,
            self.config.language or "<model-default>",
            self.config.trailing_silence_ms,
        )
        accumulated = ""
        async with self._http.stream(
            "POST",
            self.config.stream_url,
            data=data,
            files=files,
            headers={"Accept": "text/event-stream"},
        ) as response:
            response.raise_for_status()
            content_type = response.headers.get("content-type", "")
            if "text/event-stream" not in content_type:
                raise RuntimeError(f"expected SSE response, got {content_type or 'unknown content type'}")
            data_lines: list[str] = []
            async for line in response.aiter_lines():
                if line.startswith("data:"):
                    data_lines.append(line[5:].strip())
                    continue
                if line or not data_lines:
                    continue
                payload = "\n".join(data_lines)
                data_lines.clear()
                event, accumulated, done = normalize_sse_payload(
                    payload,
                    accumulated,
                    self._session_id,
                    segment_id,
                )
                if event is not None and event.type == "final":
                    LOGGER.info(
                        "ASR done segment=%s final_chars=%s text=%r",
                        segment_id,
                        len(event.text),
                        event.text[:80],
                    )
                if event is not None and (event.type != "final" or bool(event.text.strip())):
                    await self._events.put(event)
                if done:
                    if not accumulated.strip():
                        LOGGER.warning(
                            "ASR segment=%s produced NO text ([DONE] with empty accumulator) "
                            "-- server returned empty transcript for this segment",
                            segment_id,
                        )
                    break

    async def finish_session(self) -> None:
        if self._vad is None:
            raise RuntimeError("VAD is not initialized")
        for segment in self._vad.flush():
            await self._queue_segment(segment)
        await self._segments.put(None)
        if self._worker_task is not None:
            await self._worker_task
            self._worker_task = None
        await self._events.put(None)
        if self._worker_error is not None:
            raise RuntimeError(str(self._worker_error)) from self._worker_error

    async def events(self) -> AsyncIterator[TranscriptEvent]:
        while True:
            event = await self._events.get()
            if event is None:
                return
            yield event

    async def _close_http(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def close(self) -> None:
        if self._worker_task is not None:
            self._worker_task.cancel()
            await asyncio.gather(self._worker_task, return_exceptions=True)
            self._worker_task = None
        if self._vad is not None:
            self._vad.reset()
        await self._close_http()
        await self._events.put(None)
