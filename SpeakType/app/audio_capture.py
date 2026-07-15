from __future__ import annotations

import logging
import queue
import time

import numpy as np
import sounddevice as sd


LOGGER = logging.getLogger(__name__)


class AudioCapture:
    def __init__(self, sample_rate: int, channels: int, frame_ms: int, queue_seconds: float = 2.0) -> None:
        self.sample_rate = sample_rate
        self.channels = channels
        self.frame_ms = frame_ms
        self._queue: queue.Queue[tuple[bytes, int]] = queue.Queue(
            maxsize=max(8, round(queue_seconds * 1000 / frame_ms))
        )
        self._stream: sd.RawInputStream | None = None
        self._capture_rate = sample_rate
        self._last_drop_log = 0.0

    @property
    def active(self) -> bool:
        return self._stream is not None and self._stream.active

    def _callback(self, indata: bytes, frames: int, time_info: object, status: sd.CallbackFlags) -> None:
        del frames, time_info
        frame = (bytes(indata), self._capture_rate)
        if status:
            LOGGER.warning("audio callback status: %s", status)
        try:
            self._queue.put_nowait(frame)
        except queue.Full:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self._queue.put_nowait(frame)
            except queue.Full:
                pass
            now = time.monotonic()
            if now - self._last_drop_log > 1.0:
                LOGGER.warning("audio queue full; dropped oldest frame")
                self._last_drop_log = now

    def start(self) -> None:
        self.stop()
        self.clear()
        device = sd.query_devices(kind="input")
        native_rate = int(round(float(device["default_samplerate"])))
        try:
            sd.check_input_settings(channels=self.channels, dtype="int16", samplerate=self.sample_rate)
            self._capture_rate = self.sample_rate
        except sd.PortAudioError:
            self._capture_rate = native_rate
            LOGGER.info("microphone does not accept %s Hz; capturing at %s Hz", self.sample_rate, native_rate)
        blocksize = max(1, round(self._capture_rate * self.frame_ms / 1000))
        self._stream = sd.RawInputStream(
            samplerate=self._capture_rate,
            blocksize=blocksize,
            channels=self.channels,
            dtype="int16",
            callback=self._callback,
        )
        self._stream.start()

    def stop(self) -> None:
        stream, self._stream = self._stream, None
        if stream is not None:
            try:
                stream.stop()
            finally:
                stream.close()

    def clear(self) -> None:
        while True:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                return

    def get_frame(self, timeout: float = 0.1) -> bytes | None:
        try:
            pcm, source_rate = self._queue.get(timeout=timeout)
        except queue.Empty:
            return None
        if source_rate == self.sample_rate:
            return pcm
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
        if samples.size < 2:
            return pcm
        output_size = max(1, round(samples.size * self.sample_rate / source_rate))
        positions = np.linspace(0, samples.size - 1, output_size)
        resampled = np.interp(positions, np.arange(samples.size), samples)
        return np.clip(resampled, -32768, 32767).astype("<i2").tobytes()

