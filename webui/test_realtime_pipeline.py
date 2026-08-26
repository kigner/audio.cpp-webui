import base64
import json
import queue
import threading
import unittest

import numpy as np
from fastapi.testclient import TestClient

from realtime_pipeline import (
    CancelScope,
    RealtimePipeline,
    ResponseDone,
    SpeechStopped,
    TurnDiscarded,
    UserTranscript,
    _StreamingPcm16Resampler,
    _TTSStage,
)
from realtime_server import _resolve_tts_config, create_app


class _CancelScope:
    generation = 1

    def __init__(self, stale: bool = False):
        self._stale = stale

    def is_stale(self, generation: int) -> bool:
        return self._stale


class _STT:
    def __init__(self, text: str):
        self._text = text

    def transcribe(self, audio: np.ndarray) -> str:
        return self._text


class _LLM:
    def __init__(self):
        self.user_messages: list[str] = []

    def add_user_message(self, text: str) -> None:
        self.user_messages.append(text)

    def add_assistant_message(self, text: str) -> None:
        pass

    def stream(self, cancel_scope: _CancelScope, generation: int):
        return iter(())


class _SingleTurnQueue:
    def __init__(self, turn: SpeechStopped, stop_event: threading.Event):
        self._turn = turn
        self._stop_event = stop_event

    def get(self, timeout: float) -> SpeechStopped:
        self._stop_event.set()
        return self._turn


def _pipeline_for_transcript(text: str) -> RealtimePipeline:
    pipeline = RealtimePipeline.__new__(RealtimePipeline)
    pipeline._out_events = queue.Queue()
    pipeline._cancel_scope = _CancelScope()
    pipeline._stt = _STT(text)
    pipeline._llm = _LLM()
    pipeline._cfg_lock = threading.Lock()
    pipeline._tts_model = "unused"
    pipeline._tts_voice = ""
    pipeline._tts_voice_ref = ""
    pipeline._tts_reference_text = ""
    pipeline._tts_streaming = False
    pipeline._tts_stream_sample_rate = 0
    pipeline._tts_options = {}
    pipeline._tts_lock = threading.Lock()
    pipeline._tts_pending = 0
    pipeline._stop_event = threading.Event()
    return pipeline


class RealtimeTurnLifecycleTests(unittest.TestCase):
    def test_too_short_segment_discards_turn(self):
        pipeline = RealtimePipeline.__new__(RealtimePipeline)
        pipeline._out_events = queue.Queue()
        pipeline._stop_event = threading.Event()
        pipeline._turn_queue = _SingleTurnQueue(
            SpeechStopped(audio=np.zeros(100, dtype=np.float32)),
            pipeline._stop_event,
        )

        pipeline._pipeline_loop()

        self.assertEqual(
            pipeline.drain_events(),
            [TurnDiscarded(reason="too_short")],
        )

    def test_empty_transcript_discards_turn_without_starting_llm(self):
        pipeline = _pipeline_for_transcript("")

        pipeline._run_turn(np.zeros(16000, dtype=np.float32))

        events = pipeline.drain_events()
        self.assertEqual(events, [TurnDiscarded(reason="empty_transcript")])
        self.assertEqual(pipeline._llm.user_messages, [])

    def test_successful_transcript_keeps_existing_response_lifecycle(self):
        pipeline = _pipeline_for_transcript("hello")

        pipeline._run_turn(np.zeros(16000, dtype=np.float32))

        events = pipeline.drain_events()
        self.assertEqual(events, [UserTranscript(text="hello"), ResponseDone()])
        self.assertEqual(pipeline._llm.user_messages, ["hello"])


