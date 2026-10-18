"""Presentation metadata for the local audio workbench; model specs stay authoritative."""
import json
from pathlib import Path
try:
    from .parameter_i18n import localize_parameter
    from .ace_step_controls import CONTROLS as ACE_CONTROLS, dit_variant
    from .vc_controls import controls_for as vc_controls
except ImportError:
    from parameter_i18n import localize_parameter
    from ace_step_controls import CONTROLS as ACE_CONTROLS, dit_variant
    from vc_controls import controls_for as vc_controls

MODEL_INFO = json.loads((Path(__file__).parent / 'configs/model_info.json').read_text(encoding='utf-8'))
OMNIVOICE_LANGUAGES = json.loads((Path(__file__).parent / 'configs/omnivoice_languages.json').read_text(encoding='utf-8'))['languages']
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
    "num_inference_steps": ("推理步数", "步数会影响生成时间和效果，可以从默认值开始对比试听。", "expert"),
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

TTS_COMMON_PARAMETERS = {
    "kitten_tts2": {"preset"},
    "irodori_tts": {"duration_scale", "max_duration_sec"},
    "dramabox": {"duration_scale"},
    "echo_tts": {"max_duration_sec"},
    "sopro_tts": {"max_seconds"},
}

TTS_REFERENCE_PARAMETERS = {
    "qwen3_tts": {"x_vector_only_mode"},
    "irodori_tts": {"no_ref"},
    "echo_tts": {"reference_duration_sec"},
    "sopro_tts": {"ref_seconds"},
    "dramabox": {"reference_duration_sec"},
    "outetts": {"reference_language"},
    "dots_tts": {"source_text", "target_text", "use_xvector", "reference_duration_sec"},
}
TTS_PARAMETER_TEXT = {
    "preset": ("表达预设", "选择稳定或更富表现力的合成预设。"),
    "duration_scale": ("时长倍率", "1 使用默认时长；数值越大，语音越长。"),
    "max_duration_sec": ("最长生成时长（秒）", "限制本次合成的最长时长，过小可能截断内容。"),
    "max_seconds": ("最长生成时长（秒）", "限制本次合成的最长时长，过小可能截断内容。"),
    "reference_duration_sec": ("参考时长（秒）", "用于参考音频的时长，按模型默认值开始调整。"),
    "ref_seconds": ("参考时长（秒）", "用于参考音频的时长，按模型默认值开始调整。"),
    "reference_language": ("参考音频语言", "选择参考音频实际说出的语言。"),
    "x_vector_only_mode": ("仅提取音色", "开启后无需参考原文，仅使用参考音频的说话人特征。"),
    "no_ref": ("不使用参考音频", "开启时直接生成；关闭后需要选择参考音频。"),
    "source_text": ("源音频原文", "填写要编辑的源音频中的原话。"),
    "target_text": ("编辑后的文本", "填写期望编辑后的语音内容。"),
    "use_xvector": ("保留源音色", "编辑时使用源音频的说话人特征。"),
}

VC_COMMON_PARAMETERS = {
    'chatterbox': {'num_inference_steps', 's3gen_cfg_rate'},
    'seed_vc': {'num_inference_steps', 'intelligibility_guidance_scale',
                'similarity_guidance_scale', 'inference_guidance_scale'},
    'vevo2': {'num_inference_steps'},
    'rvc': {'rms_mix_rate', 'unvoiced_protection'},
    'tone_color_vc': {'temperature'},
}
VC_PARAMETER_TEXT = {
    'route': ('转换路线', '选择当前模型入口支持的转换路线。'),
    's3gen_cfg_rate': ('音色引导强度', '调整 Chatterbox 转换时的音色引导程度。'),
    'length_adjust': ('时长伸缩', '输出时长的倍率；1 保持原时长，数值必须大于 0。'),
    'intelligibility_guidance_scale': ('内容清晰度引导', 'Seed-VC V2 对源音频内容的引导强度。'),
    'similarity_guidance_scale': ('音色相似度引导', 'Seed-VC V2 对目标音色的引导强度。'),
    'inference_guidance_scale': ('转换引导强度', 'Seed-VC V1 的扩散引导强度。'),
    'voice_anonymization': ('声音匿名化', '使用随机平均音色进行匿名化转换。'),
    'f0_condition': ('使用音高条件', '需要支持音高条件的 V1 权重；歌声转换默认开启。'),
    'auto_f0_adjust': ('自动对齐音高', '将源音频音高向目标参考对齐；需开启音高条件。'),
    'use_pitch_shift': ('自动对齐音高', '按当前 Vevo2 路线对齐音高；留空使用路线默认值。'),
    'rms_mix_rate': ('音量包络混合', '0 更贴近源音频的音量变化，1 保留转换结果的音量变化。'),
    'unvoiced_protection': ('清辅音保护', '较小值保留更多原始清辅音特征；达到 0.5 时关闭保护。'),
}

