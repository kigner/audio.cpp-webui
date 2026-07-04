#pragma once

#include "engine/framework/assets/tensor_source.h"

#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace engine::models::ace_step {

struct AceStepModelSelection {
    std::string dit_model_path = "acestep-v15-turbo";
    std::string lm_model_path = "acestep-5Hz-lm-1.7B";
    std::string text_encoder_path = "Qwen3-Embedding-0.6B";
    std::string vae_model_path = "vae";
};

struct AceStepPlannerConfig {
    std::string lm_family = "qwen3";
    int64_t frame_rate_hz = 5;
    bool supports_thinking = true;
    int64_t vocab_size = 0;
    int64_t hidden_size = 0;
    int64_t intermediate_size = 0;
    int64_t num_hidden_layers = 0;
    int64_t num_attention_heads = 0;
    int64_t num_key_value_heads = 0;
    int64_t head_dim = 0;
    int64_t max_position_embeddings = 0;
    int64_t bos_token_id = 0;
    int64_t eos_token_id = 0;
    int64_t pad_token_id = 0;
    float rms_norm_eps = 1.0e-6F;
    float rope_theta = 1000000.0F;
};

struct AceStepTextEncoderConfig {
    std::string encoder_family = "qwen3_embedding";
    int64_t vocab_size = 0;
    int64_t hidden_size = 0;
    int64_t intermediate_size = 0;
    int64_t num_hidden_layers = 0;
    int64_t num_attention_heads = 0;
    int64_t num_key_value_heads = 0;
    int64_t head_dim = 0;
    int64_t max_position_embeddings = 0;
    float rms_norm_eps = 1.0e-6F;
    float rope_theta = 1000000.0F;
};

struct AceStepDiffusionConfig {
    std::string model_type = "acestep";
    std::string model_version = "turbo";
    int sample_rate = 48000;
    int64_t latent_frame_rate_hz = 25;
    int64_t latent_channels = 64;
    int64_t hidden_size = 0;
    int64_t intermediate_size = 0;
    int64_t num_hidden_layers = 0;
    int64_t num_attention_heads = 0;
    int64_t num_key_value_heads = 0;
    int64_t head_dim = 0;
    int64_t text_hidden_dim = 0;
    int64_t in_channels = 0;
    int64_t patch_size = 0;
    int64_t pool_window_size = 0;
    int64_t timbre_hidden_dim = 0;
    int64_t timbre_fix_frame = 0;
    int64_t num_lyric_encoder_hidden_layers = 0;
    int64_t num_timbre_encoder_hidden_layers = 0;
    int64_t num_attention_pooler_hidden_layers = 0;
    int64_t fsq_input_num_quantizers = 0;
    int64_t fsq_dim = 0;
    int64_t sliding_window = 0;
    bool use_sliding_window = false;
    bool is_turbo = true;
    float rms_norm_eps = 1.0e-6F;
    float rope_theta = 1000000.0F;
    std::vector<int64_t> fsq_input_levels;
    std::vector<std::string> layer_types;
};

struct AceStepVAEConfig {
    int sample_rate = 48000;
    int audio_channels = 2;
    int64_t encoder_hidden_size = 0;
    int64_t decoder_channels = 0;
    int64_t decoder_input_channels = 0;
    std::vector<int64_t> downsampling_ratios;
    std::vector<int64_t> channel_multiples;
};

struct AceStepConfig {
    AceStepPlannerConfig planner;
    AceStepTextEncoderConfig text_encoder;
    AceStepDiffusionConfig diffusion;
    AceStepVAEConfig vae;
};

struct AceStepAssetPaths {
    std::filesystem::path model_root;
    std::filesystem::path dit_model_root;
    std::filesystem::path dit_config_path;
    std::filesystem::path dit_weights_path;
    std::filesystem::path dit_silence_latent_path;
    std::filesystem::path lm_model_root;
    std::filesystem::path lm_config_path;
    std::filesystem::path lm_weights_path;
    std::filesystem::path lm_tokenizer_config_path;
    std::filesystem::path lm_tokenizer_vocab_path;
    std::filesystem::path lm_tokenizer_merges_path;
    std::filesystem::path lm_tokenizer_json_path;
    std::filesystem::path lm_chat_template_path;
    std::filesystem::path text_encoder_root;
    std::filesystem::path text_encoder_config_path;
    std::filesystem::path text_encoder_weights_path;
    std::filesystem::path text_encoder_tokenizer_config_path;
    std::filesystem::path text_encoder_tokenizer_vocab_path;
    std::filesystem::path text_encoder_tokenizer_merges_path;
    std::filesystem::path text_encoder_tokenizer_json_path;
    std::filesystem::path text_encoder_chat_template_path;
    std::filesystem::path vae_model_root;
    std::filesystem::path vae_config_path;
    std::filesystem::path vae_weights_path;
};

struct AceStepAssets {
    AceStepAssetPaths paths;
    AceStepModelSelection selection;
    AceStepConfig config;
    std::shared_ptr<const assets::TensorSource> dit_weights;
    std::shared_ptr<const assets::TensorSource> dit_silence_latent;
    std::shared_ptr<const assets::TensorSource> lm_weights;
    std::shared_ptr<const assets::TensorSource> text_encoder_weights;
    std::shared_ptr<const assets::TensorSource> vae_weights;
};

AceStepAssetPaths resolve_ace_step_assets(
    const std::filesystem::path & model_path,
    const AceStepModelSelection & selection = {});

std::shared_ptr<const AceStepAssets> load_ace_step_assets(
    const std::filesystem::path & model_path,
    const AceStepModelSelection & selection = {});

}  // namespace engine::models::ace_step
