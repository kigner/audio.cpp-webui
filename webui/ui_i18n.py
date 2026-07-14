"""Small bilingual helpers for the local Gradio WebUI."""

import json
import os

LANG_ZH = "zh"
LANG_EN = "en"
DEFAULT_LANGUAGE = LANG_ZH
LANGUAGE_CHOICES = [("中文", LANG_ZH), ("English", LANG_EN)]
LANGUAGE_CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "configs", "ui_language.json")

_language = DEFAULT_LANGUAGE


def normalize_language(language):
    return LANG_EN if language == LANG_EN else LANG_ZH


def set_language(language):
    global _language
    _language = normalize_language(language)
    return _language


def get_language():
    return _language


def load_language(path=LANGUAGE_CONFIG_PATH):
    """Load the saved UI language, falling back to Chinese."""
    language = DEFAULT_LANGUAGE
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            language = data.get("language", DEFAULT_LANGUAGE)
    except (OSError, ValueError, TypeError):
        pass
    return set_language(language)


def save_language(language, path=LANGUAGE_CONFIG_PATH):
    """Persist the normalized UI language and return it."""
    language = normalize_language(language)
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    temp_path = path + ".tmp"
    with open(temp_path, "w", encoding="utf-8") as f:
        json.dump({"language": language}, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(temp_path, path)
    return language


def text(zh, en, language=None, **values):
    """Choose and format a bilingual string."""
    language = normalize_language(language or _language)
    template = en if language == LANG_EN else zh
    return template.format(**values) if values else template


def param_spec(spec, language=None):
    """Return a localized advanced-parameter spec without changing its value.

    Protocol names, choices and defaults must stay stable.  In English mode a
    missing translated label falls back to the option name, while untranslated
    explanatory copy is omitted to keep dynamic control rows compact.
    """
    language = normalize_language(language or _language)
    if language == LANG_ZH:
        return dict(spec)

    out = dict(spec)
    out["label"] = spec.get("label_en") or spec.get("name", "")
    out["info"] = spec.get("info_en") or None
    placeholder = spec.get("placeholder_en")
    if placeholder is None:
        original = spec.get("placeholder", "")
        placeholder = original if original.isascii() else ""
    out["placeholder"] = placeholder
    return out