# ASR controls are exposed only when the local request/result path can use them.
ASR_COMMON_PARAMETERS = {
    'return_timestamps', 'keep_tags', 'keep_language_tags', 'condition_on_previous_text',
    'enable_thinking', 'decoding_method', 'enable_endpoint',
}
# Fixed-checkpoint validation or output metadata, not a recognition-language choice.
ASR_HIDDEN_LANGUAGE = {'kroko_asr', 'lfm2_audio', 'higgs_audio_stt', 'granite5asr', 'niagara_asr', 'firered_audio', 'vibevoice_asr_streaming'}
ASR_AUTO_LANGUAGE = {'qwen3_asr': 'auto', 'confucius4_r2t2': 'Auto',
                     'sense_asr': 'auto', 'fun_asr_nano': 'auto', 'nemotron_asr': 'auto',
                     'owsm': 'auto', 'owsm_ctc': 'auto'}


def asr_parameter(parameter, family, spec):
    """Attach request-mode and dependency constraints alongside the UI control."""
    name = parameter['name']
    if parameter['scope'] != 'request':
        parameter['wide'] = any(p['name'] == name.split('.', 2)[-1] and p.get('type') == 'path'
                                for p in spec.get('options', {}).get(parameter['scope'], []))
        return
    if name in ASR_COMMON_PARAMETERS:
        parameter['level'] = 'basic'
    if name == 'return_timestamps':
        parameter.update(modes=['offline'], label='时间戳', help='保存模型返回的时间戳，同时启用详细结果下载。')
        if family == 'qwen3_asr':
            parameter.update(level='expert', help='需选择已安装的 Qwen3 强制对齐模型；更改对齐模型后，点击下方“应用并重载模型”。仅支持离线识别。')
    if name in {'clamp_timestamps_to_audio', 'preserve_punctuation'}:
        parameter.update(modes=['offline'], requires={'return_timestamps': [True]})
    if name.startswith('audio_chunk_') and family in {'qwen3_asr', 'parakeet_tdt', 'vibevoice_asr_streaming'}:
        parameter['modes'] = ['offline']
    if family == 'confucius4_r2t2' and name == 'max_tokens':
        parameter['modes'] = ['offline']
    if family == 'nemotron_asr':
        if name in {'speaker_mode', 'speaker_mask', 'speaker_segment_gap_sec', 'speaker_segment_max_sec'}:
            parameter['requires_value'] = ['speaker_probabilities']
        if name == 'speaker_mask':
            parameter['requires'] = {'speaker_mode': ['masked']}
        if name == 'speaker_segment_max_sec':
            parameter['modes'] = ['streaming']
    if any(p['name'] == name and p.get('type') == 'path' for p in spec.get('options', {}).get('request', [])):
        parameter['wide'] = True
    if name in {'audio_chunk_seconds', 'audio_chunk_duration_sec', 'audio_chunk_overlap_sec'}:
        parameter['excludes'] = {'audio_chunk_mode': ['none']}
    if name in {'temperature', 'top_k', 'top_p', 'seed'} and family in {'audio_flamingo', 'hviske_asr'}:
        parameter['requires'] = {'do_sample': [True]}
    if family == 'hviske_asr':
        if name in {'do_sample', 'temperature', 'top_k', 'top_p', 'seed'}:
            parameter.setdefault('requires', {})['num_beams'] = [1]
        if name == 'length_penalty':
            parameter['excludes'] = {'num_beams': [1]}
    if family == 'kroko_asr':
        if name in {'hotwords', 'hotwords_score', 'num_beams'}:
            parameter['requires'] = {'decoding_method': ['modified_beam_search']}
        if name.startswith('rule'):
            parameter['requires'] = {'enable_endpoint': [True]}
        if name == 'hotwords':
            parameter.update(lines=2, help='每行一个词组，也可用 / 分隔；仅改进束搜索支持热词。')
    if family == 'crisperwhisper' and name == 'transcription_mode':
        parameter['choices'] = [v for v in parameter.get('choices', []) if (v[1] if isinstance(v, list) else v) != 'verbatimize']
    if name in {'context', 'instruct', 'glossary'}:
        parameter['lines'] = 2
    if name == 'target_language' and family in {'canary_asr', 'owsm', 'owsm_ctc'}:
        parameter.update(type='choice', choices=[['不翻译', ''], *spec.get('languages', [])])


