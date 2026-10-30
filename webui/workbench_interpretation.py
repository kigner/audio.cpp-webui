"""Local microphone translation, with one resident LFM session and ordered speech."""
from __future__ import annotations

import asyncio
import base64
from collections import deque
from dataclasses import dataclass
import io
import json
from pathlib import Path
import tempfile
import time
import uuid
import wave

import httpx
import numpy as np
from fastapi import WebSocket, WebSocketDisconnect

PREFIX = "/api/workbench/interpretation"
RATE, FRAME = 16000, 512
LANGUAGES = [("zh", "中文"), ("en", "英语"), ("ja", "日语"), ("ko", "韩语"),
             ("fr", "法语"), ("de", "德语"), ("es", "西班牙语"), ("pt", "葡萄牙语"),
             ("it", "意大利语"), ("ar", "阿拉伯语"), ("da", "丹麦语"), ("el", "希腊语"),
             ("fi", "芬兰语"), ("he", "希伯来语"), ("nl", "荷兰语"), ("pl", "波兰语"),
             ("sv", "瑞典语"), ("tr", "土耳其语")]


@dataclass
class Segment:
    pcm: bytes
    start: float
    end: float


def local_probability():
    # The portable bundle already contains Silero; this path never downloads weights.
    import torch
    root = Path(__file__).parent / "third_party" / "silero-vad"
    model, _ = torch.hub.load(str(root), "silero_vad", source="local", trust_repo=True)
    model.reset_states()

    def probability(frame):
        with torch.no_grad():
            return float(model(torch.from_numpy(frame), RATE).reshape(-1)[0])
    return probability


class VoiceSegments:
    """Keep word onsets, cut at pauses, and bound speech without cancelling playback."""
    def __init__(self, probability):
        self.probability = probability
        self.pending = b""
        self.pre = deque(maxlen=10)
        self.frames = []
        self.samples = self.start = 0
        self.speech_run = self.silence_run = 0
        self.active = False

    def _take(self):
        frames, start = self.frames, self.start
        trim = max(0, self.silence_run - 4)
        if trim:
            frames = frames[:-trim]
        self.frames = []
        self.active = False
        self.speech_run = self.silence_run = 0
        self.pre.clear()
        if not frames:
            return None
        return Segment(b"".join(frames), start / RATE, (start + len(frames) * FRAME) / RATE)

    def feed(self, pcm):
        if len(pcm) % 2 or len(pcm) > 65536:
            raise ValueError("麦克风音频格式不正确，请重新开始。")
        self.pending += pcm
        result = []
        while len(self.pending) >= FRAME * 2:
            block, self.pending = self.pending[:FRAME * 2], self.pending[FRAME * 2:]
            values = np.frombuffer(block, dtype="<i2").astype(np.float32) / 32768
            voiced = self.probability(values) >= .5
            self.samples += FRAME
            if not self.active:
                self.pre.append(block)
                self.speech_run = self.speech_run + 1 if voiced else 0
                if self.speech_run >= 4:
                    self.active = True
                    self.frames = list(self.pre)
                    self.start = self.samples - len(self.frames) * FRAME
                    self.pre.clear()
            else:
                self.frames.append(block)
                self.silence_run = 0 if voiced else self.silence_run + 1
                # Short breaths become useful boundaries in a long sentence.
                long_pause = len(self.frames) >= 5 * RATE / FRAME and self.silence_run >= 4
                forced = len(self.frames) >= 8 * RATE / FRAME
                if self.silence_run >= 17 or long_pause or forced:
                    segment = self._take()
                    if segment:
                        result.append(segment)
                    if forced and voiced:
                        self.active = True
                        self.start = self.samples
        return result

    def finish(self):
        # A finish message must not lose a final short word or sub-frame tail.
        result = []
        if self.pending:
            tail = self.pending
            self.pending = b""
            result.extend(self.feed(tail.ljust(FRAME * 2, b"\0")))
        if self.active:
            segment = self._take()
            if segment:
                result.append(segment)
        return result


def wav_bytes(pcm):
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(pcm)
    return out.getvalue()


def translation_context(history):
    rows = list(history)[-2:]
    while rows:
        text = json.dumps(rows, ensure_ascii=False)
        if len(text.encode("utf-8")) <= 3500:
            return text
        rows.pop(0)
    return ""


