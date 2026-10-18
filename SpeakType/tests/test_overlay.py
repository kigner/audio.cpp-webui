from unittest.mock import Mock, patch
from ctypes import wintypes

from app.config import UiConfig
from app.overlay import OverlayWindow
from app import overlay as module


def test_close_destroys_overlay_window() -> None:
    overlay = OverlayWindow(UiConfig(), "http://127.0.0.1:8765")
    window = Mock()
    overlay.window = window

    assert overlay.close() is True
    window.destroy.assert_called_once_with()


def test_close_without_window_is_a_noop() -> None:
    overlay = OverlayWindow(UiConfig(), "http://127.0.0.1:8765")

    assert overlay.close() is False


def test_compact_restore_preserves_native_size_and_never_activates() -> None:
    overlay = OverlayWindow(UiConfig(), "http://127.0.0.1:8765")
    with patch.object(overlay, "_find_hwnd", return_value=123), \
         patch.object(overlay, "_round_corners") as corners, \
         patch.object(overlay, "_rect", side_effect=[wintypes.RECT(100, 300, 1000, 470), wintypes.RECT(100, 406, 460, 470)]), \
         patch.object(module, "USER32") as user:
        user.GetDpiForWindow.return_value = 96
        user.GetSystemMetrics.side_effect = lambda index: {76:0,77:0,78:1920,79:1080}[index]
        assert overlay.set_compact(True) is True
        assert user.SetWindowPos.call_args.args[2:6] == (100, 406, 360, 64)
        assert overlay.set_compact(False) is False
        assert corners.call_count == 2
        assert user.SetWindowPos.call_args.args[2:6] == (100, 300, 900, 170)
        for call in user.SetWindowPos.call_args_list:
            assert call.args[-1] & module.SWP_NOACTIVATE
        user.SetForegroundWindow.assert_not_called()
        user.SetFocus.assert_not_called()


def test_drag_uses_cursor_delta_without_foreground_activation() -> None:
    overlay = OverlayWindow(UiConfig(), "http://127.0.0.1:8765")
    def cursor(pointer):
        point = pointer._obj
        point.x, point.y = positions.pop(0)
        return True
    positions = [(200, 300), (240, 320)]
    with patch.object(overlay, "_find_hwnd", return_value=123), \
         patch.object(overlay, "_rect", return_value=wintypes.RECT(100, 100, 1000, 270)), \
         patch.object(overlay, "_place") as place, patch.object(module, "USER32") as user, \
         patch.object(module.threading, "Thread") as thread:
        user.GetCursorPos.side_effect = cursor
        user.GetAsyncKeyState.side_effect = [0x8000, 0]
        thread.side_effect = lambda **kwargs: Mock(start=kwargs["target"])
        assert overlay.start_drag() is True
        place.assert_called_once_with(123, 140, 120, 900, 170)
        user.SetForegroundWindow.assert_not_called()
        assert not overlay._dragging.locked()
