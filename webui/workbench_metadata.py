"""Presentation metadata for the local audio workbench; model specs stay authoritative."""
import json
from pathlib import Path
try:
    from .parameter_i18n import localize_parameter
except ImportError:
    from parameter_i18n import localize_parameter

MODEL_INFO = json.loads((Path(__file__).parent / 'configs/model_info.json').read_text(encoding='utf-8'))
TASKS = {
    "tts": ("语音合成", ("tts", "clon")),
    "asr": ("语音识别", ("asr",)),
    "music": ("音乐与音效", ("gen",)),
    "vc": ("声音转换", ("vc", "svc")),
    "processing": ("音频处理", ("s2s",)),
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
    "tags": ("音乐风格标签", "填写逗号分隔的风格、情绪与乐器标签。", "basic"),
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
    info = MODEL_INFO['models'].get(entry['id'], {})
    memory = info.get('memory_range_gb')
    return {
        "id": entry["id"], "label": entry["label"], "family": entry["family"],
        "task": task_for(entry), "model_task": entry.get("ui_task", entry.get("task")),
        "installed": bool(entry.get("installed")), "incomplete": bool(entry.get("incomplete")),
        "installable": not entry.get("manual_install") and backend._webui_can_install_package(package),
        "manual_install": bool(entry.get("manual_install")),
        "min_vram_gb": entry.get("min_vram_gb") or (memory[0] if memory and info.get('memory_device') != 'ram' else None),
        "memory_range_gb": memory, "memory_device": info.get('memory_device', 'vram'),
        "memory_basis": info.get('memory_basis', ''),
        "size_bytes": (info.get('size_bytes') if len(ids) > 1 and info.get('size_bytes') else
                       sum(known) if known and all(x is not None for x in known) else info.get('size_bytes')),
        "size_estimate_gb": info.get('size_estimate_gb'), "size_kind": info.get('size_kind'),
        "size_note": info.get('size_note', ''), "sources": info.get('sources', []),
        "original_sources": info.get('original_sources', []),
        "info_checked_at": MODEL_INFO['checked_at'] if info else None,
        "missing": entry.get("missing_files", []),
        "description": info.get('description') or profile.get("input_hint", ""),
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
        p = localize_parameter(raw)
        name = p["name"]
        if not parameter_applies(entry, name):
            continue
        if family == "minimax_h3" and name == "return_video":
            continue
        if family == "sam_audio" and name in {"image", "video", "image_path", "video_path", "reference_image_path", "reference_video_path"}:
            continue
        if family == "qwen3_tts":
            if name == "speaker" and "custom" not in ident:
                continue
            if name == "instruction" and not any(x in ident for x in ("custom", "design")):
                continue
        if family == "f5_tts" and name in {"dialect", "strip_diacritics"} and "habibi" not in ident:
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
    spec = getattr(backend, 'MODEL_SPECS', {}).get(family, {})
    result.update(
        parameters=params, profile=profile,
        languages=model_languages(entry, spec, prof, params),
        speakers=[], streaming=bool(prof.get("supports_streaming")),
        voice_mode="rvc" if prof.get("model_as_target_voice") else (
            "reference" if prof.get("accepts_voice_reference", True) else "builtin"),
        accepts_voice_reference=prof.get("accepts_voice_reference", True),
        require_voice=bool(prof.get("require_voice")),
        requires_reference_text=bool(prof.get("require_reference_text")),
        files=list(dict.fromkeys(file for package_id in [entry.get('download_id'), *entry.get('additional_download_ids', [])]
                                 for file in backend.SPEC_PACKAGE_BY_ID.get(package_id, {}).get('required_files', []))),
        install_path=entry.get("abs_path", ""),
        requirements="显存数值为估算；文件大小未知时会显示为待确认。已有模型和未完成下载会保留。",
    )
    if result["task"] == "music":
        result["music_inputs"] = music_inputs(backend, entry, prof, params)
    if result['task'] == 'asr':
        offline = 'offline' in spec.get('modes', ['offline'])
        result['asr_inputs'] = {'context': family in {'qwen3_asr', 'audio_flamingo', 'samsone'},
                                'context_label': '音频指令' if family in {'audio_flamingo', 'samsone'} else '专有名词',
                                'details': offline, 'dialogue': offline}
    return result


def parameter_applies(entry, name):
    """Family contracts can describe several tasks; hide parameters for other tasks."""
    family, task = entry['family'], entry.get('task')
    if name.startswith(('session_options.', 'load_options.')):
        return True
    if family == 'lfm2_audio':
        asr = {'language', 'max_tokens', 'audio_chunk_mode', 'audio_chunk_seconds'}
        return name in asr if task == 'asr' else name not in {'audio_chunk_mode', 'audio_chunk_seconds'}
    if family == 'firered_audio':
        if name == 'template_name':
            return False  # the selected entry binds its route
        if task == 'asr':
            return name in {'language', 'max_new_tokens'}
        if name in {'max_new_tokens', 'enable_thinking', 'top_k', 'top_p', 'temperature'}:
            return False
        if name == 'instruction':
            return task == 'vdes'
    if family == 'fireredtts3':
        if name == 'template_name':
            return False
        if name == 'instruction':
            return task == 'vdes'
    if family == 'crisperwhisper' and task == 'align':
        return name not in {'transcription_mode', 'return_timestamps'}
    if family == 'auk' and task == 'gen' and name == 'instruct':
        return False  # editing instructions travel through text
    if family == 'qwen3_tts' and name == 'x_vector_only_mode':
        return task != 'vdes' and 'custom' not in entry['id']
    return True


def model_languages(entry, spec, profile, parameters):
    mapping = profile.get('lang_map', {})
    if mapping:
        # Keep accepted legacy input keys while suppressing duplicate language aliases.
        seen, result = set(), []
        for key, value in mapping.items():
            if value not in seen:
                seen.add(value)
                result.append(key)
        return result
    option = next((p for p in parameters if p['name'] == 'language'), None)
    if option is None:
        return []
    languages = option.get('choices') or spec.get('languages', [])
    languages = [value for value in languages if value not in {'auto', 'multilingual', 'zh dialects'}]
    return languages


def music_inputs(backend, entry, profile, parameters):
    """Expose only inputs consumed by the existing local generation request path."""
    spec = getattr(backend, "MODEL_SPECS", {}).get(entry["family"], {})
    request = {option["name"]: option for option in spec.get("options", {}).get("request", [])}
    controls = {parameter["name"]: parameter for parameter in parameters}
    route = controls.get("task_route", {})
    routes = route.get("choices", [])
    # Legacy text2music routes and init/inpaint controls predate spec option metadata.
    # Their existing parameter contracts identify the supported input semantics;
    # broad capability tags do not (Stable Audio's spec also carries a lyrics tag).
    legacy_routes = routes if "text2music" in routes else []
    audio_conditioning = "audio_input_kind" in controls
    lyrics_option = request.get("lyrics", {})
    lyrics_in_text = "lyrics" in request and "tags" in request
    editing = bool(profile.get("require_source_audio") or profile.get("edit_instruction_key"))
    duration = request.get("duration_sec") or request.get("duration_seconds") or {}
    duration_supported = bool(duration or legacy_routes or audio_conditioning)
    minimum = duration.get("min", 0.1)
    # The local request builder omits nonpositive durations for these profiles.
    automatic_duration = bool(profile.get("omit_nonpositive_duration") or legacy_routes)
    return {
        "text_role": "lyrics" if lyrics_in_text else "instruction" if editing else "prompt",
        "text_label": "歌词" if lyrics_in_text else "编辑指令" if editing else "音乐或音效描述",
        "lyrics": not lyrics_in_text and bool(lyrics_option or profile.get("require_lyrics") or legacy_routes),
        "require_lyrics": not lyrics_in_text and bool(profile.get("require_lyrics") or lyrics_option.get("required")),
        "source_audio": bool(editing or audio_conditioning or legacy_routes),
        "require_source_audio": bool(profile.get("require_source_audio")),
        "source_audio_routes": [value for value in legacy_routes if value != "text2music"] if legacy_routes else None,
        "source_required_routes": [value for value in legacy_routes if value not in {"text2music", "complete"}],
        "duration": duration_supported,
        "duration_default": duration.get("default", -1 if automatic_duration else 30),
        "duration_min": -1 if automatic_duration else max(minimum, 0.001),
        "duration_max": duration.get("max"),
    }
