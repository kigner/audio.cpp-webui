from __future__ import annotations

from dataclasses import dataclass
from typing import AsyncIterator, Protocol


@dataclass(frozen=True)
class TranscriptEvent:
    type: str
    text: str = ""
    session_id: str = ""
    segment_id: str = ""
    latency_ms: int | None = None
    message: str = ""


class AsrClient(Protocol):
    async def connect(self) -> None: ...
    async def start_session(self, session_id: str) -> None: ...
    async def send_audio(self, pcm: bytes) -> None: ...
    async def finish_session(self) -> None: ...
    async def events(self) -> AsyncIterator[TranscriptEvent]: ...
    async def close(self) -> None: ...

