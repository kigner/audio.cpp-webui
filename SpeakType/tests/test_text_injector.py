from app.config import InjectionConfig
import ctypes

from app.text_injector import INPUT, TextInjector


class ChangedTarget:
    target_hwnd = 0

    def is_foreground(self) -> bool:
        return False


def test_send_input_structure_has_native_windows_size() -> None:
    expected = 40 if ctypes.sizeof(ctypes.c_void_p) == 8 else 28
    assert ctypes.sizeof(INPUT) == expected


def test_changed_target_copies_without_sending_input(monkeypatch) -> None:
    copied: list[str] = []
    monkeypatch.setattr("app.text_injector.pyperclip.copy", copied.append)
    monkeypatch.setattr(
        "app.text_injector._send_ctrl_v",
        lambda: (_ for _ in ()).throw(AssertionError("must not send Ctrl+V")),
    )
    injector = TextInjector(InjectionConfig(), ChangedTarget())  # type: ignore[arg-type]
    result = injector.inject("安全文本")
    assert copied == ["安全文本"]
    assert result.status == "copied"
    assert result.message == "COPIED — TARGET CHANGED"


def test_empty_final_is_not_injected(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.text_injector.pyperclip.copy",
        lambda text: (_ for _ in ()).throw(AssertionError(f"unexpected copy: {text}")),
    )
    injector = TextInjector(InjectionConfig(), ChangedTarget())  # type: ignore[arg-type]
    assert injector.inject("").status == "empty"
