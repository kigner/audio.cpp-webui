import torch

from app.config import VadConfig
from app.vad import SileroVadSegmenter


class FakeVadModel:
    def __init__(self, probabilities: list[float]) -> None:
        self.probabilities = iter(probabilities)

    def reset_states(self) -> None:
        pass

    def __call__(self, audio: torch.Tensor, sample_rate: int) -> torch.Tensor:
        assert len(audio) == 512
        assert sample_rate == 16000
        return torch.tensor(next(self.probabilities))


def make_segmenter(probabilities: list[float]) -> SileroVadSegmenter:
    return SileroVadSegmenter(
        VadConfig(
            threshold=0.5,
            min_speech_duration_ms=32,
            min_silence_duration_ms=64,
            speech_pad_ms=0,
            max_speech_duration_s=20,
        ),
        model=FakeVadModel(probabilities),
    )


def test_silence_closes_and_returns_a_speech_segment() -> None:
    segmenter = make_segmenter([0.0, 0.9, 0.9, 0.0, 0.0, 0.0])
    window = (b"\x10\x00" * 512)
    segments: list[bytes] = []
    for _ in range(6):
        segments.extend(segmenter.push(window))
    assert len(segments) == 1
    assert len(segments[0]) >= 512 * 2


def test_flush_submits_active_speech_without_trailing_silence() -> None:
    segmenter = make_segmenter([0.0, 0.9, 0.9])
    window = (b"\x10\x00" * 512)
    for _ in range(3):
        assert segmenter.push(window) == []
    segments = segmenter.flush()
    assert len(segments) == 1
    assert len(segments[0]) == 1024 * 2