def asr_inputs(backend, entry, spec, parameters):
    family = entry['family']
    offline = 'offline' in spec.get('modes', ['offline'])
    language = next((p for p in parameters if p['name'] == 'language'), {})
    return {
        'context': family in {'qwen3_asr', 'audio_flamingo', 'samsone', 'higgs_audio_stt', 'confucius4_r2t2'},
        'context_label': '音频指令' if family in {'audio_flamingo', 'samsone', 'higgs_audio_stt'} else '专有名词',
        'language_auto': ASR_AUTO_LANGUAGE.get(family), 'language_default': language.get('default'),
        'details': offline,
        'dialogue': offline and family not in {'moss_transcribe_diarize', 'vibevoice_asr'},
        'dialogue_available': any(m.get('task') == 'diar' and m.get('installed') for m in backend.catalog_models()) if hasattr(backend, 'catalog_models') else False,
    }


def asr_aligner_models(backend):
    """Qwen3-ASR constructs a Qwen3ForcedAlignerSession, not a generic aligner."""
    entries = backend.catalog_models() if hasattr(backend, 'catalog_models') else []
    return [{'id': model['id'], 'label': model['label'],
             'value': str(model.get('gguf_path') or model.get('abs_path') or '').replace('\\', '/'),
             'install_path': str(model.get('abs_path') or '').replace('\\', '/'),
             'installed': bool(model.get('installed') and not model.get('incomplete')),
             'incomplete': bool(model.get('incomplete'))}
            for model in entries if model.get('family') == 'qwen3_forced_aligner' and model.get('task') == 'align']


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
    spec = getattr(backend, 'MODEL_SPECS', {}).get(family, {})
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
        if family == 'dots_tts' and ident == 'dots-tts-edit' and name == 'template_name':
            p.update(choices=['edit'], default='edit')
        if family == "firered_audio" and entry.get("task") == "gen" and name == "template_name":
            p.update(choices=[["声学编辑", "acoustic_edit"], ["语义编辑", "semantic_edit"]], default="acoustic_edit")
        if family == 'seed_vc' and name == 'route':
            allowed = {'v1_svc'} if entry.get('task') == 'svc' else {'v2_vc', 'v1_whisper_bigvgan_vc', 'v1_xlsr_hift_vc'}
            p['choices'] = [choice for choice in p.get('choices', [])
                            if (choice[1] if isinstance(choice, (list, tuple)) else choice) in allowed]
            p['default'] = 'v1_svc' if entry.get('task') == 'svc' else 'v2_vc'
        if result['task'] == 'vc' and family == 'vevo2' and name == 'route':
            controls = vc_controls(entry)
            p['choices'] = [choice for choice in p.get('choices', [])
                            if (choice[1] if isinstance(choice, (list, tuple)) else choice) in controls['routes']]
            p['default'] = controls['default_route']
        if result['task'] == 'vc' and family == 'seed_vc':
            if name == 'f0_condition':
                p['default'] = entry.get('task') == 'svc'
            if name == 'length_adjust':
                p['minimum'] = p.get('step', 0.05)
        if family == "ace_step" and name == "num_inference_steps":
            p["route_defaults"] = {"remix": 16}
        if family == "ace_step" and name == "guidance_scale":
            p.update(route_defaults={"extract": 7.0}, maximum=max(p.get("maximum", 0), 7.0))
        scope = name.split("_options.", 1)[0] if "_options." in name else "request"
        label, help_text, level = FRIENDLY.get(name, (p.get("label", name), p.get("info", "使用模型默认值即可。"), "expert"))
        if name in COMMON_FAMILY_PARAMETERS.get(family, set()):
            level = "effect"
        if result['task'] == 'tts' and name in TTS_COMMON_PARAMETERS.get(family, set()):
            level = 'effect'
        if result['task'] == 'vc':
            label, help_text = VC_PARAMETER_TEXT.get(name, (label, help_text))
            if name in VC_COMMON_PARAMETERS.get(family, set()):
                level = 'effect'
        if family == "firered_audio" and name == "template_name":
            label, level = "编辑方式", "basic"
        if scope != "request":
            level = "expert"
            help_text = (help_text or "") + " 修改后需要重新加载模型。"
        p.update(label=label, help=help_text, level=level, scope=scope,
                 min=p.get("minimum"), max=p.get("maximum"))
        if result['task'] == 'tts' and scope == 'request':
            if name in TTS_PARAMETER_TEXT:
                p['label'], p['help'] = TTS_PARAMETER_TEXT[name]
            if name in TTS_REFERENCE_PARAMETERS.get(family, set()):
                p.update(level='effect', placement='reference')
            if name in {'source_text', 'target_text', 'instruction', 'instruct', 'emotion_text'}:
                p.update(rows=2, lines=2)
        if result['task'] == 'asr':
            asr_parameter(p, family, spec)
            if family == 'qwen3_asr' and name == 'session_options.qwen3_asr.forced_aligner_path':
                p.update(type='model', label='强制对齐模型', wide=True,
                         model_choices=asr_aligner_models(backend),
                         help='选择模型中心已安装的 Qwen3 Forced Aligner，自动使用其安装路径；更改后应用并重载模型。')
        if scope != 'request':
            key = name.rsplit('.', 1)[-1]
            p['runtime_group'] = 'common' if key in {'weight_type', 'matmul_weight_type', 'mem_saver', 'threads'} or p.get('model_choices') else 'advanced'
            if key.endswith('weight_type'):
                p['help'] = ('模型默认：保留模型和后端的默认策略。跟随权重文件（native）：使用文件中各张量的存储格式。'
                             '其他选项仅改变运行时权重格式；Q8 转为 F32 不会恢复量化损失，并会增加内存占用。修改后需要重新加载模型。')
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
        if family == "ace_step":
            result["music_inputs"]["ace_step"] = {**ACE_CONTROLS, "dit_variant": dit_variant(entry)}
    if result['task'] == 'asr':
        result['asr_inputs'] = asr_inputs(backend, entry, spec, params)
    if result['task'] == 'vc':
        result['vc_controls'] = vc_controls(entry)
    if result['task'] == 'tts':
        result['tts_controls'] = {}
        if family == 'kokoro_tts':
            languages = dict(a='en-us', b='en-gb', e='es', f='fr-fr', h='hi', i='it', j='ja', p='pt-br', z='zh')
            result['tts_controls']['voice_languages'] = {
                voice: languages[voice[0]] for voice in spec.get('ui', {}).get('builtin_voices', [])}
        if family in {'moss_ttsd', 'vibevoice'}:
            result['tts_controls']['speakers'] = {'first': 1 if family == 'moss_ttsd' else 0,
                                                'allow_empty': family == 'moss_ttsd'}
    return result


