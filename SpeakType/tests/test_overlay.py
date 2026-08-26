from unittest.mock import Mock

from app.config import UiConfig
from app.overlay import OverlayWindow


def test_close_destroys_overlay_window() -> None:
    overlay = OverlayWindow(UiConfig(), "http://127.0.0.1:8765")
    window = Mock()
    overlay.window = window

    assert overlay.close() is True
    window.destroy.assert_called_once_with()


def test_close_without_window_is_a_noop() -> None:
    overlay = OverlayWindow(UiConfig(), "http://127.0.0.1:8765")

    assert overlay.close() is False
