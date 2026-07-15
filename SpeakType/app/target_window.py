from __future__ import annotations

import ctypes


USER32 = ctypes.windll.user32


class TargetWindowTracker:
    def __init__(self) -> None:
        self._target_hwnd = 0

    @property
    def target_hwnd(self) -> int:
        return self._target_hwnd

    def capture(self) -> int:
        self._target_hwnd = int(USER32.GetForegroundWindow())
        return self._target_hwnd

    def is_valid(self) -> bool:
        return bool(self._target_hwnd and USER32.IsWindow(self._target_hwnd))

    def is_foreground(self) -> bool:
        return self.is_valid() and int(USER32.GetForegroundWindow()) == self._target_hwnd

    def clear(self) -> None:
        self._target_hwnd = 0

