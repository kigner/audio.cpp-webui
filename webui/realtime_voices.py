"""Voice choices from the same per-model contracts used by the local TTS UI."""
import json
from pathlib import Path


def voice_metadata(entry, profile, parameters, spec):
    family = entry.get("family", "")
    ident = entry["id"].lower()
    parameter = next((p for p in parameters
                      if p["name"] in {"speaker", "speaker_id", "voice", "voice_id"}), None)
    # Base/VoiceDesign do not consume CustomVoice speakers; Japanese LFM2 has
    # no selectable English presets despite sharing the family's model spec.
    no_presets = (family == "qwen3_tts" and "custom" not in ident) or (
        family == "lfm2_audio" and ident.endswith("-jp"))
    ui = spec.get("ui", {})
    choices = [] if no_presets else ((parameter or {}).get("choices", []) or ui.get("builtin_voices", []))
    if family == "qwen3_tts" and "custom" in ident and entry.get("abs_path"):
        # Original checkpoints expose their actual speaker map in config.json.
        try:
            config = json.loads((Path(entry["abs_path"]) / "config.json").read_text(encoding="utf-8"))
            choices = list(config.get("talker_config", {}).get("spk_id", {})) or choices
        except (OSError, ValueError, TypeError):
            pass
    voices = []
    for choice in choices:
        label, value = choice if isinstance(choice, (list, tuple)) else (choice, choice)
        voices.append({"label": str(label), "value": str(value)})
    return {
        "voices": voices,
        "voice_parameter": parameter["name"] if parameter and not no_presets else "",
        "voice_value_type": "number" if parameter and parameter.get("type") == "number" else "string",
        "accepts_voice_reference": bool(profile.get("accepts_voice_reference", True)),
        "requires_reference_text": bool(profile.get("require_reference_text") or
                                        profile.get("require_reference_text_with_voice")),
    }
