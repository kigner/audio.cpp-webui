#include "engine/models/ace_step/assets.h"

#include "engine/framework/io/filesystem.h"
#include "engine/framework/io/json.h"

#include <stdexcept>
#include <utility>

namespace engine::models::ace_step {
namespace json = engine::io::json;
namespace {

std::filesystem::path resolve_model_root(const std::filesystem::path & model_path) {
    if (engine::io::is_existing_directory(model_path)) {
        return std::filesystem::weakly_canonical(model_path);
    }
    if (engine::io::is_existing_file(model_path)) {
        return std::filesystem::weakly_canonical(model_path.parent_path());
    }
    throw std::runtime_error("ACE-Step model path does not exist: " + model_path.string());
}

std::filesystem::path require_file(const std::filesystem::path & path, const char * role) {
    if (!engine::io::is_existing_file(path)) {
        throw std::runtime_error(std::string("ACE-Step missing ") + role + ": " + path.string());
    }
    return path;
}

void parse_qwen_common(
    const engine::io::json::Value & value,
    int64_t & vocab_size,
    int64_t & hidden_size,
    int64_t & intermediate_size,
    int64_t & num_hidden_layers,
    int64_t & num_attention_heads,
    int64_t & num_key_value_heads,
    int64_t & head_dim,
    int64_t & max_position_embeddings,
    float & rms_norm_eps,
    float & rope_theta) {
    vocab_size = json::require_i64(value, "vocab_size");
    hidden_size = json::require_i64(value, "hidden_size");
    intermediate_size = json::require_i64(value, "intermediate_size");
    num_hidden_layers = json::require_i64(value, "num_hidden_layers");
    num_attention_heads = json::require_i64(value, "num_attention_heads");
    num_key_value_heads = json::require_i64(value, "num_key_value_heads");
    head_dim = json::optional_i64(value, "head_dim", hidden_size / num_attention_heads);
    max_position_embeddings = json::require_i64(value, "max_position_embeddings");
    rms_norm_eps = json::optional_f32(value, "rms_norm_eps", rms_norm_eps);
    rope_theta = json::optional_f32(value, "rope_theta", rope_theta);
}

AceStepPlannerConfig parse_planner_config(const engine::io::json::Value & value) {
    AceStepPlannerConfig config;
    config.lm_family = json::optional_string(value, "model_type", config.lm_family);
    parse_qwen_common(
        value,
        config.vocab_size,
        config.hidden_size,
        config.intermediate_size,
        config.num_hidden_layers,
        config.num_attention_heads,
        config.num_key_value_heads,
        config.head_dim,
        config.max_position_embeddings,
        config.rms_norm_eps,
        config.rope_theta);
    config.bos_token_id = json::optional_i64(value, "bos_token_id", config.bos_token_id);
    config.eos_token_id = json::optional_i64(value, "eos_token_id", config.eos_token_id);
    config.pad_token_id = json::optional_i64(value, "pad_token_id", config.pad_token_id);
    return config;
}

AceStepTextEncoderConfig parse_text_encoder_config(const engine::io::json::Value & value) {
    AceStepTextEncoderConfig config;
    config.encoder_family = json::optional_string(value, "model_type", config.encoder_family);
    parse_qwen_common(
        value,
        config.vocab_size,
        config.hidden_size,
        config.intermediate_size,
        config.num_hidden_layers,
        config.num_attention_heads,
        config.num_key_value_heads,
        config.head_dim,
        config.max_position_embeddings,
        config.rms_norm_eps,
        config.rope_theta);
    return config;
}

AceStepDiffusionConfig parse_diffusion_config(const engine::io::json::Value & value) {
    AceStepDiffusionConfig config;
    config.model_type = json::optional_string(value, "model_type", config.model_type);
    config.model_version = json::optional_string(value, "model_version", config.model_version);
    config.hidden_size = json::require_i64(value, "hidden_size");
    config.intermediate_size = json::require_i64(value, "intermediate_size");
    config.num_hidden_layers = json::require_i64(value, "num_hidden_layers");
    config.num_attention_heads = json::require_i64(value, "num_attention_heads");
    config.num_key_value_heads = json::require_i64(value, "num_key_value_heads");
    config.head_dim = json::optional_i64(value, "head_dim", config.hidden_size / config.num_attention_heads);
    config.text_hidden_dim = json::require_i64(value, "text_hidden_dim");
    config.in_channels = json::require_i64(value, "in_channels");
    config.patch_size = json::require_i64(value, "patch_size");
    config.latent_channels = json::require_i64(value, "audio_acoustic_hidden_dim");
    config.pool_window_size = json::require_i64(value, "pool_window_size");
    config.timbre_hidden_dim = json::require_i64(value, "timbre_hidden_dim");
    config.timbre_fix_frame = json::require_i64(value, "timbre_fix_frame");
    config.num_lyric_encoder_hidden_layers = json::require_i64(value, "num_lyric_encoder_hidden_layers");
    config.num_timbre_encoder_hidden_layers = json::require_i64(value, "num_timbre_encoder_hidden_layers");
    config.num_attention_pooler_hidden_layers = json::require_i64(value, "num_attention_pooler_hidden_layers");
    config.fsq_input_num_quantizers = json::require_i64(value, "fsq_input_num_quantizers");
    config.fsq_input_levels = json::optional_i64_array(value, "fsq_input_levels");
    config.fsq_dim = static_cast<int64_t>(config.fsq_input_levels.size());
    config.sliding_window = json::optional_i64(value, "sliding_window", 0);
    config.use_sliding_window = json::optional_bool(value, "use_sliding_window", false);
    config.layer_types = json::optional_string_array(value, "layer_types");
    config.is_turbo = json::optional_bool(value, "is_turbo", config.is_turbo);
    config.rms_norm_eps = json::optional_f32(value, "rms_norm_eps", config.rms_norm_eps);
    config.rope_theta = json::optional_f32(value, "rope_theta", config.rope_theta);
    return config;
}

AceStepVAEConfig parse_vae_config(const engine::io::json::Value & value) {
    AceStepVAEConfig config;
    config.sample_rate = static_cast<int>(json::optional_i64(value, "sampling_rate", config.sample_rate));
    config.audio_channels = static_cast<int>(json::optional_i64(value, "audio_channels", config.audio_channels));
    config.encoder_hidden_size = json::optional_i64(value, "encoder_hidden_size", config.encoder_hidden_size);
    config.decoder_channels = json::optional_i64(value, "decoder_channels", config.decoder_channels);
    config.decoder_input_channels = json::optional_i64(value, "decoder_input_channels", config.decoder_input_channels);
    config.downsampling_ratios = json::optional_i64_array(value, "downsampling_ratios");
    config.channel_multiples = json::optional_i64_array(value, "channel_multiples");
    return config;
}

}  // namespace

AceStepAssetPaths resolve_ace_step_assets(const std::filesystem::path & model_path, const AceStepModelSelection & selection) {
    AceStepAssetPaths paths;
    paths.model_root = resolve_model_root(model_path);

    paths.dit_model_root = paths.model_root / selection.dit_model_path;
    paths.dit_config_path = require_file(paths.dit_model_root / "config.json", "DiT config");
    paths.dit_weights_path = require_file(paths.dit_model_root / "model.safetensors", "DiT weights");
    paths.dit_silence_latent_path =
        require_file(paths.dit_model_root / "silence_latent.safetensors", "DiT silence latent");

    paths.lm_model_root = paths.model_root / selection.lm_model_path;
    paths.lm_config_path = require_file(paths.lm_model_root / "config.json", "planner LM config");
    paths.lm_weights_path = require_file(paths.lm_model_root / "model.safetensors", "planner LM weights");
    paths.lm_tokenizer_config_path =
        require_file(paths.lm_model_root / "tokenizer_config.json", "planner LM tokenizer config");
    paths.lm_tokenizer_vocab_path = require_file(paths.lm_model_root / "vocab.json", "planner LM vocab");
    paths.lm_tokenizer_merges_path = require_file(paths.lm_model_root / "merges.txt", "planner LM merges");
    paths.lm_tokenizer_json_path = require_file(paths.lm_model_root / "tokenizer.json", "planner LM tokenizer json");
    paths.lm_chat_template_path = require_file(paths.lm_model_root / "chat_template.jinja", "planner LM chat template");

    paths.text_encoder_root = paths.model_root / selection.text_encoder_path;
    paths.text_encoder_config_path = require_file(paths.text_encoder_root / "config.json", "text encoder config");
    paths.text_encoder_weights_path = require_file(paths.text_encoder_root / "model.safetensors", "text encoder weights");
    paths.text_encoder_tokenizer_config_path =
        require_file(paths.text_encoder_root / "tokenizer_config.json", "text encoder tokenizer config");
    paths.text_encoder_tokenizer_vocab_path = require_file(paths.text_encoder_root / "vocab.json", "text encoder vocab");
    paths.text_encoder_tokenizer_merges_path = require_file(paths.text_encoder_root / "merges.txt", "text encoder merges");
    paths.text_encoder_tokenizer_json_path =
        require_file(paths.text_encoder_root / "tokenizer.json", "text encoder tokenizer json");
    paths.text_encoder_chat_template_path =
        require_file(paths.text_encoder_root / "chat_template.jinja", "text encoder chat template");

    paths.vae_model_root = paths.model_root / selection.vae_model_path;
    paths.vae_config_path = require_file(paths.vae_model_root / "config.json", "VAE config");
    paths.vae_weights_path =
        require_file(paths.vae_model_root / "diffusion_pytorch_model.safetensors", "VAE weights");
    return paths;
}

std::shared_ptr<const AceStepAssets> load_ace_step_assets(
    const std::filesystem::path & model_path,
    const AceStepModelSelection & selection) {
    auto assets = std::make_shared<AceStepAssets>();
    assets->selection = selection;
    assets->paths = resolve_ace_step_assets(model_path, selection);

    const auto dit_root = engine::io::json::parse_file(assets->paths.dit_config_path);
    const auto lm_root = engine::io::json::parse_file(assets->paths.lm_config_path);
    const auto text_encoder_root = engine::io::json::parse_file(assets->paths.text_encoder_config_path);
    const auto vae_root = engine::io::json::parse_file(assets->paths.vae_config_path);

    assets->config.diffusion = parse_diffusion_config(dit_root);
    assets->config.planner = parse_planner_config(lm_root);
    assets->config.text_encoder = parse_text_encoder_config(text_encoder_root);
    assets->config.vae = parse_vae_config(vae_root);

    if (assets->config.diffusion.model_type != "acestep") {
        throw std::runtime_error("ACE-Step diffusion config must have model_type=acestep");
    }
    if (assets->config.planner.lm_family != "qwen3") {
        throw std::runtime_error("ACE-Step planner LM currently supports only qwen3");
    }
    if (assets->config.text_encoder.encoder_family != "qwen3") {
        throw std::runtime_error("ACE-Step text encoder currently supports only qwen3");
    }
    if (assets->config.vae.sample_rate != assets->config.diffusion.sample_rate) {
        throw std::runtime_error("ACE-Step VAE sample rate must match diffusion sample rate");
    }

    assets->dit_weights = engine::assets::open_tensor_source(assets->paths.dit_weights_path);
    assets->dit_silence_latent = engine::assets::open_tensor_source(assets->paths.dit_silence_latent_path);
    assets->lm_weights = engine::assets::open_tensor_source(assets->paths.lm_weights_path);
    assets->text_encoder_weights = engine::assets::open_tensor_source(assets->paths.text_encoder_weights_path);
    assets->vae_weights = engine::assets::open_tensor_source(assets->paths.vae_weights_path);
    return assets;
}

}  // namespace engine::models::ace_step