class Interpretation:
    def __init__(self, work, *, probability_factory=local_probability):
        self.work = work
        self.probability_factory = probability_factory
        self.sessions = set()
        self.closed = False

    def model(self):
        return next((entry for entry in self.work.b.catalog_models()
                     if entry.get("family") == "lfm3_audio" and entry.get("task") == "s2s"
                     and entry.get("installed") and not entry.get("incomplete")), None)

    def capabilities(self):
        model = self.model()
        return {"ready": bool(model), "model": model["id"] if model else None,
                "languages": LANGUAGES, "source_language": "zh", "target_language": "en",
                "message": "使用本机 LFM3，自动断句、翻译并朗读。" if model else "请先在模型中心安装 LFM3-Audio。"}

    async def close(self):
        self.closed = True
        await self.stop()

    async def stop(self):
        await asyncio.gather(*(session.close() for session in list(self.sessions)), return_exceptions=True)
        return {"stopped": True}

    async def connect(self, ws: WebSocket):
        # HTTP middleware does not run for WebSockets.
        if ws.url.hostname not in {"127.0.0.1", "localhost", "::1", "testserver"}:
            await ws.close(code=1008)
            return
        expected = f"{'https' if ws.url.scheme == 'wss' else 'http'}://{ws.url.netloc}"
        if ws.headers.get("origin") not in {None, expected}:
            await ws.close(code=1008)
            return
        await ws.accept()
        session = TranslationSession(self, ws)
        self.sessions.add(session)
        try:
            await session.run()
        except (WebSocketDisconnect, asyncio.CancelledError):
            pass
        except Exception as error:
            try:
                await session.send("error", message=str(error)[:400])
            except (RuntimeError, WebSocketDisconnect):
                pass
        finally:
            await session.close()
            self.sessions.discard(session)


