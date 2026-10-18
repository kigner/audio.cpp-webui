"""Shared controls and request rules for the local ACE-Step music workflow."""
import json
import math
from pathlib import Path

CONTROLS = json.loads((Path(__file__).parent / "configs/ace_step_controls.json").read_text(encoding="utf-8"))


def dit_variant(entry, options=None):
    options = options or {}
    return (options.get("load_options.ace_step.dit_model_path")
            or options.get("load_options", {}).get("ace_step.dit_model_path")
            or entry.get("load_options", {}).get("ace_step.dit_model_path")
            or "acestep-v15-turbo")


def normalize_options(entry, options, source_duration=None):
    """Filter drafts/JSON identically and validate before loading a model."""
    out = dict(options)
    route = out.get("task_route", out.get("route", "text2music"))
    out.pop("route", None)
    if route not in CONTROLS["routes"]:
        raise ValueError("不支持的 ACE-Step 创作方式。")
    out["task_route"] = route
    rule = CONTROLS["routes"][route]
    if source_duration is not None and (not math.isfinite(source_duration) or source_duration <= 0):
        raise ValueError("无法读取源音频时长，请重新上传。")
    if rule.get("required") and source_duration is None:
        raise ValueError("当前创作方式需要源音频。")
    for key, routes in CONTROLS["parameter_routes"].items():
        if route not in routes:
            out.pop(key, None)
    if route == "remix" or "turbo" in dit_variant(entry, out):
        out.pop("guidance_scale", None)
    # The workbench uses uploaded waveforms for editing, never hidden code hints.
    if rule["source"] and source_duration is not None:
        for key in ("audio_codes", "audio_code_string", "duration_seconds"):
            out.pop(key, None)
        if route in {"complete", "lego"}:
            # Keep metadata planning, but do not replace the uploaded audio with
            # planner-generated codes. Existing C++ consumes source audio then.
            out["thinking"] = False
    out.pop("flow_edit_morph", None)  # text2music overlay is not implemented.

    tracks = {value for _label, value in CONTROLS["tracks"]}
    if route in {"lego", "extract"} and out.get("track_name") not in tracks:
        raise ValueError("请选择目标声部。")
    if route == "complete":
        selected = out.get("complete_track_classes", [])
        if isinstance(selected, str):
            selected = [part.strip() for part in selected.split(",") if part.strip()]
        if not isinstance(selected, list) or not selected or any(not isinstance(value, str) or value not in tracks for value in selected):
            raise ValueError("请至少选择一个补全声部。")
        out["complete_track_classes"] = list(dict.fromkeys(selected))

    def number(key, default=None, minimum=0, maximum=None, integer=False):
        raw = out.get(key, default)
        try:
            value = float(raw)
        except (TypeError, ValueError):
            raise ValueError(f"请填写有效的 {key}。") from None
        if (not math.isfinite(value) or value < minimum
                or maximum is not None and value > maximum
                or integer and not value.is_integer()):
            raise ValueError(f"{key} 超出有效范围。")
        out[key] = int(value) if integer else value
        return value

    if route in {"repaint", "lego"}:
        if source_duration is None or not math.isfinite(source_duration) or source_duration <= 0:
            raise ValueError("无法读取源音频时长，请重新上传。")
        start = number("repainting_start", 0 if route == "lego" else None, maximum=source_duration)
        end = number("repainting_end", source_duration if route == "lego" else None, maximum=source_duration)
        if start >= end:
            raise ValueError("结束时间必须大于开始时间。")
    if route == "repaint":
        mode = out.get("repaint_mode", "balanced")
        if mode not in {"conservative", "balanced", "aggressive", "custom"}:
            raise ValueError("请选择有效的重绘模式。")
        if mode == "custom":
            out.pop("repaint_mode", None)
            out.pop("repaint_strength", None)
            number("repaint_crossfade_frames", 10, integer=True)
            number("repaint_injection_ratio", 0.5, maximum=1)
        else:
            out["repaint_mode"] = mode
            out.pop("repaint_crossfade_frames", None)
            out.pop("repaint_injection_ratio", None)
            if mode == "balanced":
                number("repaint_strength", 0.5, maximum=1)
            else:
                out.pop("repaint_strength", None)
    if route == "remix":
        start = number("flow_edit_n_min", 0, maximum=1)
        end = number("flow_edit_n_max", 1, maximum=1)
        if start > end:
            raise ValueError("流编辑起始比例不能大于终止比例。")
        number("flow_edit_n_avg", 2, minimum=1, integer=True)
    return out
