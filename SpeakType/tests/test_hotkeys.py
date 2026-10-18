import pytest

from app.hotkeys import parse_hotkey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT


def test_dictation_function_key():
    assert parse_hotkey('ctrl+alt+f9') == (MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 0x78)


@pytest.mark.parametrize('key', ['f0', 'f25'])
def test_invalid_function_keys(key):
    with pytest.raises(ValueError):
        parse_hotkey(key)
