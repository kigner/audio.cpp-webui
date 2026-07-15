from __future__ import annotations

import asyncio
from typing import AsyncIterator

from .base import TranscriptEvent


class MockAsrClient:
    def __init__(self, text: str, sample_rate: int = 16000) -> None:
        self.text = text
        self.sample_rate = sample_rate
        self._session_id = ""
        self._segment_number = 0
        self._audio_bytes = 0
        self._revealed = 0
        self._events: asyncio.Queue[TranscriptEvent | None] = asyncio.Queue()

    async def connect(self) -> None:
        await asyncio.sleep(0.08)

    async def start_session(self, session_id: str) -> None:
        self._session_id = session_id
        self._segment_number += 1
        self._audio_bytes = 0
        self._revealed = 0
        self._events = asyncio.Queue()

    async def send_audio(self, pcm: bytes) -> None:
        self._audio_bytes += len(pcm)
        seconds = self._audio_bytes / float(self.sample_rate * 2)
        wanted = min(len(self.text), int(seconds / 0.16) * 2)
        if wanted > self._revealed:
            self._revealed = wanted
            await self._events.put(
                TranscriptEvent(
                    type="partial",
                    text=self.text[: self._revealed],
                    session_id=self._session_id,
                    segment_id=str(self._segment_number),
                )
            )

    async def finish_session(self) -> None:
        while self._revealed < len(self.text):
            self._revealed = min(len(self.text), self._revealed + 3)
            await self._events.put(
                TranscriptEvent(
                    type="partial",
                    text=self.text[: self._revealed],
                    session_id=self._session_id,
                    segment_id=str(self._segment_number),
                )
            )
            await asyncio.sleep(0.09)
        await self._events.put(
            TranscriptEvent(
                type="final",
                text=self.text,
                session_id=self._session_id,
                segment_id=str(self._segment_number),
            )
        )
        await self._events.put(None)

    async def events(self) -> AsyncIterator[TranscriptEvent]:
        while True:
            event = await self._events.get()
            if event is None:
                return
            yield event

    async def close(self) -> None:
        await self._events.put(None)

