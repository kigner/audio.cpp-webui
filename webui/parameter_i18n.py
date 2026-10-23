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
emotion_vector=情感向量
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


PREFIXES.update({
    'adaptor': '适配器', 'audio_tokenizer_decoder': '音频分词解码器',
    'codec_encode': '编解码器编码', 'conditionals': '条件', 'connector': '连接器',
    'content': '内容编码器', 'diffusion_head': '扩散头', 'emotion': '情感',
    'emotion_text': '情感文本', 'flow_weights_view': '流模型权重视图', 'fm': '流匹配',
    'global': '全局模型', 'gpt': '语言模型', 'local_frame': '局部帧模型',
    'mimi_decoder': 'Mimi 解码器', 'mimi_tail': 'Mimi 尾部',
    'mimi_transformer': 'Mimi 注意力网络', 'planner': '规划器', 's2mel': '声学模型',
    'style': '风格', 't3': 'T3 语音模型', 'tokenizer': '音频分词器',
    'voice_state': '音色状态', 'wave': '波形模型', 'whisper': 'Whisper 编码器',
})
LABELS.update({
    'attention_tile_rows': '注意力分块行数', 'best_of_n_asr_model_path': '候选评估识别模型路径',
    'best_of_n_default': '默认候选数', 'best_of_n_enabled': '启用候选评估',
    'best_of_n_language': '候选评估语言', 'best_of_n_max': '最大候选数',
    'codec_model_path': '编解码模型路径', 'decoder_condition_samples': '解码条件采样点数',
    'whisper_model_path': 'Whisper 模型路径', 'flow_weights_view_context_mb': '流模型权重视图内存（MB）',
    'encoder_condition_samples': '编码条件采样点数', 'dit_model_path': '扩散模型路径',
    'g2p_dict': '发音词典', 'g2p_library': '发音前端动态库',
    'generation_graph_capacity': '生成图容量', 'prompt_graph_capacity': '提示图容量',
    'lora': '低秩适配器路径', 'lora_scale': '适配器强度', 'max_batch': '最大批量',
    'max_history_steps': '历史步数上限', 'mimi_full_chunk_frames': 'Mimi 完整解码分块帧数',
    'mimi_stage2_chunk_frames': 'Mimi 第二阶段分块帧数', 'multilingual_t3': '多语言 T3',
    'pipeline_overlap': '流水线并行', 'stream_batch_tokens': '流式批次标记数',
    'stream_decode_cache_steps': '流式解码缓存步数', 't3_speech_cond_prompt_len': 'T3 语音条件长度',
    'threads': '计算线程数', 'use_full_mimi': '使用完整 Mimi 解码',
    'complete_track_classes': '补全声部', 'track_name': '声部',
    'repaint_crossfade_frames': '重绘交叉淡化帧数', 'repaint_injection_ratio': '重绘注入比例',
    'repaint_mode': '重绘模式', 'repaint_strength': '重绘强度',
    'repainting_start': '重绘开始时间', 'repainting_end': '重绘结束时间',
})


