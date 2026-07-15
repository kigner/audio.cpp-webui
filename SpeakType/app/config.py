from __future__ import annotations

import json
import socket
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urljoin, urlparse


@dataclass(frozen=True)
class AsrConfig:
    base_url: str = "http://127.0.0.1:8081"
    model: str = "nemotron-asr"
    language: str = "auto"
    transport: str = "streaming"
    stream_url: str = "http://127.0.0.1:8081/v1/audio/transcriptions"
    transcription_path: str = "/v1/audio/transcriptions"
    sample_rate: int = 16000
    channels: int = 1
    sample_format: str = "pcm_s16le"
    frame_ms: int = 20
    trailing_silence_ms: int = 400
    connect_timeout_s: float = 3.0
    final_timeout_s: float = 30.0

    @property
    def transcription_url(self) -> str:
        return urljoin(self.base_url.rstrip("/") + "/", self.transcription_path.lstrip("/"))


@dataclass(frozen=True)
class VadConfig:
    threshold: float = 0.5
    min_speech_duration_ms: int = 250
    min_silence_duration_ms: int = 500
    speech_pad_ms: int = 160
    max_speech_duration_s: float = 20.0


@dataclass(frozen=True)
class UiConfig:
    host: str = "127.0.0.1"
    port: int = 8765
    width: int = 900
    height: int = 170
    bottom_margin: int = 70
    always_on_top: bool = True
    click_through: bool = False


@dataclass(frozen=True)
class HotkeyConfig:
    toggle_recording: str = "ctrl+alt+space"
    cancel_current: str = "esc"


@dataclass(frozen=True)
class InjectionConfig:
    method: str = "clipboard_paste"
    restore_clipboard: bool = True
    restore_delay_ms: int = 250


@dataclass(frozen=True)
class DemoConfig:
    mock: bool = False
    mock_text: str = "这个模型支持本地流式语音识别，所有推理都在您的电脑上完成。"


@dataclass(frozen=True)
class AppConfig:
    asr: AsrConfig = field(default_factory=AsrConfig)
    vad: VadConfig = field(default_factory=VadConfig)
    ui: UiConfig = field(default_factory=UiConfig)
    hotkeys: HotkeyConfig = field(default_factory=HotkeyConfig)
    injection: InjectionConfig = field(default_factory=InjectionConfig)
    demo: DemoConfig = field(default_factory=DemoConfig)


def _assert_loopback_url(value: str, label: str) -> None:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError(f"{label} must use http or https")
    try:
        address = socket.gethostbyname(parsed.hostname or "")
    except OSError as exc:
        raise ValueError(f"{label} has an invalid host") from exc
    if address != "127.0.0.1":
        raise ValueError(f"{label} must point to 127.0.0.1")


def load_config(path: str | Path) -> AppConfig:
    config_path = Path(path)
    raw = json.loads(config_path.read_text(encoding="utf-8"))
    config = AppConfig(
        asr=AsrConfig(**raw.get("asr", {})),
        vad=VadConfig(**raw.get("vad", {})),
        ui=UiConfig(**raw.get("ui", {})),
        hotkeys=HotkeyConfig(**raw.get("hotkeys", {})),
        injection=InjectionConfig(**raw.get("injection", {})),
        demo=DemoConfig(**raw.get("demo", {})),
    )
    _assert_loopback_url(config.asr.base_url, "asr.base_url")
    if config.asr.stream_url:
        _assert_loopback_url(config.asr.stream_url, "asr.stream_url")
    if config.ui.host != "127.0.0.1":
        raise ValueError("ui.host must be 127.0.0.1")
    if config.asr.sample_format != "pcm_s16le":
        raise ValueError("only pcm_s16le audio is supported")
    if config.asr.channels != 1:
        raise ValueError("only mono audio is supported")
    if config.asr.trailing_silence_ms < 0:
        raise ValueError("asr.trailing_silence_ms must not be negative")
    if not 0.0 < config.vad.threshold < 1.0:
        raise ValueError("vad.threshold must be between 0 and 1")
    return config
