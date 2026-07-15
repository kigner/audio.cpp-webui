from __future__ import annotations

import asyncio
import io
import wave
from typing import AsyncIterator

import httpx

from app.config import AsrConfig

from .base import TranscriptEvent


class OpenAiTranscriptionsClient:
    """Non-streaming OpenAI-compatible transcription fallback."""

    def __init__(self, config: AsrConfig) -> None:
        self.config = config
        self._http: httpx.AsyncClient | None = None
        self._session_id = ""
        self._segment_number = 0
        self._pcm = bytearray()
        self._events: asyncio.Queue[TranscriptEvent | None] = asyncio.Queue()

    async def connect(self) -> None:
        if self._http is not None:
            await self._http.aclose()
        self._http = httpx.AsyncClient(
            base_url=self.config.base_url,
            timeout=httpx.Timeout(self.config.final_timeout_s, connect=self.config.connect_timeout_s),
            trust_env=False,
        )
        response = await self._http.get("/health")
        response.raise_for_status()

    async def start_session(self, session_id: str) -> None:
        self._session_id = session_id
        self._segment_number += 1
        self._pcm.clear()
        self._events = asyncio.Queue()

    async def send_audio(self, pcm: bytes) -> None:
        self._pcm.extend(pcm)

    def _wav_bytes(self) -> bytes:
        output = io.BytesIO()
        with wave.open(output, "wb") as wav:
            wav.setnchannels(self.config.channels)
            wav.setsampwidth(2)
            wav.setframerate(self.config.sample_rate)
            wav.writeframes(self._pcm)
        return output.getvalue()

    async def finish_session(self) -> None:
        if self._http is None:
            raise RuntimeError("ASR client is not connected")
        data: dict[str, str] = {"model": self.config.model}
        if self.config.language:
            data["language"] = self.config.language
        try:
            response = await self._http.post(
                self.config.transcription_url,
                data=data,
                files={"file": (f"{self._session_id}.wav", self._wav_bytes(), "audio/wav")},
            )
            response.raise_for_status()
            text = str(response.json().get("text", ""))
            await self._events.put(
                TranscriptEvent(
                    type="final",
                    text=text,
                    session_id=self._session_id,
                    segment_id=str(self._segment_number),
                )
            )
        except Exception as exc:
            await self._events.put(TranscriptEvent(type="error", session_id=self._session_id, message=str(exc)))
            raise
        finally:
            self._pcm.clear()
            await self._events.put(None)

    async def events(self) -> AsyncIterator[TranscriptEvent]:
        while True:
            event = await self._events.get()
            if event is None:
                return
            yield event

    async def close(self) -> None:
        self._pcm.clear()
        if self._http is not None:
            await self._http.aclose()
            self._http = None
        await self._events.put(None)