LABELS.update(dict(line.split('=', 1) for line in '''
retake_seed=重新生成种子
retake_variance=重新生成变化幅度
audio_codes=音频编码标记
stream_chunk_policy=流式分块方式
punc=标点与大小写恢复
stop_on_eos=遇结束标记停止
video_file=参考视频文件
exec_plan=模块运行方案
max_audio_steps=音频生成步数上限
min_audio_steps=音频生成步数下限
smooth_window_ms=平滑窗口（毫秒）
max_speech_duration_sec=最长语音片段（秒）
merge_silence_duration_ms=合并静音间隔（毫秒）
speech_pad_ms=语音片段补边（毫秒）
speech_start_pad_ms=语音起点补边（毫秒）
codec_encoder_bf16_compute=编解码器编码使用 BF16 计算
encode_reference_only=仅编码参考声音
references=参考声音列表
previous_takes=已有生成片段
previous_takes_file=已有片段文件
backbone_prefill_cache_mb=主干预填充缓存（MB）
tower_prefill_cache_mb=声学网络预填充缓存（MB）
profile_first_audio=记录首段音频耗时
context_length=上下文长度
cpu_expert_layers=在 CPU 计算的专家层数
disk_experts=从磁盘载入专家权重
pin_experts=锁定专家权重内存
expert_cache_size=专家缓存数量
disk_expert_read_threads=磁盘专家读取线程数
codec_encoder_f32_accumulation=编解码器编码使用 F32 累加
codec_encoder_chunk_samples=编码器分块采样点数
allow_incomplete_generation=允许未完整结束的生成
filter_nan_logits=过滤无效采样分数
reference_prefill_mode=参考声音预填充方式
cased=保留大小写
text=文本
speaker_embedding_file=说话人特征文件
t_schedule_mode=采样时间步方案
sway_coeff=采样曲线系数
codec_decode_chunk_steps=编解码器解码分块步数
codec_decode_overlap_steps=编解码器解码重叠步数
codec_encode_chunk_steps=编解码器编码分块步数
codec_encode_overlap_steps=编解码器编码重叠步数
predictor_duration_graph_arena_mb=时长预测图内存（MB）
predictor_text_graph_arena_mb=文本预测图内存（MB）
predictor_tail_graph_arena_mb=预测器尾部图内存（MB）
return_codes=返回音频编码
max_pass_duration_sec=单次处理时长上限（秒）
cpu_repack=重排 CPU 权重
conversation_cache_slots=对话缓存数量
sliding_window_size=滑动窗口大小
prompt=任务提示词
max_audio_tokens=音频标记上限
sigma=噪声尺度
raw_text=原始文本
trim_silence=裁剪末尾静音
reference_cache=缓存参考声音
instruction_schema=声音指令字段语言
pitch=音高
volume=音量
use_speaker_embedding=使用说话人特征
zero_speaker_embedding=清空说话人特征
first_block_cache_start_percent=首块缓存起始比例
first_block_cache_end_percent=首块缓存结束比例
flow_uncond_interval=流模型无条件分支间隔
flow_uncond_warmup=流模型无条件分支预热
ensemble_takes=集成生成次数
ensemble_prefix_frames=集成前缀帧数
flow_chunk_hop_frames=流模型分块帧移
presence_penalty=出现惩罚
frequency_penalty=频率惩罚
normalize_output=规范输出音量
active_codebooks=启用的编码本数量
prefill_mode=预填充方式
min_frames=最少生成帧数
duration_frames=目标时长帧数
word_duration_frames=单词时长帧数
context_text=上下文原文
context_audio_file=上下文音频文件
same_speaker=使用同一说话人
pronunciations=自定义发音
edit_start_frame=编辑起始帧
edit_end_frame=编辑结束帧
silence_duration_sec=片段静音间隔（秒）
text_chunk_tokens=文本分段标记数
noise_clamp=噪声截断范围
eos_threshold=结束标记阈值
voice_embedding_file=音色特征文件
truncate_clone_audio=裁剪克隆参考音频
export_voice_state_file=导出音色状态文件
offline_graph_capacity_mode=离线计算图容量策略
stitch_decode=合并文本分段后解码
packed_projections=打包投影权重
kv_cache_write=注意力缓存写入方式
kv_cache_type=注意力缓存精度
talker_kv_cache_alignment=语音模型缓存对齐
stream_decoder=流式解码器
keywords=关键词列表
max_active_paths=最大搜索路径数
keywords_score=关键词分数加成
keywords_threshold=关键词检测阈值
num_trailing_blanks=末尾空白标记数
apg_scale=自适应引导强度
duration_padding_sec=时长补边（秒）
truncate_output_to_duration=按目标时长裁剪输出
chunked_decode=分块解码
inpaint_mask_start_sec=重绘起点（秒）
inpaint_mask_end_sec=重绘终点（秒）
prosody_ref=韵律参考音频
style_ref=风格参考音频
style_ref_text=风格参考原文
use_prosody_code=使用韵律编码
source_shift_steps=源音频移调（半音）
prosody_shift_steps=韵律参考移调（半音）
style_shift_steps=风格参考移调（半音）
diffusion_noise_file=扩散噪声文件
auto_frame_cap=自动限制音频帧数
text_chunk_min_size=最小文本分段长度
speaker_embedding=说话人特征
reference_codes=参考音频编码
reference_codes_file=参考音频编码文件
babble_retries=异常语音重试次数
g2p_dict_file=发音词典文件
cfm_noise_file=流匹配噪声文件
stream_left_context=流式左侧上下文
chunk_strategy=分块策略
audiovae_tile_frames=音频 VAE 分块帧数
max_mel_tokens=声学标记上限
kv_cache_alignment=注意力缓存对齐
vae_tile_frames=VAE 分块帧数
'''.strip().splitlines()))


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
    'stitch_decode': '将各文本段的语音标记合并后一次解码；显存占用会随整段音频时长增加。',
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
