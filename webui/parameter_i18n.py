"""Chinese presentation for model options. Wire names and tested values stay intact."""
import re

# Exact meanings take precedence over compositional runtime-memory labels.
LABELS = dict(line.split('=', 1) for line in '''
temperature=采样温度
top_k=候选数量
top_p=累积概率采样
min_p=最低相对概率
do_sample=随机采样
repetition_penalty=重复惩罚
repetition_window=重复检测窗口
num_inference_steps=推理步数
inference_steps=推理步数
guidance_scale=引导强度
cfg_strength=条件引导强度
sway_sampling_coef=采样曲线偏移
speed=语速
speaking_rate=说话速度
speaker=说话人
speaker_id=说话人编号
voice=内置音色
voice_id=内置音色
language=语言
lang=语言
instruction=表达风格
instruct=声音指令
seed=随机种子
max_tokens=生成长度上限
max_new_tokens=新增标记上限
max_new_text_tokens=文本生成长度上限
max_new_audio_steps=音频生成步数上限
min_new_audio_steps=音频生成步数下限
max_text_tokens=文本长度上限
max_input_tokens=输入长度上限
max_target_tokens=目标长度上限
min_tokens=生成长度下限
text_chunk_size=文本分段长度
text_chunk_mode=文本分段方式
audio_chunk_mode=音频分段方式
audio_chunk_seconds=音频分段上限（秒）
audio_chunk_duration_sec=音频分段时长（秒）
audio_chunk_threshold_sec=自动分段阈值（秒）
audio_chunk_overlap_sec=音频分段重叠（秒）
duration_sec=生成时长（秒）
duration_seconds=生成时长（秒）
duration_scale=时长倍率
duration_variation=时长变化幅度
length_adjust=时长调整
length_penalty=长度惩罚
max_duration_sec=最长时长（秒）
min_duration_sec=最短时长（秒）
max_seconds=最长时长（秒）
min_seconds=最短时长（秒）
reference_text=参考音频原文
reference_language=参考音频语言
reference_duration_sec=参考音频时长（秒）
ref_seconds=参考时长（秒）
prompt_text=提示文本
context=上下文提示
glossary=术语表
hotwords=热词
hotwords_score=热词权重
system_prompt=系统提示词
source_text=源文本
target_text=目标文本
source_audio=源音频
target_voice=目标音色
target_language=目标语言
target_rms=目标均方根音量
negative_prompt=反向提示词
lyrics=歌词
tags=风格标签
style=风格
emotion=情感
dialect=方言
strip_diacritics=移除变音符
text_normalization=文本规范化
phonemes=音素序列
speaker_mode=说话人模式
speaker_threshold=说话人活动阈值
speaker_min_frames=说话片段最少帧数
speaker_pad_frames=说话片段补边帧数
speaker_probabilities=输出说话人概率
speaker_mask=说话人遮罩
speaker_kv_scale=说话人注意力缓存强度
speaker_scale=说话人条件强度
speaker_segment_gap_sec=说话人片段间隔（秒）
speaker_segment_max_sec=说话人片段上限（秒）
streaming=启用流式
offline_mode=离线处理方式
stream_frames_per_event=每次流式输出帧数
stream_lookahead_margin=流式前瞻保留帧数
streaming_attention_mode=流式注意力模式
latency_profile=延迟配置
return_timestamps=返回时间戳
return_frame_probabilities=返回逐帧概率
return_video=输出视频
clamp_timestamps_to_audio=将时间戳限制在音频范围内
preserve_punctuation=保留标点
transcription_mode=转写方式
condition_on_previous_text=沿用上一段文本
keep_language_tags=保留语言标签
keep_tags=保留特殊标签
rollback_punctuation=回退末尾标点
punctuation=标点处理
pnc=标点与大小写恢复
enable_itn=逆文本规范化
decoding_method=解码方式
beam_size=束搜索宽度
num_beams=束搜索数量
blank_penalty=空白标记惩罚
eos_bias=结束标记偏置
enable_endpoint=启用端点检测
rule1_min_trailing_silence_sec=规则一：末尾静音（秒）
rule2_min_trailing_silence_sec=规则二：末尾静音（秒）
rule3_min_utterance_length_sec=规则三：最短发言（秒）
threshold=检测阈值
min_silence_duration_ms=最短静音（毫秒）
min_speech_duration_ms=最短语音（毫秒）
merge_threshold_sec=片段合并阈值（秒）
chunk_len=分块长度
chunk_right_context=分块右侧上下文
chunk_size_ms=分块大小（毫秒）
left_context_sec=左侧上下文（秒）
right_context_sec=右侧上下文（秒）
emission_context_sec=输出上下文（秒）
emission_window_sec=输出窗口（秒）
split_center_sec=分段中心（秒）
split_query_sec=分段查询窗口（秒）
split_threshold_sec=分段触发阈值（秒）
session_len_sec=会话长度（秒）
fifo_len=先进先出缓存长度
spkcache_len=说话人缓存长度
spkcache_update_period=说话人缓存更新周期
input_sample_rate=输入采样率
output_sample_rate=输出采样率
output_format=输出格式
hop_size_samples=帧移采样点数
batch_size=批大小
sampler=采样器
sampler_mode=采样方式
shift=采样偏移
t_shift=时间偏移
flow_shift=流采样偏移
audio_flow_shift=音频流采样偏移
ddim_eta=扩散随机强度
guidance_mode=引导方式
guidance_rescale=引导重缩放
guidance_interval=引导生效区间
guidance_min_t=引导起始时间
guidance_max_t=引导终止时间
fused_cfg=融合条件引导
no_ref=禁用参考条件
multi_reference_cond=多参考音频条件
use_xvector=使用声纹向量
x_vector_only_mode=仅使用声纹向量
voice_anonymization=音色匿名化
auto_f0_adjust=自动调整基频
f0_condition=基频条件
pitch_extractor=音高提取器
pitch_filter_radius=音高滤波半径
semitone_shift=音高偏移（半音）
retrieval_blend=目标音色融合
rms_mix_rate=音量包络混合比例
unvoiced_protection=清辅音保护
denoise=降噪
feat_scale=特征缩放
retry_badcase=异常结果自动重试
retry_badcase_max_times=异常结果最多重试次数
retry_badcase_ratio_threshold=异常长度比例阈值
trim_tail=裁剪尾部
postprocess_output=输出后处理
preprocess_prompt=预处理参考音频
cross_fade_duration_sec=交叉淡化时长（秒）
edge_fade_duration_sec=边缘淡化时长（秒）
edge_pad_duration_sec=边缘补齐时长（秒）
audio_pad_duration_sec=音频补齐时长（秒）
codec_duration_sec=编解码窗口时长（秒）
num_clips=片段数量
num_frames=帧数
max_frames=最大帧数
frame_budget=帧数预算
num_overlap=重叠数量
height=高度
width=宽度
video=视频输入
geometry=几何条件
anchors=时间锚点
mask_away_clip=屏蔽片段
stop_threshold=结束阈值
min_stop_step=最早结束步数
stop_after=停止位置
truncation_factor=截断系数
variation=变化强度
position_temperature=位置采样温度
class_temperature=类别采样温度
depth_temperature=深度解码采样温度
template_name=任务模板
generation_mode=生成方式
route=处理路径
preset=预设
variant=模型变体
utility=音频工具类型
cot=中间推理标记
enable_thinking=启用推理过程
export_semantic=导出语义标记
semantic_prefix=语义前缀
abc=乐谱文本
abc_file=乐谱文本文件
instruments=乐器
tokens=标记序列
infinite_mode=无限生成模式
infinite_chunk_audio_duration_ms=无限模式分段时长（毫秒）
unfixed_chunk_num=未固定分块数
unfixed_token_num=未固定标记数
lookahead_tokens=前瞻标记数
pre_tail_tokens=尾部预留标记数
prelude_forcing=强制前奏
star_frequency=星号标记频率
layer_penalty_factor=层惩罚系数
target_cache_blocks=目标缓存块数
vocoder_merge_steps=声码器合并步数
voice_samples=参考音色列表
attention=注意力实现
perf_mode=性能模式
sage_attention=加速注意力
dit_acceleration=扩散变换器加速方式
encoder_gelu=编码器激活实现
cpu_blas_scheduler=处理器矩阵运算调度
bf16_activations=使用脑浮点激活
memory_bounded=限制运行内存
mem_saver=节省显存
memory_saver=节省显存
aggressive_mem_saver=强化显存节省
denoiser_weight_streaming=按需载入去噪器权重
denoiser_layerwise=去噪器逐层运行
denoiser_layerwise_batch=去噪器逐层批大小
dit_layerwise=扩散变换器逐层运行
dit_layerwise_batch=扩散变换器逐层批大小
dit_mlp_chunk_tokens=扩散前馈网络分块标记数
text_layerwise=文本模型逐层运行
text_layerwise_batch=文本模型逐层批大小
vae_cache_f16=半精度自编码器缓存
vae_decoder_tile_size=自编码器解码分块大小
vae_encoder_chunk_size=自编码器编码分块大小
graph_capacity_mode=计算图容量策略
codec_backend=编解码器运行设备
max_alignment_cells=对齐矩阵单元上限
first_block_cache_threshold=首块缓存阈值
first_block_cache_start_sigma=首块缓存起始噪声级
first_block_cache_end_sigma=首块缓存终止噪声级
first_block_cache_max_consecutive=首块缓存最大连续复用次数
spectrum_degree=频谱拟合阶数
spectrum_flex_window=频谱弹性窗口
spectrum_history_size=频谱历史长度
spectrum_initial_window=频谱初始窗口
spectrum_ridge_lambda=频谱正则化系数
spectrum_warmup_steps=频谱预热步数
task_route=创作方式
audio_cover_strength=贴近原曲
cover_noise_strength=翻唱噪声强度
source_caption=原曲描述
source_lyrics=原曲歌词
flow_edit_n_min=流编辑起始步数
flow_edit_n_max=流编辑终止步数
flow_edit_n_avg=流编辑平均次数
bpm=每分钟节拍
keyscale=调性
timesignature=拍号
audio_input_kind=源音频用途
init_noise_level=初始噪声强度
frames_after_eos=结束标记后保留帧数
best_of_n=候选生成次数
max_length_times=最大长度倍率
emotion_text=情感描述
emotion_alpha=情感强度
use_emotion_text=使用情感描述
use_random_emotion=随机情感
interval_silence_ms=句间静音（毫秒）
duration_factor=时长系数
exaggeration=情感夸张程度
s3gen_cfg_rate=语音解码引导强度
use_pitch_shift=启用音高偏移
'''.strip().splitlines())

