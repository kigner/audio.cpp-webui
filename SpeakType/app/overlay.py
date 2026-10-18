from __future__ import annotations

import ctypes
import os
import time
import threading
import uuid
from collections.abc import Callable
from ctypes import wintypes

import webview

from app.config import UiConfig


USER32 = ctypes.windll.user32
GDI32 = ctypes.windll.gdi32
GWL_EXSTYLE = -20
WS_EX_TRANSPARENT = 0x00000020
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_NOACTIVATE = 0x08000000
HWND_TOPMOST = -1
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040
SWP_NOZORDER = 0x0004

# Win32 coordinates are physical pixels; using them avoids DPI-scaled JS deltas.
USER32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
USER32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
                              ctypes.c_int, ctypes.c_int, ctypes.c_uint]
USER32.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
USER32.GetWindowLongPtrW.restype = ctypes.c_ssize_t
USER32.SetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t]
USER32.SetWindowLongPtrW.restype = ctypes.c_ssize_t
GDI32.CreateRoundRectRgn.argtypes = [ctypes.c_int] * 6
GDI32.CreateRoundRectRgn.restype = wintypes.HRGN
GDI32.DeleteObject.argtypes = [wintypes.HANDLE]
USER32.SetWindowRgn.argtypes = [wintypes.HWND, wintypes.HRGN, wintypes.BOOL]


class _OverlayApi:
    def __init__(self, close_window: Callable[[], bool], drag_window=None, compact_window=None) -> None:
        self._close_window = close_window
        self._drag_window = drag_window
        self._compact_window = compact_window

    def close(self) -> bool:
        return self._close_window()

    def start_drag(self) -> bool:
        return self._drag_window()

    def set_compact(self, compact: bool) -> bool:
        return self._compact_window(bool(compact))


class OverlayWindow:
    def __init__(self, config: UiConfig, url: str) -> None:
        self.config = config
        self.url = url
        self.title = f"SpeakType-{os.getpid()}-{uuid.uuid4().hex[:8]}"
        self.window: webview.Window | None = None
        self._api = _OverlayApi(self.close, self.start_drag, self.set_compact)
        self._closed = threading.Event()
        self._dragging = threading.Lock()
        self._expanded_size = None
        self._compact = False

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
            transparent=False,
            background_color="#192530",
            resizable=False,
            easy_drag=False,
            min_size=(280, 56),
            focus=False,  # pywebview 6.x: don't steal foreground focus on creation
            js_api=self._api,
        )
        return self.window

    def close(self) -> bool:
        window = self.window
        if window is None:
            return False
        self._closed.set()
        window.destroy()
        return True

    @staticmethod
    def _rect(hwnd):
        rect = wintypes.RECT()
        if not USER32.GetWindowRect(hwnd, ctypes.byref(rect)):
            raise RuntimeError("无法读取听写窗口位置。")
        return rect

    @staticmethod
    def _round_corners(hwnd, width, height):
        dpi = USER32.GetDpiForWindow(wintypes.HWND(hwnd)) or 96
        diameter = round(32 * dpi / 96)
        region = GDI32.CreateRoundRectRgn(0, 0, width + 1, height + 1, diameter, diameter)
        if region and not USER32.SetWindowRgn(hwnd, region, True):
            # Windows owns the region after a successful SetWindowRgn.
            GDI32.DeleteObject(region)

    @staticmethod
    def _place(hwnd, x, y, width, height):
        # Keep the controls reachable within the Windows virtual desktop.
        left, top = USER32.GetSystemMetrics(76), USER32.GetSystemMetrics(77)
        right = left + USER32.GetSystemMetrics(78)
        bottom = top + USER32.GetSystemMetrics(79)
        x, y = max(left, min(x, right - width)), max(top, min(y, bottom - height))
        if not USER32.SetWindowPos(hwnd, None, x, y, width, height, SWP_NOACTIVATE | SWP_NOZORDER):
            raise RuntimeError("无法调整听写窗口。")

    def start_drag(self) -> bool:
        hwnd = self._find_hwnd()
        if not hwnd or self._closed.is_set() or not self._dragging.acquire(blocking=False):
            return False

        def drag():
            try:
                start = wintypes.POINT()
                USER32.GetCursorPos(ctypes.byref(start))
                rect = self._rect(hwnd)
                while not self._closed.is_set() and USER32.GetAsyncKeyState(0x01) & 0x8000:
                    point = wintypes.POINT()
                    USER32.GetCursorPos(ctypes.byref(point))
                    self._place(hwnd, rect.left + point.x - start.x, rect.top + point.y - start.y,
                                rect.right - rect.left, rect.bottom - rect.top)
                    self._closed.wait(0.016)
            finally:
                self._dragging.release()

        threading.Thread(target=drag, daemon=True, name="overlay-drag").start()
        return True

    def set_compact(self, compact: bool) -> bool:
        hwnd = self._find_hwnd()
        if not hwnd or self._closed.is_set():
            return self._compact
        with self._dragging:
            if compact == self._compact:
                return self._compact
            rect = self._rect(hwnd)
            if compact:
                self._expanded_size = (rect.right - rect.left, rect.bottom - rect.top)
                dpi = USER32.GetDpiForWindow(wintypes.HWND(hwnd)) or 96
                width, height = round(360 * dpi / 96), round(64 * dpi / 96)
            else:
                width, height = self._expanded_size
            self._place(hwnd, rect.left, rect.bottom - height, width, height)
            self._round_corners(hwnd, width, height)
            self._compact = compact
        return self._compact

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
        rect = self._rect(hwnd)
        # WinForms sets Size before removing the title bar, shrinking the final
        # frameless window. Reapply the requested size after the HWND is ready.
        dpi = USER32.GetDpiForWindow(wintypes.HWND(hwnd)) or 96
        width, height = round(self.config.width * dpi / 96), round(self.config.height * dpi / 96)
        self._place(hwnd, rect.left, rect.top, width, height)
        self._round_corners(hwnd, width, height)

    def run(self, after_start: callable) -> None:
        if self.window is None:
            self.create()

        def ready() -> None:
            self.apply_no_activate()
            after_start()

        webview.start(ready, debug=False, private_mode=False)
