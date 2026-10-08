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
    "instruct": ("声音指令", "描述希望生成的声音或当前音频任务。", "effect"),
    "speaking_rate": ("语速", "调整当前模型的说话速度。", "effect"),
    "lang": ("语言", "选择当前模型使用的语言。", "basic"),
    "target_language": ("目标语言", "选择翻译后的语言；留空按模型默认处理。", "basic"),
    "dialect": ("方言", "选择模型支持的方言。", "basic"),
    "speaker_id": ("说话人", "选择多说话人模型中的音色编号。", "basic"),
    "emotion": ("情感", "选择模型支持的情感。", "effect"),
    "emotion_text": ("情感描述", "描述想要的情绪，填写后自动启用；留空沿用参考声音。", "effect"),
    "emotion_alpha": ("情感强度", "调整情感表现的强弱。", "effect"),
    "use_emotion_text": ("从朗读文本推断情感", "未填写情感描述时，从合成文本推断情绪。", "effect"),
    "exaggeration": ("情感表现", "调整 Chatterbox 的情感表现程度。", "effect"),
    "duration_sec": ("时长（秒）", "设置生成音频的目标时长。", "effect"),
    "bpm": ("节奏 BPM", "每分钟节拍数；0 使用模型默认。", "basic"),
    "keyscale": ("调性", "设置音乐调性。", "basic"),
    "timesignature": ("拍号", "设置音乐拍号。", "basic"),
    "negative_prompt": ("避免的内容", "描述不希望出现的声音或风格。", "effect"),
    "hotwords": ("热词", "填写需要优先识别的人名、产品名或专业词汇。", "basic"),
    "glossary": ("术语表", "填写翻译时需要使用的术语。", "basic"),
    "context": ("上下文提示", "提供有助于识别的背景或专有名词。", "basic"),
    "enable_itn": ("规范数字书写", "将口语中的数字等转换为常用书写形式。", "basic"),
    "pnc": ("标点与大小写", "启用识别结果中的标点和大小写。", "basic"),
    "punctuation": ("标点", "在识别结果中保留标点。", "basic"),
    "transcription_mode": ("转写方式", "选择逐字记录或整理后的文字。", "basic"),
    "instruments": ("乐器", "指定需要提取乐谱的乐器。", "basic"),
    "temperature": ("采样温度", "改变随机采样分布；建议保留此模型默认值。", "expert"),
    "top_p": ("累积概率采样", "限制候选范围；建议保留默认值。", "expert"),
    "top_k": ("候选数量", "限制采样候选数；不同模型含义和范围可能不同。", "expert"),
    "num_inference_steps": ("推理步数", "影响耗时和生成过程，更多步数不保证更好。", "expert"),
    "inference_steps": ("推理步数", "影响耗时和生成过程，建议使用模型默认值。", "expert"),
    "repetition_penalty": ("重复惩罚", "调整重复内容的抑制程度。", "expert"),
    "do_sample": ("随机采样", "关闭后使用模型支持的确定性选取策略。", "expert"),
}

# These names have a user-facing meaning only in the specified families.
COMMON_FAMILY_PARAMETERS = {
    "index_tts2": {"duration_factor", "interval_silence_ms"},
    "stable_audio": {"audio_input_kind"},
    "seed_vc": {"route", "length_adjust", "voice_anonymization", "auto_f0_adjust"},
    "vevo2": {"route", "use_pitch_shift"},
    "personaplex": {"system_prompt"},
    "muscriptor": {"output_format"},
    "vibeasr": {"output_format"},
    "cosyvoice3": {"template_name"},
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
        if family == "firered_audio" and entry.get("task") == "gen" and name == "template_name":
            p.update(choices=[["声学编辑", "acoustic_edit"], ["语义编辑", "semantic_edit"]], default="acoustic_edit")
        if family == "ace_step" and name == "num_inference_steps":
            p["route_defaults"] = {"remix": 16}
        if family == "ace_step" and name == "guidance_scale":
            p.update(route_defaults={"extract": 7.0}, maximum=max(p.get("maximum", 0), 7.0))
        scope = name.split("_options.", 1)[0] if "_options." in name else "request"
        label, help_text, level = FRIENDLY.get(name, (p.get("label", name), p.get("info", "使用模型默认值即可。"), "expert"))
        if name in COMMON_FAMILY_PARAMETERS.get(family, set()):
            level = "effect"
        if family == "firered_audio" and name == "template_name":
            label, level = "编辑方式", "basic"
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
        max_tokens_min=next((p.get('min', 1) for p in spec.get('options', {}).get('request', [])
                             if p['name'] == 'max_tokens'), 1),
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
        result['asr_inputs'] = {'context': family in {'qwen3_asr', 'audio_flamingo', 'samsone', 'higgs_audio_stt', 'confucius4_r2t2'},
                                'context_label': '音频指令' if family in {'audio_flamingo', 'samsone', 'higgs_audio_stt'} else '专有名词',
                                'details': offline, 'dialogue': offline}
    return result


def parameter_applies(entry, name):
    """Family contracts can describe several tasks; hide parameters for other tasks."""
    family, task = entry['family'], entry.get('task')
    if name.startswith(('session_options.', 'load_options.')):
        return True
    if family == 'index_tts2' and name == 'lang':
        return False  # the main language control sends the backend's language key
    if family == 'dots_tts' and name == 'instruct':
        return False  # CLI alias for instruction, not a second user-facing input
    if family == 'lfm2_audio':
        asr = {'language', 'max_tokens', 'audio_chunk_mode', 'audio_chunk_seconds'}
        return name in asr if task == 'asr' else name not in {'audio_chunk_mode', 'audio_chunk_seconds'}
    if family == 'firered_audio':
        if name == 'template_name':
            return task == 'gen'  # editing supports both acoustic and semantic routes
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
