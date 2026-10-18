"""Text and speech share one conversation and one cancellation generation."""
import json
import queue
import threading
import unittest
from unittest.mock import Mock, patch

import httpx
import numpy as np
from fastapi.testclient import TestClient

from realtime_pipeline import (
    AssistantText, AudioChunk, CancelScope, RealtimePipeline, ResponseDone,
    SpeechStopped, UserTranscript, _LLMStage,
)
from realtime_server import create_app
from test_realtime_pipeline import _pipeline_for_transcript, _SingleTurnQueue


class RealtimeTextTests(unittest.TestCase):
    def make_pipeline(self):
        pipeline = _pipeline_for_transcript("spoken question")
        pipeline._cancel_scope = CancelScope()
        pipeline._turn_queue = queue.Queue()
        pipeline._tts_queue = queue.Queue()
        pipeline._llm.add_assistant_message = Mock()
        pipeline._speak = Mock()
        return pipeline

    def test_text_submission_does_not_create_vad_or_call_asr(self):
        with patch("realtime_pipeline._VADStage") as vad:
            pipeline = RealtimePipeline()
            try:
                pipeline._stt.transcribe = Mock(side_effect=AssertionError("ASR must not run"))
                pipeline._llm.stream = Mock(return_value=iter(()))
                gen = pipeline.feed_text("  typed question  ")
                turn = pipeline._turn_queue.get_nowait()
                pipeline._run_text_turn(turn.text, gen)
                vad.assert_not_called()
                pipeline._stt.transcribe.assert_not_called()
                self.assertEqual(pipeline._llm._messages[-1], {"role": "user", "content": "typed question"})
                self.assertEqual(pipeline.drain_events(), [UserTranscript("typed question"), ResponseDone()])
            finally:
                pipeline.stop()
                pipeline._llm._http.close()

    def test_speech_and_text_reuse_the_same_history(self):
        pipeline = self.make_pipeline()
        pipeline._run_turn(np.zeros(16000, dtype=np.float32))
        generation = pipeline.feed_text("typed follow-up")
        pipeline._run_text_turn(pipeline._turn_queue.get_nowait().text, generation)
        self.assertEqual(pipeline._llm.user_messages, ["spoken question", "typed follow-up"])

    def test_new_text_supersedes_a_queued_old_voice_turn(self):
        pipeline = self.make_pipeline()
        old = SpeechStopped(audio=np.zeros(16000, dtype=np.float32), generation=0)
        pipeline.feed_text("new text")
        pipeline._stt.transcribe = Mock()
        pipeline._turn_queue = _SingleTurnQueue(old, pipeline._stop_event)
        pipeline._pipeline_loop()
        pipeline._stt.transcribe.assert_not_called()

    def test_cancel_removes_queued_audio_text_and_done(self):
        pipeline = self.make_pipeline()
        for event in [AudioChunk(b"old", generation=0), AssistantText("old", generation=0), ResponseDone(generation=0)]:
            pipeline._out_events.put(event)
        generation = pipeline.feed_text("new")
        pipeline._out_events.put(AssistantText("new", generation=generation))
        self.assertEqual(pipeline.drain_events(), [AssistantText("new")])

    def test_cancel_while_waiting_for_tts_does_not_commit_old_reply(self):
        pipeline = self.make_pipeline()
        pipeline._llm.stream = Mock(return_value=iter(["An obsolete answer."]))
        pipeline._speak = Mock(side_effect=lambda *_args: pipeline.cancel())
        pipeline._run_text_turn("first question", 0)
        pipeline._llm.add_assistant_message.assert_not_called()
        self.assertFalse(any(isinstance(event, ResponseDone) for event in pipeline.drain_events()))

    def test_empty_or_oversized_text_does_not_cancel_current_turn(self):
        pipeline = self.make_pipeline()
        for text in ("  ", "x" * 12001):
            with self.assertRaises(ValueError):
                pipeline.feed_text(text)
        self.assertEqual(pipeline.generation, 0)

    def test_configured_local_and_cloud_apis_receive_shared_history(self):
        for base_url, key in [("http://127.0.0.1:11434/v1", ""), ("https://cloud.example/v1", "test-secret")]:
            with self.subTest(base_url=base_url):
                received = []

                def respond(request):
                    received.append(request)
                    return httpx.Response(200, text='data: {"choices":[{"delta":{"content":"reply"}}]}\n\ndata: [DONE]\n\n')

                llm = _LLMStage(base_url, key, "configured-model", "configured role")
                llm._http.close()
                llm._http = httpx.Client(transport=httpx.MockTransport(respond))
                try:
                    llm.add_user_message("spoken input")
                    llm.add_assistant_message("first reply")
                    llm.add_user_message("typed follow-up")
                    self.assertEqual(list(llm.stream(CancelScope(), 0)), ["reply"])
                    payload = json.loads(received[0].content)
                    self.assertEqual(str(received[0].url), base_url + "/chat/completions")
                    self.assertEqual(payload["model"], "configured-model")
                    self.assertTrue(payload["messages"][0]["content"].startswith("configured role\n"))
                    self.assertIn("latest clear user message", payload["messages"][0]["content"])
                    self.assertEqual([row["content"] for row in payload["messages"][1:]],
                                     ["spoken input", "first reply", "typed follow-up"])
                    self.assertEqual(llm._messages[0]["content"], "configured role")
                    self.assertEqual(received[0].headers.get("authorization", ""), "Bearer test-secret" if key else "")
                finally:
                    llm._http.close()

    def test_voxcpm1_cloned_reply_keeps_one_voice_context(self):
        reply = "Hello there! How can I help you today? Tell me what you need."
        for streaming in (False, True):
            with self.subTest(streaming=streaming):
                pipeline = self.make_pipeline()
                pipeline._tts_model = "voxcpm1"
                pipeline._tts_voice_ref = "voice/demo_02_woman.wav"
                pipeline._tts_reference_text = "The reference transcript."
                pipeline._tts_streaming = streaming
                pipeline._tts_stream_sample_rate = 16000 if streaming else 0
                pipeline._llm.stream = Mock(return_value=iter(reply))
                pipeline._run_text_turn("Hello", 0)

                pipeline._speak.assert_called_once_with(
                    reply, 0, "voxcpm1", "", "voice/demo_02_woman.wav",
                    "The reference transcript.", streaming,
                    pipeline._tts_stream_sample_rate, {})
                pipeline._llm.add_assistant_message.assert_called_once_with(reply)

    def test_other_tts_models_keep_responsive_sentence_requests(self):
        pipeline = self.make_pipeline()
        pipeline._tts_model = "supertonic"
        pipeline._llm.stream = Mock(return_value=iter("Hello there! How can I help?"))
        pipeline._run_text_turn("Hello", 0)
        self.assertEqual([call.args[0] for call in pipeline._speak.call_args_list],
                         ["Hello there!", "How can I help?"])

    def test_configured_language_guides_first_misrecognized_transcript(self):
        received = []

        def respond(request):
            received.append(json.loads(request.content))
            return httpx.Response(200, text="data: [DONE]\n\n")

        llm = _LLMStage("http://fixture/v1", language="English")
        llm._http.close()
        llm._http = httpx.Client(transport=httpx.MockTransport(respond))
        try:
            llm.add_user_message("こんにちは")
            list(llm.stream(CancelScope(), 0))
            self.assertIn("conversation language is English", received[-1]["messages"][0]["content"])
            self.assertIn("unclear first transcript", received[-1]["messages"][0]["content"])
            self.assertEqual(received[-1]["messages"][1]["content"], "こんにちは")
            llm.configure(language="")
            list(llm.stream(CancelScope(), 0))
            self.assertNotIn("conversation language is English", received[-1]["messages"][0]["content"])
            self.assertIn("latest clear user message", received[-1]["messages"][0]["content"])
            llm.add_assistant_message("こんにちは、Lilyです。")
            llm.add_user_message("What do you like to do on weekends?")
            list(llm.stream(CancelScope(), 0))
            sent = received[-1]["messages"]
            self.assertIn("clear English speech in English", sent[0]["content"])
            self.assertNotIn("Change language only", sent[0]["content"])
            self.assertEqual(sent[-1]["content"], "What do you like to do on weekends?")
        finally:
            llm._http.close()

    def test_session_language_updates_asr_and_reply_and_can_return_to_auto(self):
        pipeline = RealtimePipeline(asr_language="English")
        try:
            self.assertEqual(pipeline._stt._language, "English")
            self.assertEqual(pipeline._llm._language, "English")
            pipeline.configure({"asr_language": "en"})
            self.assertEqual(pipeline._stt._language, "en")
            self.assertEqual(pipeline._llm._language, "en")
            pipeline.configure({})
            self.assertEqual(pipeline._llm._language, "en")
            pipeline.configure({"asr_language": ""})
            self.assertEqual(pipeline._stt._language, "")
            self.assertEqual(pipeline._llm._language, "")
        finally:
            pipeline.stop()
            pipeline._llm._http.close()


