from __future__ import annotations

import ctypes
import os
from ctypes import wintypes


USER32 = ctypes.windll.user32
USER32.GetForegroundWindow.restype = wintypes.HWND
USER32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
USER32.IsWindow.argtypes = [wintypes.HWND]


class TargetWindowTracker:
    def __init__(self) -> None:
        self._target_hwnd = 0
        self._awaiting_external = False

    @staticmethod
    def _is_own_window(hwnd: int) -> bool:
        pid = wintypes.DWORD()
        USER32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        return pid.value == os.getpid()

    @property
    def target_hwnd(self) -> int:
        return self._target_hwnd

    def capture(self) -> int:
        hwnd = int(USER32.GetForegroundWindow() or 0)
        self._awaiting_external = bool(hwnd and self._is_own_window(hwnd))
        self._target_hwnd = 0 if self._awaiting_external else hwnd
        return self._target_hwnd

    def is_valid(self) -> bool:
        return bool(self._target_hwnd and USER32.IsWindow(self._target_hwnd))

    def is_foreground(self) -> bool:
        hwnd = int(USER32.GetForegroundWindow() or 0)
        # The overlay may still be foreground immediately after opening. Bind once
        # to the first external foreground target, never paste into our own window.
        if hwnd and not self._is_own_window(hwnd):
            if self._awaiting_external:
                self._target_hwnd = hwnd
                self._awaiting_external = False
            return self.is_valid() and hwnd == self._target_hwnd
        return False

    def clear(self) -> None:
        self._target_hwnd = 0
        self._awaiting_external = False

