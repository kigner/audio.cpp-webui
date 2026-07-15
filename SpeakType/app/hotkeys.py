from __future__ import annotations

import ctypes
import logging
import threading
from collections.abc import Callable
from ctypes import wintypes


LOGGER = logging.getLogger(__name__)
USER32 = ctypes.windll.user32
KERNEL32 = ctypes.windll.kernel32

WM_HOTKEY = 0x0312
WM_QUIT = 0x0012
MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_SHIFT = 0x0004
MOD_WIN = 0x0008
MOD_NOREPEAT = 0x4000

VK_NAMES = {
    "space": 0x20,
    "esc": 0x1B,
    "escape": 0x1B,
    "enter": 0x0D,
    "tab": 0x09,
}
MOD_NAMES = {
    "alt": MOD_ALT,
    "ctrl": MOD_CONTROL,
    "control": MOD_CONTROL,
    "shift": MOD_SHIFT,
    "win": MOD_WIN,
    "windows": MOD_WIN,
}


def parse_hotkey(value: str) -> tuple[int, int]:
    parts = [part.strip().lower() for part in value.split("+") if part.strip()]
    if not parts:
        raise ValueError("empty hotkey")
    modifiers = MOD_NOREPEAT
    key: int | None = None
    for part in parts:
        if part in MOD_NAMES:
            modifiers |= MOD_NAMES[part]
        elif part in VK_NAMES:
            key = VK_NAMES[part]
        elif len(part) == 1 and part.isalnum():
            key = ord(part.upper())
        else:
            raise ValueError(f"unsupported hotkey key: {part}")
    if key is None:
        raise ValueError(f"hotkey has no key: {value}")
    return modifiers, key


class HotkeyManager:
    def __init__(
        self,
        bindings: dict[str, tuple[str, Callable[[], None]]],
        on_error: Callable[[str], None],
    ) -> None:
        self.bindings = bindings
        self.on_error = on_error
        self._thread: threading.Thread | None = None
        self._thread_id = 0
        self._ready = threading.Event()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._ready.clear()
        self._thread = threading.Thread(target=self._run, name="hotkey-loop", daemon=True)
        self._thread.start()
        self._ready.wait(timeout=3)

    def _run(self) -> None:
        self._thread_id = KERNEL32.GetCurrentThreadId()
        registered: dict[int, Callable[[], None]] = {}
        try:
            for hotkey_id, (name, (spec, callback)) in enumerate(self.bindings.items(), start=1):
                try:
                    modifiers, key = parse_hotkey(spec)
                except ValueError as exc:
                    self.on_error(str(exc))
                    continue
                if not USER32.RegisterHotKey(None, hotkey_id, modifiers, key):
                    self.on_error(f"热键冲突：{spec}（{name}）")
                    continue
                registered[hotkey_id] = callback
            self._ready.set()
            message = wintypes.MSG()
            while True:
                result = USER32.GetMessageW(ctypes.byref(message), None, 0, 0)
                if result <= 0:
                    break
                if message.message == WM_HOTKEY:
                    callback = registered.get(int(message.wParam))
                    if callback is not None:
                        try:
                            callback()
                        except Exception:
                            LOGGER.exception("hotkey callback failed")
        finally:
            for hotkey_id in registered:
                USER32.UnregisterHotKey(None, hotkey_id)
            self._ready.set()
            self._thread_id = 0

    def stop(self) -> None:
        if self._thread_id:
            USER32.PostThreadMessageW(self._thread_id, WM_QUIT, 0, 0)
        if self._thread is not None:
            self._thread.join(timeout=3)
            self._thread = None

