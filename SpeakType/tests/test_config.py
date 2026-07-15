import json

import pytest

from app.config import load_config


def test_default_project_config_is_local_only() -> None:
    config = load_config("config.json")
    assert config.asr.base_url == "http://127.0.0.1:8081"
    assert config.asr.model == "nemotron-asr"
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

