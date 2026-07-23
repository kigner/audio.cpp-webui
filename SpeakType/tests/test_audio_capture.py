from __future__ import annotations

import sys

import numpy as np

from app.audio_capture import AudioCapture


def test_windows_prefers_wasapi_default_input(monkeypatch) -> None:
    hostapis = (
        {"name": "MME", "default_input_device": 1},
        {"name": "Windows WASAPI", "default_input_device": 12},
    )
    devices = {
        12: {
            "name": "WASAPI microphone",
            "hostapi": 1,
            "default_samplerate": 48000.0,
        }
    }
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr("app.audio_capture.sd.query_hostapis", lambda *args: hostapis)
    monkeypatch.setattr("app.audio_capture.sd.query_devices", lambda index=None, **kwargs: devices[index])

    index, device = AudioCapture._preferred_input_device()  # noqa: SLF001

    assert index == 12
    assert device["name"] == "WASAPI microphone"


def test_streaming_resample_preserves_rate_and_chunk_continuity() -> None:
    capture = AudioCapture(sample_rate=16000, channels=1, frame_ms=20)
    source_rate = 48000
    source = (np.sin(np.arange(source_rate // 10) * 2 * np.pi * 440 / source_rate) * 12000).astype("<i2")

    output = bytearray()
    chunk_samples = source_rate * capture.frame_ms // 1000
    for offset in range(0, source.size, chunk_samples):
        output.extend(capture._resample(source[offset : offset + chunk_samples].tobytes(), source_rate))  # noqa: SLF001

    resampled = np.frombuffer(output, dtype="<i2")
    assert resampled.size == 1600
    assert np.max(np.abs(np.diff(resampled.astype(np.int32)))) < 2500
