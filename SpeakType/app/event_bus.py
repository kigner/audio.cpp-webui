from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from threading import RLock
from typing import Any


@dataclass
class _Subscriber:
    loop: asyncio.AbstractEventLoop
    queue: asyncio.Queue[dict[str, Any]]


class UiEventHub:
    def __init__(self, queue_size: int = 128) -> None:
        self._queue_size = queue_size
        self._subscribers: dict[int, _Subscriber] = {}
        self._next_id = 1
        self._lock = RLock()
        self._snapshot: dict[str, dict[str, Any]] = {
            "state": {"type": "state", "value": "idle"},
            "level": {"type": "level", "value": 0.0},
            "partial": {"type": "partial", "text": "", "latency_ms": None},
        }

    def publish(self, event: dict[str, Any]) -> None:
        event = json.loads(json.dumps(event, ensure_ascii=False))
        event_type = str(event.get("type", ""))
        if event_type in self._snapshot:
            self._snapshot[event_type] = event
        with self._lock:
            subscribers = list(self._subscribers.values())
        for subscriber in subscribers:
            try:
                subscriber.loop.call_soon_threadsafe(self._offer, subscriber.queue, event)
            except RuntimeError:
                continue

    @staticmethod
    def _offer(queue: asyncio.Queue[dict[str, Any]], event: dict[str, Any]) -> None:
        if queue.full():
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        queue.put_nowait(event)

    def subscribe(self) -> tuple[int, asyncio.Queue[dict[str, Any]], list[dict[str, Any]]]:
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=self._queue_size)
        with self._lock:
            subscriber_id = self._next_id
            self._next_id += 1
            self._subscribers[subscriber_id] = _Subscriber(loop, queue)
            snapshot = list(self._snapshot.values())
        return subscriber_id, queue, snapshot

    def unsubscribe(self, subscriber_id: int) -> None:
        with self._lock:
            self._subscribers.pop(subscriber_id, None)

