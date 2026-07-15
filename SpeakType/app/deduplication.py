from __future__ import annotations

from collections import deque
from threading import RLock


class FinalDeduplicator:
    def __init__(self, capacity: int = 2048) -> None:
        self._capacity = capacity
        self._keys: set[tuple[str, str]] = set()
        self._order: deque[tuple[str, str]] = deque()
        self._lock = RLock()

    def accept(self, session_id: str, segment_id: str) -> bool:
        key = (session_id, segment_id)
        with self._lock:
            if key in self._keys:
                return False
            self._keys.add(key)
            self._order.append(key)
            while len(self._order) > self._capacity:
                self._keys.discard(self._order.popleft())
            return True
