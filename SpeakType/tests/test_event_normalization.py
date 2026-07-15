import json

from app.asr.streaming import normalize_sse_payload


def test_delta_events_are_accumulated_into_partial_text() -> None:
    first, text, done = normalize_sse_payload(
        json.dumps({"type": "transcript.text.delta", "delta": "本地"}),
        "",
        "session-a",
        "1",
    )
    assert first is not None
    assert first.type == "partial"
    assert first.text == "本地"
    assert done is False

    second, text, done = normalize_sse_payload(
        json.dumps({"type": "transcript.text.delta", "delta": "识别"}),
        text,
        "session-a",
        "1",
    )
    assert second is not None
    assert second.text == "本地识别"
    assert done is False


def test_done_event_normalizes_final_and_latency() -> None:
    event, text, done = normalize_sse_payload(
        json.dumps(
            {
                "type": "transcript.text.done",
                "text": "最终文本。",
                "timing": {"ttft_ms": 146.4},
            }
        ),
        "最终文本",
        "session-a",
        "2",
    )
    assert event is not None
    assert event.type == "final"
    assert event.text == "最终文本。"
    assert event.latency_ms == 146
    assert event.session_id == "session-a"
    assert event.segment_id == "2"
    assert text == "最终文本。"
    assert done is False


def test_sse_done_marker_ends_stream() -> None:
    event, text, done = normalize_sse_payload("[DONE]", "完成", "s", "1")
    assert event is None
    assert text == "完成"
    assert done is True

