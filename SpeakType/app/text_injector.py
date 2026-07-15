from __future__ import annotations

import ctypes
import logging
import threading
import time
from dataclasses import dataclass
from ctypes import wintypes

import pyperclip

from app.config import InjectionConfig
from app.target_window import TargetWindowTracker


LOGGER = logging.getLogger(__name__)
USER32 = ctypes.WinDLL("user32", use_last_error=True)
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
VK_CONTROL = 0x11
VK_V = 0x56
ULONG_PTR = wintypes.WPARAM


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class INPUT_UNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("union",)
    _fields_ = [("type", wintypes.DWORD), ("union", INPUT_UNION)]


USER32.SendInput.argtypes = (wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int)
USER32.SendInput.restype = wintypes.UINT


@dataclass(frozen=True)
class InjectionResult:
    status: str
    message: str


def _window_title(hwnd: int) -> str:
    if not hwnd:
        return ""
    length = USER32.GetWindowTextLengthW(hwnd)
    buffer = ctypes.create_unicode_buffer(length + 1)
    USER32.GetWindowTextW(hwnd, buffer, length + 1)
    return buffer.value


def _key_input(vk: int, flags: int = 0, scan: int = 0) -> INPUT:
    return INPUT(type=INPUT_KEYBOARD, ki=KEYBDINPUT(vk, scan, flags, 0, 0))


def _send_ctrl_v() -> bool:
    inputs = (INPUT * 4)(
        _key_input(VK_CONTROL),
        _key_input(VK_V),
        _key_input(VK_V, KEYEVENTF_KEYUP),
        _key_input(VK_CONTROL, KEYEVENTF_KEYUP),
    )
    ctypes.set_last_error(0)
    sent = USER32.SendInput(4, inputs, ctypes.sizeof(INPUT))
    if sent != 4:
        LOGGER.error("SendInput Ctrl+V sent %s/4 events (winerror=%s)", sent, ctypes.get_last_error())
    return sent == 4


def _send_unicode(text: str) -> bool:
    values: list[INPUT] = []
    encoded = text.encode("utf-16-le")
    for index in range(0, len(encoded), 2):
        unit = int.from_bytes(encoded[index : index + 2], "little")
        values.append(_key_input(0, KEYEVENTF_UNICODE, unit))
        values.append(_key_input(0, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, unit))
    if not values:
        return True
    inputs = (INPUT * len(values))(*values)
    ctypes.set_last_error(0)
    sent = USER32.SendInput(len(values), inputs, ctypes.sizeof(INPUT))
    if sent != len(values):
        LOGGER.error(
            "SendInput Unicode sent %s/%s events (winerror=%s)",
            sent,
            len(values),
            ctypes.get_last_error(),
        )
    return sent == len(values)


class TextInjector:
    def __init__(self, config: InjectionConfig, target: TargetWindowTracker) -> None:
        self.config = config
        self.target = target

    @staticmethod
    def _clipboard_text() -> str | None:
        try:
            return pyperclip.paste()
        except pyperclip.PyperclipException:
            return None

    @staticmethod
    def _copy(text: str) -> None:
        pyperclip.copy(text)

    def _restore_later(self, original: str | None, injected: str) -> None:
        if not self.config.restore_clipboard or original is None:
            return

        def restore() -> None:
            time.sleep(self.config.restore_delay_ms / 1000.0)
            try:
                if self._clipboard_text() == injected:
                    self._copy(original)
            except Exception:
                LOGGER.exception("could not restore text clipboard")

        threading.Thread(target=restore, name="clipboard-restore", daemon=True).start()

    def inject(self, text: str) -> InjectionResult:
        if not text:
            return InjectionResult("empty", "EMPTY FINAL")
        target_hwnd = self.target.target_hwnd
        fg_hwnd = int(USER32.GetForegroundWindow())
        LOGGER.info(
            "inject: chars=%s target=%s(%r) foreground=%s(%r) is_foreground=%s",
            len(text),
            target_hwnd,
            _window_title(target_hwnd),
            fg_hwnd,
            _window_title(fg_hwnd),
            self.target.is_foreground(),
        )
        if not self.target.is_foreground():
            self._copy(text)
            LOGGER.info("inject: target not foreground -> clipboard copy only")
            return InjectionResult("copied", "COPIED — TARGET CHANGED")

        original = self._clipboard_text()
        self._copy(text)
        if _send_ctrl_v():
            self._restore_later(original, text)
            LOGGER.info("inject: pasted via Ctrl+V")
            return InjectionResult("pasted", "PASTED")

        LOGGER.warning("clipboard paste SendInput failed; trying Unicode input")
        if _send_unicode(text):
            self._restore_later(original, text)
            LOGGER.info("inject: typed via Unicode SendInput")
            return InjectionResult("unicode", "TYPED — PASTE BLOCKED")
        LOGGER.error("inject: both Ctrl+V and Unicode SendInput blocked (UIPI/elevation?)")
        return InjectionResult("failed", "INPUT BLOCKED — CHECK WINDOW PERMISSIONS")
