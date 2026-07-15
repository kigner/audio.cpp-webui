from __future__ import annotations

import os
import sys
from collections.abc import Callable

import numpy as np
import torch

# Resolve `silero_vad` to the copy vendored under SpeakType/third_party so the demo
# stays self-contained and offline (no pip `silero-vad` in the shared portable venv).
# The vendored tree carries a full `silero_vad` package plus the jit weights in src/.
_VENDORED_SILERO = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "third_party", "silero-vad", "src"
)
if os.path.isdir(_VENDORED_SILERO) and _VENDORED_SILERO not in sys.path:
    sys.path.insert(0, _VENDORED_SILERO)

from silero_vad import VADIterator, load_silero_vad  # noqa: E402  (after sys.path setup)

from app.config import VadConfig


class SileroVadSegmenter:
    """Incremental Silero VAD that returns complete PCM utterance segments."""

    WINDOW_SAMPLES = 512

    def __init__(
        self,
        config: VadConfig,
        sample_rate: int = 16000,
        model: Callable[[torch.Tensor, int], torch.Tensor] | None = None,
    ) -> None:
        if sample_rate != 16000:
            raise ValueError("Silero VAD segmenter expects resampled 16 kHz audio")
        self.config = config
        self.sample_rate = sample_rate
        self.model = model if model is not None else load_silero_vad()
        self._iterator = VADIterator(
            self.model,
            threshold=config.threshold,
            sampling_rate=sample_rate,
            min_silence_duration_ms=config.min_silence_duration_ms,
            speech_pad_ms=config.speech_pad_ms,
        )
        self._pending = bytearray()
        self._audio = bytearray()
        self._base_sample = 0
        self._speech_start: int | None = None

    def reset(self) -> None:
        self._iterator.reset_states()
        self._pending.clear()
        self._audio.clear()
        self._base_sample = 0
        self._speech_start = None

    @staticmethod
    def _tensor(pcm: bytes) -> torch.Tensor:
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        return torch.from_numpy(samples)

    def _slice(self, start_sample: int, end_sample: int) -> bytes:
        relative_start = max(0, start_sample - self._base_sample)
        relative_end = max(relative_start, end_sample - self._base_sample)
        return bytes(self._audio[relative_start * 2 : relative_end * 2])

    def _trim_before(self, sample: int) -> None:
        count = max(0, sample - self._base_sample)
        if count:
            del self._audio[: count * 2]
            self._base_sample += count

    def _minimum_samples(self) -> int:
        return round(self.sample_rate * self.config.min_speech_duration_ms / 1000)

    def _process_window(self, pcm: bytes) -> list[bytes]:
        segments: list[bytes] = []
        self._audio.extend(pcm)
        event = self._iterator(self._tensor(pcm))
        current_sample = self._iterator.current_sample

        if event and "start" in event:
            self._speech_start = int(event["start"])
        if event and "end" in event and self._speech_start is not None:
            end_sample = int(event["end"])
            segment = self._slice(self._speech_start, end_sample)
            if len(segment) // 2 >= self._minimum_samples():
                segments.append(segment)
            self._speech_start = None
            self._trim_before(end_sample)

        if self._speech_start is not None:
            max_samples = round(self.sample_rate * self.config.max_speech_duration_s)
            if current_sample - self._speech_start >= max_samples:
                segment = self._slice(self._speech_start, current_sample)
                if len(segment) // 2 >= self._minimum_samples():
                    segments.append(segment)
                self.reset()
                return segments
        else:
            keep_samples = int(self._iterator.speech_pad_samples) + self.WINDOW_SAMPLES
            self._trim_before(max(self._base_sample, current_sample - keep_samples))
        return segments

    def push(self, pcm: bytes) -> list[bytes]:
        self._pending.extend(pcm)
        segments: list[bytes] = []
        window_bytes = self.WINDOW_SAMPLES * 2
        while len(self._pending) >= window_bytes:
            window = bytes(self._pending[:window_bytes])
            del self._pending[:window_bytes]
            segments.extend(self._process_window(window))
        return segments

    def flush(self) -> list[bytes]:
        segments: list[bytes] = []
        if self._speech_start is not None:
            self._audio.extend(self._pending)
            end_sample = self._base_sample + len(self._audio) // 2
            segment = self._slice(self._speech_start, end_sample)
            if len(segment) // 2 >= self._minimum_samples():
                segments.append(segment)
        self.reset()
        return segments
