from __future__ import annotations

import asyncio
import logging
import threading
import time
import uuid
from concurrent.futures import Future

import httpx
import numpy as np

from app.asr.base import AsrClient, TranscriptEvent
from app.asr.mock import MockAsrClient
from app.asr.openai_transcriptions import OpenAiTranscriptionsClient
from app.asr.streaming import StreamingAsrClient
from app.audio_capture import AudioCapture
from app.config import AppConfig
from app.deduplication import FinalDeduplicator
from app.event_bus import UiEventHub
from app.hotkeys import HotkeyManager
from app.state import DictationState, InvalidStateTransition, StateMachine
from app.target_window import TargetWindowTracker
from app.text_injector import TextInjector


LOGGER = logging.getLogger(__name__)


class SessionController:
    def __init__(self, config: AppConfig, event_hub: UiEventHub) -> None:
        self.config = config
        self.event_hub = event_hub
        self.state_machine = StateMachine()
        self.target = TargetWindowTracker()
        self.injector = TextInjector(config.injection, self.target)
        self.audio = AudioCapture(
            sample_rate=config.asr.sample_rate,
            channels=config.asr.channels,
            frame_ms=config.asr.frame_ms,
        )
        self.deduplicator = FinalDeduplicator()
        self._loop = asyncio.new_event_loop()
        self._loop_thread: threading.Thread | None = None
        self._loop_ready = threading.Event()
        self._operation_lock: asyncio.Lock | None = None
        self._client: AsrClient | None = None
        self._pump_task: asyncio.Task[None] | None = None
        self._event_task: asyncio.Task[None] | None = None
        self._pump_stop: asyncio.Event | None = None
        self._final_received: asyncio.Event | None = None
        self._audio_start: float | None = None
        self._first_partial_seen = False
        self._cancelled = False
        self._hotkeys: HotkeyManager | None = None

    @property
    def state(self) -> str:
        return self.state_machine.state.value

    def _client_factory(self) -> AsrClient:
        if self.config.demo.mock:
            return MockAsrClient(self.config.demo.mock_text, self.config.asr.sample_rate)
        if self.config.asr.transport == "streaming":
            if not self.config.asr.stream_url:
                raise RuntimeError("STREAM PROTOCOL NOT CONFIGURED")
            return StreamingAsrClient(self.config.asr, self.config.vad)
        return OpenAiTranscriptionsClient(self.config.asr)

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._operation_lock = asyncio.Lock()
        self._loop_ready.set()
        self._loop.run_forever()
        pending = asyncio.all_tasks(self._loop)
        for task in pending:
            task.cancel()
        if pending:
            self._loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
        self._loop.close()

    def start(self) -> None:
        self._loop_thread = threading.Thread(target=self._run_loop, name="asr-network", daemon=True)
        self._loop_thread.start()
        if not self._loop_ready.wait(timeout=3):
            raise RuntimeError("ASR network loop did not start")
        self._hotkeys = HotkeyManager(
            {
                "toggle": (self.config.hotkeys.toggle_recording, self.toggle),
                "cancel": (self.config.hotkeys.cancel_current, self.cancel),
            },
            self._hotkey_error,
        )
        self._hotkeys.start()
        self.event_hub.publish({"type": "state", "value": "idle"})
        self._submit(self._probe_service())

    def _submit(self, coroutine: object) -> Future[object]:
        return asyncio.run_coroutine_threadsafe(coroutine, self._loop)  # type: ignore[arg-type]

    def toggle(self) -> None:
        self._submit(self._serialized_toggle())

    def cancel(self) -> None:
        self._submit(self._serialized_cancel())

    def _hotkey_error(self, message: str) -> None:
        LOGGER.error(message)
        self.event_hub.publish({"type": "error", "message": message})
        self._submit(self._set_error(message))

    async def _probe_service(self) -> None:
        assert self._operation_lock is not None
        async with self._operation_lock:
            if self.config.demo.mock or self.state_machine.state != DictationState.IDLE:
                return
            try:
                async with httpx.AsyncClient(
                    base_url=self.config.asr.base_url,
                    timeout=httpx.Timeout(
                        self.config.asr.connect_timeout_s,
                        connect=self.config.asr.connect_timeout_s,
                    ),
                    trust_env=False,
                ) as client:
                    response = await client.get("/health")
                    response.raise_for_status()
            except Exception as exc:
                LOGGER.warning("ASR startup probe failed: %s", exc)
                await self._set_error(f"ASR OFFLINE — {exc}")

    async def _serialized_toggle(self) -> None:
        assert self._operation_lock is not None
        async with self._operation_lock:
            state = self.state_machine.state
            if state in {DictationState.IDLE, DictationState.ERROR}:
                await self._start_session()
            elif state == DictationState.LISTENING:
                await self._stop_session()

    async def _serialized_cancel(self) -> None:
        assert self._operation_lock is not None
        async with self._operation_lock:
            await self._cancel_session()

    def _transition(self, state: DictationState, **extra: object) -> None:
        try:
            self.state_machine.transition(state)
        except InvalidStateTransition:
            LOGGER.exception("invalid state transition")
            raise
        self.event_hub.publish({"type": "state", "value": state.value, **extra})

    async def _set_error(self, message: str) -> None:
        if self.state_machine.state != DictationState.ERROR:
            self._transition(DictationState.ERROR)
        self.event_hub.publish({"type": "error", "message": message})

    async def _start_session(self) -> None:
        self._cancelled = False
        self._first_partial_seen = False
        self._audio_start = None
        self._final_received = asyncio.Event()
        self._pump_stop = asyncio.Event()
        self.target.capture()
        self.event_hub.publish({"type": "partial", "text": "", "latency_ms": None})
        self.event_hub.publish({"type": "level", "value": 0.0})
        self._transition(DictationState.CONNECTING)
        self._client = self._client_factory()
        try:
            await self._client.connect()
            session_id = uuid.uuid4().hex
            await self._client.start_session(session_id)
            self._event_task = asyncio.create_task(self._consume_events(self._client), name="asr-events")
            self.audio.start()
            self._pump_task = asyncio.create_task(self._pump_audio(self._client), name="audio-pump")
            self._transition(DictationState.LISTENING)
        except Exception as exc:
            LOGGER.exception("could not start dictation")
            self.audio.stop()
            if self._client is not None:
                await self._client.close()
            if self._event_task is not None:
                await asyncio.gather(self._event_task, return_exceptions=True)
            await self._set_error(self._friendly_error(exc))

    async def _pump_audio(self, client: AsrClient) -> None:
        assert self._pump_stop is not None
        last_level = 0.0
        while not self._pump_stop.is_set():
            frame = await asyncio.to_thread(self.audio.get_frame, 0.1)
            if frame is None:
                continue
            if self._audio_start is None:
                self._audio_start = time.perf_counter()
            await client.send_audio(frame)
            now = time.perf_counter()
            if now - last_level >= 1.0 / 15.0:
                samples = np.frombuffer(frame, dtype="<i2").astype(np.float32)
                rms = float(np.sqrt(np.mean(np.square(samples)))) / 32768.0 if samples.size else 0.0
                level = min(1.0, rms * 3.6)
                self.event_hub.publish({"type": "level", "value": round(level, 4)})
                last_level = now

    async def _consume_events(self, client: AsrClient) -> None:
        async for event in client.events():
            await self._handle_event(event)
            if event.type == "error":
                await self._stop_audio_pump()
                await client.close()
                if self._client is client:
                    self._client = None
                return

    async def _handle_event(self, event: TranscriptEvent) -> None:
        if event.type == "partial":
            latency = event.latency_ms
            if event.text and not self._first_partial_seen:
                self._first_partial_seen = True
                if self._audio_start is not None:
                    latency = round((time.perf_counter() - self._audio_start) * 1000)
            self.event_hub.publish({"type": "partial", "text": event.text, "latency_ms": latency})
            return
        if event.type == "final":
            if not self.deduplicator.accept(event.session_id, event.segment_id):
                LOGGER.warning("ignored duplicate final for %s/%s", event.session_id, event.segment_id)
                return
            if self._cancelled:
                return
            LOGGER.info(
                "ASR final session=%s segment=%s chars=%s",
                event.session_id[:8],
                event.segment_id,
                len(event.text),
            )
            self.event_hub.publish(
                {
                    "type": "final",
                    "text": event.text,
                    "segment_id": event.segment_id,
                    "latency_ms": event.latency_ms,
                }
            )
            result = await asyncio.to_thread(self.injector.inject, event.text)
            self.event_hub.publish({"type": "notice", "value": result.status, "message": result.message})
            if self._final_received is not None:
                self._final_received.set()
            return
        if event.type == "error":
            await self._set_error(event.message or "ASR ERROR")
            return
        if event.type == "state" and event.message == "segment_detected":
            self.event_hub.publish(
                {
                    "type": "notice",
                    "value": "segment",
                    "message": f"TRANSCRIBING SEGMENT {event.segment_id}",
                }
            )

    async def _stop_audio_pump(self) -> None:
        self.audio.stop()
        if self._pump_stop is not None:
            self._pump_stop.set()
        if self._pump_task is not None:
            await asyncio.gather(self._pump_task, return_exceptions=True)
            self._pump_task = None
        self.event_hub.publish({"type": "level", "value": 0.0})

    async def _stop_session(self) -> None:
        if self._client is None:
            return
        self._transition(DictationState.FINALIZING)
        await self._stop_audio_pump()
        try:
            await asyncio.wait_for(
                self._client.finish_session(),
                timeout=self.config.asr.final_timeout_s,
            )
            if self._event_task is not None:
                await asyncio.wait_for(self._event_task, timeout=2.0)
            if self._final_received is not None and not self._final_received.is_set():
                self.event_hub.publish({"type": "notice", "value": "empty", "message": "NO SPEECH DETECTED"})
            await self._client.close()
            self._client = None
            self._transition(DictationState.IDLE)
            self.event_hub.publish({"type": "partial", "text": "", "latency_ms": None})
        except Exception as exc:
            LOGGER.exception("ASR finalization failed")
            await self._client.close()
            self._client = None
            await self._set_error(self._friendly_error(exc))

    async def _cancel_session(self) -> None:
        if self.state_machine.state not in {
            DictationState.CONNECTING,
            DictationState.LISTENING,
            DictationState.FINALIZING,
        }:
            return
        self._cancelled = True
        await self._stop_audio_pump()
        if self._client is not None:
            await self._client.close()
            self._client = None
        if self._event_task is not None:
            await asyncio.gather(self._event_task, return_exceptions=True)
            self._event_task = None
        self._transition(DictationState.IDLE)
        self.event_hub.publish({"type": "partial", "text": "", "latency_ms": None})
        self.event_hub.publish({"type": "notice", "value": "cancelled", "message": "CANCELLED"})

    @staticmethod
    def _friendly_error(exc: Exception) -> str:
        text = str(exc)
        lower = text.lower()
        if "connect" in lower or "refused" in lower:
            return f"ASR OFFLINE — {text}"
        if "device" in lower or "portaudio" in lower:
            return f"MICROPHONE ERROR — {text}"
        if "timeout" in lower:
            return f"ASR TIMEOUT — {text}"
        return f"ASR ERROR — {text}"

    async def _shutdown_async(self) -> None:
        if self.state_machine.state in {
            DictationState.CONNECTING,
            DictationState.LISTENING,
            DictationState.FINALIZING,
        }:
            await self._cancel_session()
        elif self._client is not None:
            await self._client.close()
            self._client = None

    def shutdown(self) -> None:
        if self._hotkeys is not None:
            self._hotkeys.stop()
            self._hotkeys = None
        if self._loop.is_running():
            try:
                self._submit(self._shutdown_async()).result(timeout=5)
            except Exception:
                LOGGER.exception("controller shutdown did not finish cleanly")
            self._loop.call_soon_threadsafe(self._loop.stop)
        if self._loop_thread is not None:
            self._loop_thread.join(timeout=5)
            self._loop_thread = None
        self.audio.stop()