PREFIXES = {
    'abc': '乐谱', 'semantic': '语义', 'subtalker': '子说话器', 'text': '文本',
    'flow': '流模型', 'ar': '自回归', 'nar': '非自回归', 'codec': '编解码器',
    'audio_encoder': '音频编码器', 'audio_tokenizer': '音频分词器', 'audiovae': '音频自编码器',
    'backbone': '主干网络', 'code_predictor': '码本预测器', 'condition': '条件模块',
    'conditioning': '条件模块', 'dac': '音频编解码器', 'decoder': '解码器', 'depformer': '深度变换器',
    'dit': '扩散变换器', 'encoder': '编码器', 'flow_estimator': '流估计器',
    'frame_embedding': '帧嵌入', 'generator': '生成器', 'helper': '辅助模块',
    'llama': '语言模型', 'llm': '语言模型', 'lm': '语言模型', 'local_encoder': '局部编码器',
    'mimi': '音频编解码器', 'model': '模型', 'patch_encoder': '分块编码器',
    'projection': '投影层', 'projector': '投影器', 'rf': '整流流模型', 'runtime': '运行时',
    'scalar_decoder': '标量解码器', 'speaker_encoder': '说话人编码器',
    'speech_decoder': '语音解码器', 'speech_encoder': '语音编码器', 'talker': '语音生成器',
    'text_decoder': '文本解码器', 'text_embedding': '文本嵌入', 'thinker': '思考模型', 'vae': '自编码器',
    'conv': '卷积层', 'linear': '线性层', 'matmul': '矩阵乘法', 'intelligibility': '清晰度',
    'similarity': '相似度', 'inference': '推理', 'speaker': '说话人', 'caption': '描述',
    'spatio_temporal': '时空', 'vocoder': '声码器', 'denoiser': '去噪器',
    'detokenizer': '反分词器', 'language_model': '语言模型', 'mmproj': '多模态投影',
    'qwen': '通义模型', 'support': '辅助组件', 'flow_transformer': '流变换器',
    'rvq_depth_decoder': '残差量化深度解码器', 'prompt': '提示', 'reference': '参考音频',
    'voice': '音色', 'voice_prompt': '音色提示', 'aligner': '对齐器', 'forced_aligner': '强制对齐器',
    'vad': '语音活动检测', 'vad_model': '语音活动检测模型', 'vocos': '声码器',
    'pitch': '音高', 'retrieval_index': '检索索引', 'voice_model': '音色模型',
    'reference_image': '参考图像', 'reference_video': '参考视频', 'espeak_data': '语音前端数据',
    'espeak_library': '语音前端动态库', 'flow_noise': '流噪声', 'noise': '噪声',
    'semantic_prefix': '语义前缀', 'hift_source_random': '声码器源噪声',
}
SUFFIXES = {
    'graph_arena_mb': '计算图内存（MB）', 'graph_context_mb': '计算图上下文内存（MB）',
    'weight_context_mb': '权重上下文内存（MB）', 'constant_context_mb': '常量内存（MB）',
    'weight_type': '权重精度', 'gguf': '权重文件', 'cache_slots': '缓存槽数',
    'path': '路径', 'file': '文件', 'noise_file': '噪声文件', 'lora': '低秩适配器',
    'lora_scale': '适配器强度', 'sample_capacity': '采样点容量', 'latent_capacity': '潜变量容量',
    'penalty_window': '惩罚窗口',
}
SPECIAL = {
    'graph_arena_mb': '计算图内存（MB）', 'graph_context_mb': '计算图上下文内存（MB）',
    'weight_context_mb': '权重上下文内存（MB）', 'constant_context_mb': '常量内存（MB）',
    'weight_type': '权重精度', 'decode_graph_arena_mb': '解码计算图内存（MB）',
    'prefill_graph_arena_mb': '预填充计算图内存（MB）',
    'hift_prior_noise_count': '声码器先验噪声数量',
    'predictor_duration_graph_mb': '时长预测图内存（MB）',
    'predictor_tail_graph_mb': '尾部预测图内存（MB）',
    'predictor_text_graph_mb': '文本预测图内存（MB）',
}