def parameter_applies(entry, name):
    """Family contracts can describe several tasks; hide parameters for other tasks."""
    family, task = entry['family'], entry.get('task')
    if family == 'voxcpm1' and name in {'load_options.voxcpm1.weight_type', 'load_options.voxcpm1.audiovae_weight_type'}:
        return False  # VoxCPM1 consumes precision in session options, not its loader.
    if family == 'chatterbox' and task == 'vc' and name in {
            'session_options.chatterbox.t3_weight_type', 'session_options.chatterbox.multilingual_t3',
            'session_options.chatterbox.t3_speech_cond_prompt_len'}:
        return False  # Conversion bypasses T3 text generation.
    if family == 'vibevoice_asr' and name == 'session_options.vibevoice_asr.max_history_steps':
        return False  # Only the separate streaming session consumes history.
    if name.startswith(('session_options.', 'load_options.')):
        return True
    if task == 'asr' and ((name == 'language' and family in ASR_HIDDEN_LANGUAGE) or
                          (family == 'nemotron_asr' and name in {'streaming', 'return_timestamps'})):
        return False
    if family == 'index_tts2' and name == 'lang':
        return False  # the main language control sends the backend's language key
    if task in {'tts', 'clon'}:
        if family == 'voxcpm1' and name == 'prompt_text':
            return False  # the reference transcript already sends the supported reference_text alias
        if family in {'moss_ttsd', 'vibevoice'} and name in {'voice_samples', family + '.voice_samples'}:
            return False  # speaker audio selectors resolve files through the upload/library API
        if family == 'dots_tts' and name in {'source_audio', 'source_text', 'target_text', 'use_xvector'}:
            editing = entry['id'] == 'dots-tts-edit'
            return editing and name != 'source_audio'
    if family == 'dots_tts' and name in {'instruction', 'instruct'}:
        editing = entry['id'] == 'dots-tts-edit' or entry.get('default_options', {}).get('template_name') == 'edit'
        return editing and name == 'instruction'  # Alias is redundant; ordinary TTS never consumes either field.
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
    if entry['family'] == 'omnivoice':
        return OMNIVOICE_LANGUAGES
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
