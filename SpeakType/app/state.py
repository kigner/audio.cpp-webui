from __future__ import annotations

from enum import Enum
from threading import RLock


class DictationState(str, Enum):
    IDLE = "idle"
    CONNECTING = "connecting"
    LISTENING = "listening"
    FINALIZING = "finalizing"
    ERROR = "error"


ALLOWED_TRANSITIONS: dict[DictationState, set[DictationState]] = {
    DictationState.IDLE: {DictationState.CONNECTING, DictationState.ERROR},
    DictationState.CONNECTING: {DictationState.LISTENING, DictationState.IDLE, DictationState.ERROR},
    DictationState.LISTENING: {DictationState.FINALIZING, DictationState.IDLE, DictationState.ERROR},
    DictationState.FINALIZING: {DictationState.IDLE, DictationState.ERROR},
    DictationState.ERROR: {DictationState.CONNECTING, DictationState.IDLE},
}


class InvalidStateTransition(RuntimeError):
    pass


class StateMachine:
    def __init__(self) -> None:
        self._state = DictationState.IDLE
        self._lock = RLock()

    @property
    def state(self) -> DictationState:
        with self._lock:
            return self._state

    def transition(self, target: DictationState) -> DictationState:
        with self._lock:
            if target == self._state:
                return self._state
            if target not in ALLOWED_TRANSITIONS[self._state]:
                raise InvalidStateTransition(f"{self._state.value} -> {target.value}")
            self._state = target
            return self._state