def option_label(name):
    key = name.rsplit('.', 1)[-1]
    if key in LABELS or key in SPECIAL:
        return LABELS.get(key, SPECIAL.get(key))
    for suffix, text in sorted({**SUFFIXES, **LABELS}.items(), key=lambda item: -len(item[0])):
        if not key.endswith('_' + suffix):
            continue
        prefix = key[:-len(suffix)-1]
        if prefix in PREFIXES:
            return PREFIXES[prefix] + text
        tail = ''
        for stage, chinese in [('prefill', '预填充'), ('decode', '解码'), ('step', '单步'), ('encoder', '编码器'), ('conv', '卷积')]:
            if prefix.endswith('_' + stage):
                prefix, tail = prefix[:-len(stage)-1], chinese
                break
        if prefix in PREFIXES:
            return PREFIXES[prefix] + tail + text
    return None


HELP = {
    'temperature': '控制采样随机性，保留该模型的默认值可复现原有设置。',
    'top_k': '限制采样候选数量；是否支持 0 由该模型决定。',
    'top_p': '按累计概率保留采样候选。',
    'num_inference_steps': '控制生成迭代次数，增加步数会增加耗时。',
    'guidance_scale': '调整条件引导强度，过大可能降低自然度。',
    'speed': '控制语速，1 表示默认速度。',
    'x_vector_only_mode': '仅提取声纹进行克隆，开启后可省略参考音频原文。',
    'audio_chunk_mode': '选择自动、按静音、固定时长或不分段；仅列出当前模型支持的方式。',
    'text_chunk_mode': '按字数预算、标签、日语规则或换行划分文本，采用模型支持的方式。',
    'return_timestamps': '请求模型返回时间位置；Qwen3-ASR 的词级时间戳还需强制对齐模型。',
    'phonemes': '直接输入音素，绕过文字转音素。列表中每项对应一个分段。',
    'reference_text': '填写与参考音频一致的原文。',
    'language': '使用当前模型接受的语言代码；留空采用模型默认值。',
    'seed': '控制随机采样；-1 表示随机，仅在模型支持时生效。',
    'max_tokens': '限制每段生成标记数，达到上限可能截断结果。',
    'voice_id': '选择当前权重包内置的音色。',
    'instruct': '输入当前任务需要的声音或音频指令。',
    'instruction': '描述声音风格或表达方式。',
    'duration_sec': '目标时长，单位为秒；AuK 无参考音频时必须设置正数。',
}


def localize_parameter(param):
    """Return a copy; never mutate the legacy per-model control specifications."""
    p = dict(param)
    name = p['name'].rsplit('.', 1)[-1]
    label = option_label(name)
    if label:
        p.setdefault('label_en', p.get('label', name))
        p['label'] = label
    info = p.get('info', '')
    if not re.search(r'[\u4e00-\u9fff]', info):
        p.setdefault('info_en', info)
        p['info'] = HELP.get(name, '')
        if not p['info'] and label:
            if name.endswith('_mb'):
                p['info'] = '设置该模块的内存预算，单位为 MB；不足可能导致计算图分配失败。'
            elif name.endswith('weight_type'):
                p['info'] = '选择此模块的权重精度；可用格式取决于当前模型和推理后端。'
            elif name.endswith(('_path', '_file', '_gguf')):
                p['info'] = '填写模型使用的本地文件或目录路径，保留默认值时由模型自动解析。'
            else:
                p['info'] = f'调整{label}，未修改时沿用当前模型的默认配置。'
    if p.get('placeholder', '').startswith('JSON array'):
        p['placeholder'] = 'JSON 数组，例如 [1, 2]'
    return p
