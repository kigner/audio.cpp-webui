from __future__ import annotations

import ctypes
import os
import time
import uuid
from ctypes import wintypes

import webview

from app.config import UiConfig


USER32 = ctypes.windll.user32
GWL_EXSTYLE = -20
WS_EX_TRANSPARENT = 0x00000020
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_NOACTIVATE = 0x08000000
HWND_TOPMOST = -1
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040


class OverlayWindow:
    def __init__(self, config: UiConfig, url: str) -> None:
        self.config = config
        self.url = url
        self.title = f"SpeakType-{os.getpid()}-{uuid.uuid4().hex[:8]}"
        self.window: webview.Window | None = None

    def _position(self) -> tuple[int, int]:
        screen_width = USER32.GetSystemMetrics(0)
        screen_height = USER32.GetSystemMetrics(1)
        return (
            max(0, (screen_width - self.config.width) // 2),
            max(0, screen_height - self.config.height - self.config.bottom_margin),
        )

    def create(self) -> webview.Window:
        x, y = self._position()
        self.window = webview.create_window(
            title=self.title,
            url=self.url,
            width=self.config.width,
            height=self.config.height,
            x=x,
            y=y,
            frameless=True,
            on_top=self.config.always_on_top,
            transparent=True,
            background_color="#000000",
            easy_drag=False,
            focus=False,  # pywebview 6.x: don't steal foreground focus on creation
        )
        return self.window

    def _find_hwnd(self) -> int:
        found = 0
        target_pid = os.getpid()
        enum_proc_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        def callback(hwnd: int, lparam: int) -> bool:
            del lparam
            nonlocal found
            pid = wintypes.DWORD()
            USER32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value != target_pid:
                return True
            length = USER32.GetWindowTextLengthW(hwnd)
            buffer = ctypes.create_unicode_buffer(length + 1)
            USER32.GetWindowTextW(hwnd, buffer, length + 1)
            if buffer.value == self.title:
                found = int(hwnd)
                return False
            return True

        USER32.EnumWindows(enum_proc_type(callback), 0)
        return found

    def apply_no_activate(self) -> None:
        deadline = time.monotonic() + 8.0
        hwnd = 0
        while not hwnd and time.monotonic() < deadline:
            hwnd = self._find_hwnd()
            if not hwnd:
                time.sleep(0.05)
        if not hwnd:
            raise RuntimeError("could not find overlay HWND")
        style = USER32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)
        style |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW
        if self.config.click_through:
            style |= WS_EX_TRANSPARENT
        USER32.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style)
        USER32.SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )

    def run(self, after_start: callable) -> None:
        if self.window is None:
            self.create()

        def ready() -> None:
            self.apply_no_activate()
            after_start()

        webview.start(ready, debug=False, private_mode=False)
