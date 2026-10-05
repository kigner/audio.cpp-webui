"""Presentation metadata for the local audio workbench; model specs stay authoritative."""
TASKS = {
    "tts": ("文字配音", ("tts", "clon")),
    "asr": ("音频转文字", ("asr",)),
    "music": ("音乐与音效", ("gen",)),
    "vc": ("声音转换", ("vc", "svc", "s2s")),
    "separation": ("音源分离", ("sep",)),
    "analysis": ("音频分析", ("vad", "diar", "align", "midi", "turn")),
    "design": ("声音设计", ("vdes",)),
}

# Only controls with a concrete, model-supported meaning enter the first two layers.
FRIENDLY = {
    "speed": ("语速", "控制说话速度；1 为模型默认速度。", "effect"),
    "semitone_shift": ("音高", "以半音调整音高，正数更高，负数更低。", "effect"),
    "retrieval_blend": ("目标音色融合", "控制检索音色特征的混合比例，需要检索索引。", "effect"),
    "audio_cover_strength": ("贴近原曲", "控制翻唱时对原曲的保留程度。", "effect"),
    "task_route": ("创作方式", "选择当前模型支持的创作方式。", "basic"),
    "speaker": ("说话人", "选择模型内置的说话人。", "basic"),
    "voice_id": ("内置音色", "使用随模型提供的音色。", "basic"),
    "voice": ("内置音色", "选择此模型支持的命名音色。", "basic"),
    "language": ("模型语言", "使用此模型的语言标识；自动时保留默认值。", "basic"),
    "instruction": ("表达风格", "描述语气或表达方式，仅对支持此功能的模型生效。", "effect"),
    "temperature": ("采样温度", "改变随机采样分布；建议保留此模型默认值。", "expert"),
    "top_p": ("累积概率采样", "限制候选范围；建议保留默认值。", "expert"),
    "top_k": ("候选数量", "限制采样候选数；不同模型含义和范围可能不同。", "expert"),
    "num_inference_steps": ("推理步数", "影响耗时和生成过程，更多步数不保证更好。", "expert"),
    "inference_steps": ("推理步数", "影响耗时和生成过程，建议使用模型默认值。", "expert"),
    "repetition_penalty": ("重复惩罚", "调整重复内容的抑制程度。", "expert"),
    "do_sample": ("随机采样", "关闭后使用模型支持的确定性选取策略。", "expert"),
}


def task_for(entry):
    token = entry.get("ui_task", entry.get("task"))
    return next((key for key, (_, tokens) in TASKS.items() if token in tokens), None)


def public_model(backend, entry):
    package = backend.SPEC_PACKAGE_BY_ID.get(entry.get("download_id"), {})
    download = package.get("download", {})
    repo = download.get("repo", "")
    sizes = getattr(backend, "_dl_size_cache", {})
    ids = [entry.get("download_id"), *entry.get("additional_download_ids", [])]
    known = [sizes.get(key) for key in ids]
    profile = backend.profile_for(entry)
    return {
        "id": entry["id"], "label": entry["label"], "family": entry["family"],
        "task": task_for(entry), "model_task": entry.get("ui_task", entry.get("task")),
        "installed": bool(entry.get("installed")), "incomplete": bool(entry.get("incomplete")),
        "installable": not entry.get("manual_install") and backend._webui_can_install_package(package),
        "manual_install": bool(entry.get("manual_install")),
        "min_vram_gb": entry.get("min_vram_gb"),
        "size_bytes": sum(known) if known and all(x is not None for x in known) else None,
        "missing": entry.get("missing_files", []),
        "description": profile.get("input_hint", ""),
        "download_id": entry.get("download_id"), "source": f"https://huggingface.co/{repo}" if repo else "",
        "backend": entry.get("backend", backend.SERVER_BACKEND),
        "format": package.get("format", ""), "precision": package.get("precision", ""),
        "revision": download.get("revision", "main"),
        "components": entry.get("additional_download_ids", []),
    }


def model_detail(backend, entry):
    result = public_model(backend, entry)
    prof = backend.profile_for(entry)
    params = []
    family, ident = entry["family"], entry["id"].lower()
    for raw in backend.params_for(entry["id"]):
        p = dict(raw)
        name = p["name"]
        if family == "minimax_h3" and name == "return_video":
            continue
        if family == "sam_audio" and name in {"image", "video", "image_path", "video_path", "reference_image_path", "reference_video_path"}:
            continue
        if family == "qwen3_tts":
            if name == "speaker" and "custom" not in ident:
                continue
            if name == "instruction" and not any(x in ident for x in ("custom", "design")):
                continue
        if family == "f5_tts" and name == "dialect" and "habibi" not in ident:
            continue
        scope = name.split("_options.", 1)[0] if "_options." in name else "request"
        label, help_text, level = FRIENDLY.get(name, (p.get("label", name), p.get("info", "使用模型默认值即可。"), "expert"))
        if scope != "request":
            level = "expert"
            help_text = (help_text or "") + " 修改后需要重新加载模型。"
        p.update(label=label, help=help_text, level=level, scope=scope,
                 min=p.get("minimum"), max=p.get("maximum"))
        params.append(p)
    package = backend.SPEC_PACKAGE_BY_ID.get(entry.get("download_id"), {})
    profile = {key: value for key, value in prof.items() if not callable(value)}
    result.update(
        parameters=params, profile=profile,
        languages=list(prof.get("lang_map", {})) or backend.LANGS,
        speakers=[], streaming=bool(prof.get("supports_streaming")),
        voice_mode="rvc" if prof.get("model_as_target_voice") else (
            "reference" if prof.get("accepts_voice_reference", True) else "builtin"),
        accepts_voice_reference=prof.get("accepts_voice_reference", True),
        require_voice=bool(prof.get("require_voice")),
        requires_reference_text=bool(prof.get("require_reference_text")),
        files=list(package.get("required_files", [])),
        install_path=entry.get("abs_path", ""),
        requirements="显存数值为估算；文件大小未知时会显示为待确认。已有模型和未完成下载会保留。",
    )
    return result
