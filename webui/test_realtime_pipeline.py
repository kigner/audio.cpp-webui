import base64
import json
import queue
import threading
import unittest
from unittest.mock import Mock, patch

import numpy as np
from fastapi.testclient import TestClient

from realtime_pipeline import (
    AudioChunk,
    AudioSegmentDone,
    CancelScope,
    PipelineError,
    PipelineStageError,
    RealtimePipeline,
    ResponseDone,
    SpeechStopped,
    TurnDiscarded,
    UserTranscript,
    _StreamingPcm16Resampler,
    _TTSStage,
    _VADStage,
    _connection_stage_error,
    _http_stage_error,
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


class RealtimeVadTests(unittest.TestCase):
    def make_vad(self):
        out, turns, cancel = queue.Queue(), queue.Queue(), CancelScope()
        with patch("realtime_pipeline.torch.hub.load", return_value=(Mock(), None)):
            vad = _VADStage(out, turns, cancel, min_silence_ms=64)
        return vad, out, turns, cancel

    def test_quiet_onset_and_brief_detection_gap_reach_asr(self):
        vad, out, turns, cancel = self.make_vad()
        probabilities = [0.1, 0.9, 0.2] + [0.9] * 6 + [0.1, 0.1]
        vad._speech_prob = Mock(side_effect=probabilities)
        audio = np.repeat(np.arange(1, len(probabilities) + 1, dtype=np.int16) * 100, 512)
        vad.add_chunk(audio[:700].tobytes())
        vad.process()
        vad.add_chunk(audio[700:].tobytes())
        vad.process()

        turn = turns.get_nowait()
        np.testing.assert_allclose(turn.audio, audio.astype(np.float32) / 32768.0)
        self.assertEqual(turn.generation, cancel.generation)
        self.assertEqual(out.qsize(), 2)
        self.assertEqual(cancel.generation, 1)

    def test_silence_pre_roll_is_bounded_and_does_not_trigger_a_turn(self):
        vad, out, turns, cancel = self.make_vad()
        vad._speech_prob = Mock(return_value=0.0)
        vad.add_chunk(np.zeros(512 * 100, dtype=np.int16).tobytes())
        vad.process()

        self.assertEqual(len(vad._pre_speech_buf), vad._pre_speech_max)
        self.assertTrue(out.empty())
        self.assertTrue(turns.empty())
        self.assertEqual(cancel.generation, 0)


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


class RealtimeErrorTests(unittest.TestCase):
    def test_http_errors_are_mapped_to_actionable_messages(self):
        llm = _http_stage_error("llm", 401, "Authentication Fails")
        reference = _http_stage_error(
            "tts", 400,
            "Qwen3 base TTS requires voice clone reference audio")
        reference_text = _http_stage_error(
            "tts", 400,
            "F5-TTS requires reference_text")
        asr = _http_stage_error("asr", 404, "model not found")

        self.assertEqual(llm.code, "llm_auth")
        self.assertIn("API Key", llm.message)
        self.assertEqual(reference.code, "tts_reference_audio")
        self.assertIn("Voice ref", reference.message)
        self.assertEqual(reference_text.code, "tts_reference_text")
        self.assertIn("Reference text", reference_text.message)
        self.assertEqual(asr.code, "asr_request")

    def test_connection_errors_identify_the_failed_service(self):
        self.assertEqual(_connection_stage_error("tts", "refused").code, "tts_connection")
        self.assertEqual(_connection_stage_error("asr", "refused").code, "asr_connection")
        self.assertEqual(_connection_stage_error("llm", "timeout").code, "llm_connection")

    def test_pipeline_loop_surfaces_stage_error_to_browser(self):
        class FailingSTT:
            def transcribe(self, _audio):
                raise _connection_stage_error("asr", "connection refused")

        pipeline = _pipeline_for_transcript("")
        pipeline._stt = FailingSTT()
        pipeline._turn_queue = _SingleTurnQueue(
            SpeechStopped(audio=np.zeros(16000, dtype=np.float32)),
            pipeline._stop_event,
        )

        pipeline._pipeline_loop()

        self.assertEqual(pipeline.drain_events(), [
            PipelineError(
                stage="asr",
                code="asr_connection",
                message="无法连接 ASR 服务，请确认服务已启动。",
            ),
            ResponseDone(),
        ])

    def test_tts_worker_surfaces_reference_error(self):
        class TTS:
            def synthesize(self, *_args, **_kwargs):
                raise PipelineStageError(
                    "tts", "tts_reference_audio",
                    "当前 TTS 模型缺少或无法读取参考音频，请检查 Voice ref。")

        pipeline = RealtimePipeline.__new__(RealtimePipeline)
        pipeline._stop_event = threading.Event()
        pipeline._tts_queue = queue.Queue()
        pipeline._tts_queue.put((
            "hello", 0, "qwen3-tts", "", "", "", False, 0, {},
        ))
        pipeline._tts_queue.put(None)
        pipeline._cancel_scope = _CancelScope()
        pipeline._tts = TTS()
        pipeline._out_events = queue.Queue()
        pipeline._tts_lock = threading.Lock()
        pipeline._tts_pending = 1

        pipeline._tts_worker()

        self.assertEqual(pipeline.drain_events(), [PipelineError(
            stage="tts",
            code="tts_reference_audio",
            message="当前 TTS 模型缺少或无法读取参考音频，请检查 Voice ref。",
        )])


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

    def test_tts_worker_keeps_short_final_chunk_and_reports_rtf(self):
        class TTS:
            def synthesize_stream(self, *_args, **_kwargs):
                yield bytes(600 * 2)

        pipeline = RealtimePipeline.__new__(RealtimePipeline)
        pipeline._stop_event = threading.Event()
        pipeline._tts_queue = queue.Queue()
        pipeline._tts_queue.put((
            "hello", 0, "dots-tts-meanflow", "", "", "", True, 48000, {},
        ))
        pipeline._tts_queue.put(None)
        pipeline._cancel_scope = _CancelScope()
        pipeline._tts = TTS()
        pipeline._out_events = queue.Queue()
        pipeline._tts_lock = threading.Lock()
        pipeline._tts_pending = 1

        pipeline._tts_worker()

        events = pipeline.drain_events()
        chunks = [event for event in events if isinstance(event, AudioChunk)]
        metrics = [event for event in events if isinstance(event, AudioSegmentDone)]
        self.assertEqual([len(event.pcm) for event in chunks], [1024, 176])
        self.assertEqual(len(metrics), 1)
        self.assertAlmostEqual(metrics[0].duration_ms, 37.5)
        self.assertGreaterEqual(metrics[0].rtf, 0.0)
        self.assertTrue(metrics[0].streaming)


class RealtimeTextChunkTests(unittest.TestCase):
    def test_default_chunking_keeps_first_sentence_responsive(self):
        chunk, tail = RealtimePipeline._split_speakable("这是第一句。这里是第二句。")

        self.assertEqual(chunk, "这是第一句。")
        self.assertEqual(tail, "这里是第二句。")

    def test_native_stream_chunking_waits_for_larger_followup(self):
        short = "这是第二句。这里是第三句。"
        chunk, tail = RealtimePipeline._split_speakable(
            short, target_chars=120, max_chars=180, eager_sentence=False)

        self.assertIsNone(chunk)
        self.assertEqual(tail, short)

        long_text = "这是第二句。" + ("继续补充内容" * 20) + "。尾部"
        chunk, tail = RealtimePipeline._split_speakable(
            long_text, target_chars=120, max_chars=180, eager_sentence=False)

        self.assertGreaterEqual(len(chunk), 120)
        self.assertTrue(chunk.endswith("。"))
        self.assertEqual(tail, "尾部")

        no_late_boundary = "短句。" + ("连续内容" * 50)
        chunk, tail = RealtimePipeline._split_speakable(
            no_late_boundary, target_chars=120, max_chars=180,
            eager_sentence=False)

        self.assertEqual(len(chunk), 180)
        self.assertTrue(tail)


class RealtimeTtsConfigTests(unittest.TestCase):
    @staticmethod
    def _models():
        return [{
            "id": "dots-tts-meanflow",
            "supports_streaming": True,
            "stream_sample_rate": 48000,
            "realtime_defaults": {"num_inference_steps": 4, "vocoder_merge_steps": 2},
            "realtime_auto_mode": "offline",
        }, {
            "id": "voxcpm2",
            "supports_streaming": True,
            "stream_sample_rate": 48000,
            "realtime_auto_mode": "streaming",
        }, {
            "id": "qwen3-tts",
            "supports_streaming": False,
            "stream_sample_rate": 0,
        }]

    def test_auto_respects_model_realtime_recommendation(self):
        dots = _resolve_tts_config({
            "tts_model": "dots-tts-meanflow",
            "tts_server_source": "managed",
            "tts_playback_mode": "auto",
            "tts_options": {"vocoder_merge_steps": 4},
        }, self._models)
        voxcpm = _resolve_tts_config({
            "tts_model": "voxcpm2",
            "tts_server_source": "managed",
            "tts_playback_mode": "auto",
        }, self._models)
        qwen = _resolve_tts_config({
            "tts_model": "qwen3-tts",
            "tts_server_source": "managed",
            "tts_playback_mode": "auto",
        }, self._models)

        self.assertFalse(dots["tts_streaming"])
        self.assertEqual(dots["tts_stream_sample_rate"], 0)
        self.assertEqual(dots["tts_effective_mode"], "offline")
        self.assertEqual(dots["tts_options"], {
            "num_inference_steps": 4,
            "vocoder_merge_steps": 4,
        })
        self.assertTrue(voxcpm["tts_streaming"])
        self.assertEqual(voxcpm["tts_effective_mode"], "streaming")
        self.assertFalse(qwen["tts_streaming"])

    def test_forced_streaming_rejects_offline_model(self):
        with self.assertRaisesRegex(ValueError, "does not support streaming"):
            _resolve_tts_config({
                "tts_model": "qwen3-tts",
                "tts_server_source": "managed",
                "tts_playback_mode": "streaming",
            }, self._models)

    def test_forced_streaming_keeps_dott_route_available(self):
        resolved = _resolve_tts_config({
            "tts_model": "dots-tts-meanflow",
            "tts_server_source": "managed",
            "tts_playback_mode": "streaming",
        }, self._models)

        self.assertTrue(resolved["tts_streaming"])
        self.assertEqual(resolved["tts_effective_mode"], "streaming")

    def test_legacy_smooth_mode_migrates_to_offline(self):
        dots = _resolve_tts_config({
            "tts_model": "dots-tts-meanflow",
            "tts_server_source": "managed",
            "tts_playback_mode": "smooth",
        }, self._models)
        qwen = _resolve_tts_config({
            "tts_model": "qwen3-tts",
            "tts_server_source": "managed",
            "tts_playback_mode": "smooth",
        }, self._models)

        self.assertFalse(dots["tts_streaming"])
        self.assertEqual(dots["tts_playback_mode"], "offline")
        self.assertFalse(qwen["tts_streaming"])

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
        self.assertFalse(response.json()["tts_streaming"])
        self.assertEqual(response.json()["tts_effective_mode"], "offline")
        self.assertEqual(calls, [("dots-tts-meanflow", "offline")])


if __name__ == "__main__":
    unittest.main()