class TranslationSession:
    def __init__(self, owner, ws):
        self.owner, self.work, self.ws = owner, owner.work, ws
        self.ident = "interpretation-" + uuid.uuid4().hex
        self.queue = asyncio.Queue(maxsize=24)
        self.worker = None
        self.initializing = None
        self.history = deque(maxlen=2)
        self.closed = self.leased = self.processing = False
        self.proc = None
        self.sequence = 0

    async def send(self, kind, **fields):
        if not self.closed:
            await self.ws.send_json({"type": kind, **fields})

    def load(self, model):
        b = self.work.b
        b._ensure_with_options(model, b.VC_TASKS, {}, mode="streaming")
        self.proc = getattr(b, "_server_proc", None)

    async def enqueue(self, segment):
        if segment is None:
            return
        if self.queue.full():
            raise RuntimeError("待翻译的语音过多，已停止收音。请等本轮结束后重新开始。")
        self.sequence += 1
        self.queue.put_nowait((self.sequence, segment))
        await self.send("queued", pending=self.queue.qsize(), id=self.sequence)

    async def run(self):
        if self.owner.closed:
            raise RuntimeError("工作台正在退出。")
        config = await asyncio.wait_for(self.ws.receive_json(), timeout=15)
        known = dict(LANGUAGES)
        if not isinstance(config, dict):
            raise ValueError("翻译会话参数无效，请重新开始。")
        self.source, self.target = config.get("source_language", "zh"), config.get("target_language", "en")
        if (config.get("type") != "start" or not isinstance(self.source, str) or not isinstance(self.target, str)
                or self.source not in known or self.target not in known or self.source == self.target):
            raise ValueError("请选择两种不同的翻译语言。")
        entry = self.owner.model()
        if not entry:
            raise ValueError("请先在模型中心安装 LFM3-Audio。")
        self.model = entry["id"]
        self.work.lease(self.ident, {"tts_model": self.model, "tts_server_source": "managed", "tts_streaming": True})
        self.leased = True
        await self.send("preparing")
        # Await both initializers even on failure, so a model cannot finish loading after the lease is released.
        async def initialize():
            return await asyncio.gather(asyncio.to_thread(self.load, self.model),
                                        asyncio.to_thread(self.owner.probability_factory), return_exceptions=True)
        self.initializing = asyncio.create_task(initialize())
        initialized = await self.initializing
        for item in initialized:
            if isinstance(item, BaseException):
                raise item
        if self.closed:
            return
        self.vad = VoiceSegments(initialized[1])
        self.worker = asyncio.create_task(self.process())
        await self.send("ready", model=self.model, sample_rate=RATE)
        active = False
        while True:
            receiver = asyncio.create_task(self.ws.receive())
            finished, _ = await asyncio.wait({receiver, self.worker}, return_when=asyncio.FIRST_COMPLETED)
            if self.worker in finished:
                receiver.cancel()
                await asyncio.gather(receiver, return_exceptions=True)
                await self.worker  # Propagate a failed inference immediately, even during microphone silence.
                break
            message = receiver.result()
            if message["type"] == "websocket.disconnect":
                raise WebSocketDisconnect(message.get("code", 1000))
            if message.get("bytes") is not None:
                for segment in await asyncio.to_thread(self.vad.feed, message["bytes"]):
                    await self.enqueue(segment)
                if active != self.vad.active:
                    active = self.vad.active
                    await self.send("speech", active=active)
            elif message.get("text"):
                action = json.loads(message["text"])
                if action.get("type") == "finish":
                    for segment in await asyncio.to_thread(self.vad.finish):
                        await self.enqueue(segment)
                    await self.queue.put(None)
                    await self.send("finishing", pending=self.queue.qsize() - 1)
                    await self.worker
                    await self.send("finished")
                    break
                if action.get("type") == "cancel":
                    break

    async def process(self):
        b = self.work.b
        timeout = httpx.Timeout(120, connect=5)
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as http:
            while True:
                item = await self.queue.get()
                if item is None:
                    return
                ident, segment = item
                self.processing = True
                await self.send("segment", id=ident, start=segment.start, end=segment.end, pending=self.queue.qsize())
                started = time.monotonic()
                source = translated = ""
                heard_audio = saw_done = empty = False
                with tempfile.TemporaryDirectory(prefix="audiocpp-interpretation-") as temp:
                    path = Path(temp) / "speech.wav"
                    path.write_bytes(wav_bytes(segment.pcm))
                    body = {"model": self.model, "stream_format": "sse", "request": {"audio": str(path), "options": {
                        "language": self.source, "target_language": self.target,
                        "translation_context": translation_context(self.history), "stream_frames_per_event": 2}}}
                    async with http.stream("POST", b.SERVER + "/v1/tasks/stream", json=body) as response:
                        if response.status_code != 200:
                            detail = (await response.aread()).decode("utf-8", errors="replace")[:400]
                            raise RuntimeError("翻译请求失败：" + detail)
                        async for line in response.aiter_lines():
                            if not line.startswith("data:"):
                                continue
                            text = line[5:].strip()
                            if not text or text == "[DONE]":
                                continue
                            message = json.loads(text)
                            if message.get("type") == "error":
                                raise RuntimeError("翻译失败：" + str((message.get("error") or {}).get("message") or "模型未返回结果。"))
                            if message.get("type") == "task.stream.done":
                                saw_done = True
                                continue
                            if message.get("type") != "task.stream.event":
                                continue
                            event = message.get("event") or {}
                            for artifact in event.get("artifacts", event.get("output_artifacts", [])):
                                if artifact.get("id") != "lfm3_audio.translation":
                                    continue
                                meta = artifact.get("metadata", artifact.get("meta", {}))
                                source = meta.get("source_text") or source
                                translated = meta.get("translation") or translated
                                empty = meta.get("stage") == "empty"
                                await self.send(meta.get("stage", "recognized"), id=ident, source=source, translation=translated)
                            if event.get("audio"):
                                with wave.open(io.BytesIO(base64.b64decode(event["audio"])), "rb") as wav:
                                    if wav.getsampwidth() != 2 or wav.getnchannels() != 1 or wav.getframerate() != 24000:
                                        raise RuntimeError("模型返回了无法播放的音频格式，请更新运行程序。")
                                    pcm = base64.b64encode(wav.readframes(wav.getnframes())).decode("ascii")
                                await self.send("audio", id=ident, pcm=pcm, sample_rate=24000,
                                                first=not heard_audio, generated_ms=round((time.monotonic() - started) * 1000))
                                heard_audio = True
                self.processing = False
                if not saw_done or not empty and (not source or not translated or not heard_audio):
                    raise RuntimeError("模型连接在翻译完成前中断，请重新开始。")
                if not empty:
                    self.history.append({"source": source, "translation": translated})
                await self.send("segment_done", id=ident, empty=empty, pending=self.queue.qsize(),
                                elapsed_ms=round((time.monotonic() - started) * 1000))

    async def close(self):
        if self.closed:
            return
        self.closed = True
        if self.initializing and not self.initializing.done():
            await asyncio.shield(self.initializing)
        if self.worker and not self.worker.done():
            self.worker.cancel()
            await asyncio.gather(self.worker, return_exceptions=True)
        # A disconnected client must not leave a long native request occupying the GPU.
        if self.processing and self.proc is not None and self.proc is getattr(self.work.b, "_server_proc", None):
            if self.proc.poll() is None:
                self.proc.terminate()
                await asyncio.to_thread(self.proc.wait, 10)
        if self.leased:
            self.work.lease(self.ident, None)
            self.leased = False
        try:
            await self.ws.close()
        except (RuntimeError, WebSocketDisconnect):
            pass


def install_interpretation_routes(app, work):
    service = Interpretation(work)
    app.state.interpretation = service
    app.get(PREFIX + "/capabilities")(service.capabilities)
    app.post(PREFIX + "/stop")(service.stop)
    app.websocket(PREFIX + "/live")(service.connect)
    return service
