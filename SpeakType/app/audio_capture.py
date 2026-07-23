from __future__ import annotations

import logging
import queue
import sys
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
        self._resample_source_rate = sample_rate
        self._resample_buffer = np.empty(0, dtype=np.float32)
        self._resample_position = 0.0

    @property
    def active(self) -> bool:
        return self._stream is not None and self._stream.active

    @staticmethod
    def _preferred_input_device() -> tuple[int | None, object]:
        if sys.platform == "win32":
            for hostapi in sd.query_hostapis():
                if str(hostapi["name"]).casefold() != "windows wasapi":
                    continue
                device_index = int(hostapi["default_input_device"])
                if device_index >= 0:
                    return device_index, sd.query_devices(device_index)
        return None, sd.query_devices(kind="input")

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
        device_index, device = self._preferred_input_device()
        native_rate = int(round(float(device["default_samplerate"])))
        self._capture_rate = native_rate
        sd.check_input_settings(
            device=device_index,
            channels=self.channels,
            dtype="int16",
            samplerate=self._capture_rate,
        )
        blocksize = max(1, round(self._capture_rate * self.frame_ms / 1000))
        self._stream = sd.RawInputStream(
            device=device_index,
            samplerate=self._capture_rate,
            blocksize=blocksize,
            channels=self.channels,
            dtype="int16",
            callback=self._callback,
        )
        self._stream.start()
        hostapi = sd.query_hostapis(int(device["hostapi"]))
        LOGGER.info(
            "microphone opened device=%s name=%r hostapi=%s capture_rate=%s output_rate=%s",
            device_index if device_index is not None else "<default>",
            device["name"],
            hostapi["name"],
            self._capture_rate,
            self.sample_rate,
        )

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
                break
        self._resample_source_rate = self.sample_rate
        self._resample_buffer = np.empty(0, dtype=np.float32)
        self._resample_position = 0.0

    def _resample(self, pcm: bytes, source_rate: int) -> bytes:
        if source_rate == self.sample_rate:
            return pcm
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
        if source_rate != self._resample_source_rate:
            self._resample_source_rate = source_rate
            self._resample_buffer = np.empty(0, dtype=np.float32)
            self._resample_position = 0.0
        if self._resample_buffer.size:
            samples = np.concatenate((self._resample_buffer, samples))
        if samples.size < 2:
            self._resample_buffer = samples
            return b""

        step = source_rate / float(self.sample_rate)
        positions = np.arange(self._resample_position, samples.size - 1, step, dtype=np.float64)
        if positions.size == 0:
            self._resample_buffer = samples
            return b""
        resampled = np.interp(positions, np.arange(samples.size), samples)
        next_position = float(positions[-1] + step)
        consumed = min(int(np.floor(next_position)), samples.size)
        self._resample_buffer = samples[consumed:]
        self._resample_position = next_position - consumed
        return np.clip(resampled, -32768, 32767).astype("<i2").tobytes()

    def get_frame(self, timeout: float = 0.1) -> bytes | None:
        try:
            pcm, source_rate = self._queue.get(timeout=timeout)
        except queue.Empty:
            return None
        return self._resample(pcm, source_rate)