class RealtimeTextEndpointTests(unittest.TestCase):
    def test_text_activation_skips_managed_asr_and_preserves_external_tts(self):
        asr, tts = Mock(), Mock()
        with TestClient(create_app(managed_tts_loader=tts, managed_asr_loader=asr)) as client:
            response = client.post("/activate", json={"input_mode": "text", "tts_server_source": "external"})
        self.assertEqual(response.status_code, 200)
        asr.assert_not_called()
        tts.assert_not_called()

    def test_text_requires_configured_session_and_acknowledges_generation(self):
        pipeline = Mock()
        pipeline.drain_events.return_value = []
        pipeline.feed_text.return_value = 7
        pipeline.generation = 8
        with patch("realtime_server.RealtimePipeline", return_value=pipeline):
            with TestClient(create_app()) as client:
                with client.websocket_connect("/v1/realtime") as ws:
                    ws.receive_json()
                    ws.send_json({"type": "user.text", "text": "early"})
                    self.assertEqual(ws.receive_json()["error"]["code"], "session_not_ready")
                    pipeline.feed_text.assert_not_called()
                    ws.send_json({"type": "session.update", "session": {"audiocpp": {"tts_server_source": "external"}}})
                    self.assertEqual(ws.receive_json()["type"], "session.updated")
                    ws.send_json({"type": "user.text", "text": "hello", "request_id": 2})
                    self.assertEqual(ws.receive_json(), {"type": "user.text.accepted", "generation": 7, "request_id": 2})
                    pipeline.feed_text.assert_called_once_with("hello")
                    ws.send_json({"type": "response.cancel", "request_id": 3})
                    self.assertEqual(ws.receive_json(), {"type": "response.cancelled", "generation": 8, "request_id": 3})
                    ws.send_json({"type": "user.text", "text": " "})
                    self.assertEqual(ws.receive_json()["error"]["code"], "invalid_text")
        pipeline.stop.assert_called_once()


if __name__ == "__main__":
    unittest.main()
