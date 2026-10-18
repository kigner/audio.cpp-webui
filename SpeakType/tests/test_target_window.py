from unittest.mock import patch

from app.target_window import TargetWindowTracker


def test_overlay_is_never_target_and_first_external_window_can_receive():
    tracker = TargetWindowTracker()
    with patch('app.target_window.USER32') as user, patch.object(tracker, '_is_own_window', side_effect=lambda h: h == 10):
        user.GetForegroundWindow.return_value = 10
        assert tracker.capture() == 0
        assert not tracker.is_foreground()
        user.GetForegroundWindow.return_value = 20
        user.IsWindow.return_value = True
        assert tracker.is_foreground()
        assert tracker.target_hwnd == 20
        user.GetForegroundWindow.return_value = 30
        assert not tracker.is_foreground()


def test_external_target_survives_overlay_interaction():
    tracker = TargetWindowTracker()
    with patch('app.target_window.USER32') as user, patch.object(tracker, '_is_own_window', side_effect=lambda h: h == 10):
        user.GetForegroundWindow.return_value = 20
        user.IsWindow.return_value = True
        assert tracker.capture() == 20
        user.GetForegroundWindow.return_value = 10
        assert not tracker.is_foreground()
        user.GetForegroundWindow.return_value = 20
        assert tracker.is_foreground()
        tracker.clear()
        assert not tracker.is_foreground()
