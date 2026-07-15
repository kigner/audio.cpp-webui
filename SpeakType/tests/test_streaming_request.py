from app.asr.streaming import StreamingAsrClient
from app.config import AsrConfig, VadConfig


def test_auto_language_is_sent_explicitly() -> None:
    client = StreamingAsrClient(AsrConfig(language="auto"), VadConfig())
    assert client._request_data() == {  # noqa: SLF001
        "model": "nemotron-asr",
        "stream": "true",
        "language": "auto",
    }


def test_segment_gets_configured_trailing_silence() -> None:
    config = AsrConfig(sample_rate=16000, channels=1, trailing_silence_ms=400)
    client = StreamingAsrClient(config, VadConfig())
    speech = b"\x01\x00" * 1600
    padded = client._pad_segment(speech)  # noqa: SLF001
    assert padded.startswith(speech)
    assert len(padded) == len(speech) + 16000 * 400 // 1000 * 2
    assert set(padded[len(speech) :]) == {0}