class StreamingPcmTests(unittest.TestCase):
    def test_resampler_is_continuous_across_transport_deltas(self):
        source = np.linspace(-20000, 20000, 4800, dtype=np.int16).tobytes()

        one_shot = _StreamingPcm16Resampler(48000)
        expected = one_shot.process(source) + one_shot.process(b"", final=True)

        chunked = _StreamingPcm16Resampler(48000)
        parts = []
        for start in range(0, len(source), 1994):
            parts.append(chunked.process(source[start:start + 1994]))
        parts.append(chunked.process(b"", final=True))

        actual = b"".join(parts)
        self.assertEqual(actual, expected)
        self.assertEqual(len(actual), 1600 * 2)

    def test_tts_stream_posts_sse_and_returns_16k_pcm(self):
        pcm = np.arange(0, 3072, dtype=np.int16).tobytes()
        events = [
            {"type": "speech.audio.delta", "audio": base64.b64encode(pcm).decode("ascii")},
            {"type": "speech.audio.done", "timing": {"ttft_ms": 12}},
        ]

        class Response:
            status_code = 200
            text = ""

            def __init__(self):
                self.closed = False

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.close()

            def close(self):
                self.closed = True

            def iter_lines(self, decode_unicode=True):
                for event in events:
                    yield "data: " + json.dumps(event)
                    yield ""
                yield "data: [DONE]"
                yield ""

        class Session:
            def __init__(self):
                self.kwargs = None

            def post(self, *_args, **kwargs):
                self.kwargs = kwargs
                return Response()

        stage = _TTSStage("http://127.0.0.1:8088")
        stage._http = Session()
        scope = CancelScope()
        output = b"".join(stage.synthesize_stream(
            "hello", "dots-tts-meanflow", 48000, scope, scope.generation,
            options={"num_inference_steps": 4},
        ))

        self.assertEqual(len(output), 1024 * 2)
        self.assertTrue(stage._http.kwargs["stream"])
        self.assertEqual(stage._http.kwargs["json"]["stream_format"], "sse")
        self.assertEqual(
            stage._http.kwargs["json"]["options"]["num_inference_steps"], 4)


class RealtimeTtsConfigTests(unittest.TestCase):
    @staticmethod
    def _models():
        return [{
            "id": "dots-tts-meanflow",
            "supports_streaming": True,
            "stream_sample_rate": 48000,
            "realtime_defaults": {"num_inference_steps": 4, "vocoder_merge_steps": 2},
        }, {
            "id": "qwen3-tts",
            "supports_streaming": False,
            "stream_sample_rate": 0,
        }]

    def test_auto_selects_streaming_only_for_capable_model(self):
        streaming = _resolve_tts_config({
            "tts_model": "dots-tts-meanflow",
            "tts_server_source": "managed",
            "tts_playback_mode": "auto",
            "tts_options": {"vocoder_merge_steps": 4},
        }, self._models)
        offline = _resolve_tts_config({
            "tts_model": "qwen3-tts",
            "tts_server_source": "managed",
            "tts_playback_mode": "auto",
        }, self._models)

        self.assertTrue(streaming["tts_streaming"])
        self.assertEqual(streaming["tts_stream_sample_rate"], 48000)
        self.assertEqual(streaming["tts_options"], {
            "num_inference_steps": 4,
            "vocoder_merge_steps": 4,
        })
        self.assertFalse(offline["tts_streaming"])

    def test_forced_streaming_rejects_offline_model(self):
        with self.assertRaisesRegex(ValueError, "does not support streaming"):
            _resolve_tts_config({
                "tts_model": "qwen3-tts",
                "tts_server_source": "managed",
                "tts_playback_mode": "streaming",
            }, self._models)

    def test_activate_loads_managed_model_in_resolved_mode(self):
        calls = []

        def loader(model_id, mode):
            calls.append((model_id, mode))
            return "loaded"

        client = TestClient(create_app(self._models, loader))
        response = client.post("/activate", json={
            "tts_model": "dots-tts-meanflow",
            "tts_server_source": "managed",
            "tts_playback_mode": "auto",
            "tts_options": {"vocoder_merge_steps": 2},
        })

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["tts_streaming"])
        self.assertEqual(calls, [("dots-tts-meanflow", "streaming")])


if __name__ == "__main__":
    unittest.main()
