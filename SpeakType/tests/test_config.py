import json

import pytest

from app.config import load_config


def test_default_project_config_is_local_only() -> None:
    config = load_config("config.json")
    assert config.asr.base_url == "http://127.0.0.1:8081"
    assert config.asr.model == "nemotron-asr"
    assert config.asr.input_gain_db == 18.0
    assert config.vad.threshold == 0.35
    assert config.ui.host == "127.0.0.1"


def test_non_loopback_asr_url_is_rejected(tmp_path) -> None:
    value = {
        "asr": {
            "base_url": "https://example.com",
            "stream_url": "https://example.com/v1/audio/transcriptions",
        }
    }
    path = tmp_path / "config.json"
    path.write_text(json.dumps(value), encoding="utf-8")
    with pytest.raises(ValueError, match="127.0.0.1"):
        load_config(path)


def test_excessive_input_gain_is_rejected(tmp_path) -> None:
    value = {"asr": {"input_gain_db": 31.0}}
    path = tmp_path / "config.json"
    path.write_text(json.dumps(value), encoding="utf-8")

    with pytest.raises(ValueError, match="input_gain_db"):
        load_config(path)


def test_legacy_vad_defaults_migrate_without_overwriting_user_config(tmp_path) -> None:
    legacy_path = tmp_path / "legacy.json"
    legacy_path.write_text(
        json.dumps(
            {
                "vad": {
                    "threshold": 0.5,
                    "min_speech_duration_ms": 250,
                    "min_silence_duration_ms": 500,
                    "speech_pad_ms": 160,
                }
            }
        ),
        encoding="utf-8",
    )
    migrated = load_config(legacy_path)
    assert migrated.vad.threshold == 0.35
    assert migrated.vad.min_speech_duration_ms == 200
    assert migrated.vad.min_silence_duration_ms == 450
    assert migrated.vad.speech_pad_ms == 160

    custom_path = tmp_path / "custom.json"
    custom_path.write_text(json.dumps({"vad": {"threshold": 0.42}}), encoding="utf-8")
    custom = load_config(custom_path)
    assert custom.vad.threshold == 0.42
    assert custom.vad.min_speech_duration_ms == 200
