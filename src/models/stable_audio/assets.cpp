#include "engine/models/stable_audio/assets.h"

#include "engine/framework/io/filesystem.h"
#include "engine/framework/io/json.h"
#include "engine/framework/io/safetensors.h"

#include <algorithm>
#include <stdexcept>

namespace engine::models::stable_audio {
namespace {

std::filesystem::path resolve_model_root(const std::filesystem::path & model_path) {
    if (engine::io::is_existing_directory(model_path)) {
        return std::filesystem::weakly_canonical(model_path);
    }
    if (engine::io::is_existing_file(model_path)) {
        return std::filesystem::weakly_canonical(model_path.parent_path());
    }
    throw std::runtime_error("Stable Audio model path does not exist: " + model_path.string());
}

std::filesystem::path require_file(const std::filesystem::path & path, const char * label) {
    if (!engine::io::is_existing_file(path)) {
        throw std::runtime_error(std::string("missing Stable Audio ") + label + ": " + path.string());
    }
    return path;
}

std::filesystem::path require_dir(const std::filesystem::path & path, const char * label) {
    if (!engine::io::is_existing_directory(path)) {
        throw std::runtime_error(std::string("missing Stable Audio ") + label + ": " + path.string());
    }
    return path;
}

std::filesystem::path first_existing_file(
    const std::vector<std::filesystem::path> & paths,
    const char * label) {
    for (const auto & path : paths) {
        if (engine::io::is_existing_file(path)) {
            return path;
        }
    }
    if (!paths.empty()) {
        throw std::runtime_error(std::string("missing Stable Audio ") + label + ": " + paths.front().string());
    }
    throw std::runtime_error(std::string("missing Stable Audio ") + label);
}

bool has_prefix(const engine::io::SafeTensorIndex & index, const std::string & prefix) {
    return std::any_of(index.tensors.begin(), index.tensors.end(), [&](const auto & item) {
        return item.first.rfind(prefix, 0) == 0;
    });
}

void require_prefix(const engine::io::SafeTensorIndex & index, const std::string & prefix, const char * label) {
    if (!has_prefix(index, prefix)) {
        throw std::runtime_error(std::string("Stable Audio safetensors missing ") + label + " tensors with prefix " + prefix);
    }
}

StableAudioConfig parse_config(const std::filesystem::path & path) {
    const auto root = engine::io::json::parse_file(path);
    StableAudioConfig config;
    config.model_type = engine::io::json::require_string(root, "model_type");
    config.sample_size = engine::io::json::require_i64(root, "sample_size");
    config.sample_rate = engine::io::json::require_i32(root, "sample_rate");
    config.audio_channels = engine::io::json::require_i32(root, "audio_channels");

    const auto & model = root.require("model");
    config.io_channels = engine::io::json::require_i64(model, "io_channels");

    const auto & pretransform = model.require("pretransform");
    config.pretransform_type = engine::io::json::require_string(pretransform, "type");
    const auto & pretransform_config = pretransform.require("config");
    config.latent_dim = engine::io::json::require_i64(pretransform_config, "latent_dim");
    config.downsampling_ratio = engine::io::json::require_i64(pretransform_config, "downsampling_ratio");
    const auto & encoder_config = pretransform_config.require("encoder").require("config");
    const auto & decoder_config = pretransform_config.require("decoder").require("config");
    const bool has_sa3_pretransform = pretransform_config.find("pretransform") != nullptr;
    config.stable_audio_open_v1 = !has_sa3_pretransform;
    if (has_sa3_pretransform) {
        config.pretransform_patch_size =
            engine::io::json::require_i64(pretransform_config.require("pretransform").require("config"), "patch_size");
    } else {
        config.pretransform_patch_size = 1;
    }
    config.pretransform_encoder_chunk_size = engine::io::json::optional_i64(encoder_config, "chunk_size", 32);
    const auto & encoder_strides = encoder_config.require("strides").as_array();
    if (encoder_strides.empty()) {
        throw std::runtime_error("Stable Audio pretransform encoder strides must not be empty");
    }
    config.pretransform_encoder_stride = encoder_strides.front().as_i64();
    config.same_encoder_in_channels = engine::io::json::require_i64(encoder_config, "in_channels");
    config.same_decoder_out_channels = engine::io::json::require_i64(decoder_config, "out_channels");
    config.same_channels = engine::io::json::require_i64(encoder_config, "channels");
    if (config.same_channels != engine::io::json::require_i64(decoder_config, "channels")) {
        throw std::runtime_error("Stable Audio SAME encoder/decoder channel counts must match");
    }
    config.same_dim_heads = engine::io::json::optional_i64(encoder_config, "dim_heads", 64);
    if (config.same_dim_heads != engine::io::json::optional_i64(decoder_config, "dim_heads", config.same_dim_heads)) {
        throw std::runtime_error("Stable Audio SAME encoder/decoder head dimensions must match");
    }
    config.same_c_mults = engine::io::json::require_i64_array(encoder_config, "c_mults");
    config.same_strides = engine::io::json::require_i64_array(encoder_config, "strides");
    config.same_encoder_transformer_depths = has_sa3_pretransform
        ? engine::io::json::require_i64_array(encoder_config, "transformer_depths")
        : std::vector<int64_t>(config.same_c_mults.size(), 0);
    config.same_decoder_transformer_depths = has_sa3_pretransform
        ? engine::io::json::require_i64_array(decoder_config, "transformer_depths")
        : std::vector<int64_t>(config.same_c_mults.size(), 0);
    config.same_decoder_sinusoidal_blocks = engine::io::json::optional_i64_array(decoder_config, "sinusoidal_blocks", std::vector<int64_t>(config.same_decoder_transformer_depths.size(), 0));
    config.same_sliding_window = engine::io::json::optional_i64_array(encoder_config, "sliding_window");
    config.same_differential = engine::io::json::optional_bool(encoder_config, "differential", true);
    if (config.same_differential != engine::io::json::optional_bool(decoder_config, "differential", config.same_differential)) {
        throw std::runtime_error("Stable Audio SAME encoder/decoder differential settings must match");
    }
    config.same_variable_stride = engine::io::json::optional_bool(encoder_config, "variable_stride", false);
    if (config.same_variable_stride != engine::io::json::optional_bool(decoder_config, "variable_stride", config.same_variable_stride)) {
        throw std::runtime_error("Stable Audio SAME encoder/decoder variable_stride settings must match");
    }
    config.same_encoder_conv_mapping = engine::io::json::optional_bool(encoder_config, "conv_mapping", false);
    config.same_decoder_conv_mapping = engine::io::json::optional_bool(decoder_config, "conv_mapping", false);
    config.same_chunk_midpoint_shift =
        engine::io::json::optional_bool(encoder_config, "chunk_midpoint_shift", false) ||
        engine::io::json::optional_bool(decoder_config, "chunk_midpoint_shift", false);
    config.same_encoder_mask_noise = engine::io::json::optional_f32(encoder_config, "mask_noise", 0.0F);
    config.same_decoder_mask_noise = engine::io::json::optional_f32(decoder_config, "mask_noise", 0.0F);
    const auto & bottleneck = pretransform_config.require("bottleneck");
    if (const auto * bottleneck_config = bottleneck.find("config"); bottleneck_config != nullptr && bottleneck_config->is_object()) {
        config.same_bottleneck_noise_regularize = engine::io::json::optional_bool(*bottleneck_config, "noise_regularize", false);
        config.same_bottleneck_auto_scale = engine::io::json::optional_bool(*bottleneck_config, "auto_scale", false);
        config.same_bottleneck_noise_augment_dim = engine::io::json::optional_i64(*bottleneck_config, "noise_augment_dim", 0);
    }

    const auto & conditioning = model.require("conditioning");
    config.cond_dim = engine::io::json::require_i64(conditioning, "cond_dim");
    for (const auto & item : conditioning.require("configs").as_array()) {
        const std::string id = engine::io::json::require_string(item, "id");
        const std::string type = engine::io::json::require_string(item, "type");
        const auto & item_config = item.require("config");
        if (id == "prompt") {
            config.prompt_conditioner_type = type;
            config.prompt_max_length = engine::io::json::require_i64(item_config, "max_length");
            if (type == "t5gemma") {
                config.t5_subfolder = engine::io::json::optional_string(item_config, "subfolder", "t5gemma-b-b-ul2");
            } else if (type == "t5") {
                config.t5_model_name = engine::io::json::require_string(item_config, "t5_model_name");
            }
        } else if (id == "seconds_total" && type == "number") {
            config.seconds_min = engine::io::json::require_f32(item_config, "min_val");
            config.seconds_max = engine::io::json::require_f32(item_config, "max_val");
        }
    }
    if (config.prompt_conditioner_type.empty()) {
        throw std::runtime_error("Stable Audio config is missing prompt conditioner");
    }
    if (config.prompt_conditioner_type != "t5gemma" && config.prompt_conditioner_type != "t5") {
        throw std::runtime_error("Stable Audio unsupported prompt conditioner type: " + config.prompt_conditioner_type);
    }
    if (config.prompt_conditioner_type == "t5gemma" && config.t5_subfolder.empty()) {
        throw std::runtime_error("Stable Audio t5gemma prompt conditioner is missing subfolder");
    }
    if (config.prompt_conditioner_type == "t5" && config.t5_model_name.empty()) {
        throw std::runtime_error("Stable Audio T5 prompt conditioner is missing t5_model_name");
    }

    const auto & diffusion = model.require("diffusion");
    config.diffusion_type = engine::io::json::require_string(diffusion, "type");
    config.diffusion_objective = engine::io::json::optional_string(diffusion, "diffusion_objective", "v");
    if (const auto * shift = diffusion.find("sampling_distribution_shift_options"); shift != nullptr && !shift->is_null()) {
        config.distribution_shift_type = engine::io::json::optional_string(*shift, "type", "full");
        config.distribution_shift_base_shift = engine::io::json::optional_f32(*shift, "base_shift", 0.5F);
        config.distribution_shift_max_shift = engine::io::json::optional_f32(*shift, "max_shift", 1.15F);
        config.distribution_shift_min_length = engine::io::json::optional_i64(*shift, "min_length", 256);
        config.distribution_shift_max_length = engine::io::json::optional_i64(*shift, "max_length", 4096);
        config.distribution_shift_use_sine = engine::io::json::optional_bool(*shift, "use_sine", false);
    }
    const auto & diffusion_config = diffusion.require("config");
    config.diffusion_io_channels = engine::io::json::require_i64(diffusion_config, "io_channels");
    config.embed_dim = engine::io::json::require_i64(diffusion_config, "embed_dim");
    config.depth = engine::io::json::require_i64(diffusion_config, "depth");
    config.num_heads = engine::io::json::require_i64(diffusion_config, "num_heads");
    config.cond_token_dim = engine::io::json::require_i64(diffusion_config, "cond_token_dim");
    config.global_cond_dim = engine::io::json::require_i64(diffusion_config, "global_cond_dim");
    config.local_add_cond_dim = engine::io::json::optional_i64(diffusion_config, "local_add_cond_dim", 0);
    config.num_memory_tokens = engine::io::json::optional_i64(diffusion_config, "num_memory_tokens", 0);
    config.transformer_type = engine::io::json::optional_string(diffusion_config, "transformer_type", "");
    if (const auto * norm_kwargs = diffusion_config.find("norm_kwargs"); norm_kwargs != nullptr && norm_kwargs->is_object()) {
        config.force_fp32_norm = engine::io::json::optional_bool(*norm_kwargs, "force_fp32", false);
    }
    if (const auto * attn_kwargs = diffusion_config.find("attn_kwargs"); attn_kwargs != nullptr && attn_kwargs->is_object()) {
        config.differential_attention = engine::io::json::optional_bool(*attn_kwargs, "differential", false);
    }
    return config;
}

void parse_t5gemma_config(const std::filesystem::path & path, StableAudioConfig & config) {
    const auto root = engine::io::json::parse_file(path);
    const auto & encoder = root.require("encoder");
    config.t5_hidden_size = engine::io::json::require_i64(encoder, "hidden_size");
    config.t5_layers = engine::io::json::require_i64(encoder, "num_hidden_layers");
    config.t5_attention_heads = engine::io::json::require_i64(encoder, "num_attention_heads");
    config.t5_kv_heads = engine::io::json::require_i64(encoder, "num_key_value_heads");
    config.t5_head_dim = engine::io::json::require_i64(encoder, "head_dim");
    config.t5_intermediate_size = engine::io::json::require_i64(encoder, "intermediate_size");
    config.t5_vocab_size = engine::io::json::require_i64(encoder, "vocab_size");
    config.t5_sliding_window = engine::io::json::require_i64(encoder, "sliding_window");
    config.t5_rope_theta = engine::io::json::require_f32(encoder, "rope_theta");
    config.t5_rms_norm_eps = engine::io::json::require_f32(encoder, "rms_norm_eps");
    config.t5_attn_logit_softcap = engine::io::json::require_f32(encoder, "attn_logit_softcapping");
    config.t5_query_pre_attn_scalar = engine::io::json::require_f32(encoder, "query_pre_attn_scalar");
    config.t5_pad_token_id = engine::io::json::require_i64(root, "pad_token_id");
}

void parse_t5_base_config(const std::filesystem::path & path, StableAudioConfig & config) {
    const auto root = engine::io::json::parse_file(path);
    config.t5_hidden_size = engine::io::json::require_i64(root, "d_model");
    config.t5_layers = engine::io::json::require_i64(root, "num_layers");
    config.t5_attention_heads = engine::io::json::require_i64(root, "num_heads");
    config.t5_kv_heads = config.t5_attention_heads;
    config.t5_head_dim = engine::io::json::require_i64(root, "d_kv");
    config.t5_intermediate_size = engine::io::json::require_i64(root, "d_ff");
    config.t5_vocab_size = engine::io::json::require_i64(root, "vocab_size");
    config.t5_rms_norm_eps = engine::io::json::require_f32(root, "layer_norm_epsilon");
    config.t5_pad_token_id = engine::io::json::require_i64(root, "pad_token_id");
}

void validate_model_weights(const engine::assets::TensorSource & source) {
    const auto index = engine::io::load_safetensors_index(source.source_path());
    require_prefix(index, "model.", "diffusion");
    require_prefix(index, "pretransform.", "SAME autoencoder");
    require_prefix(index, "conditioner.", "conditioner");
}

void validate_t5_weights(const engine::assets::TensorSource & source) {
    const auto index = engine::io::load_safetensors_index(source.source_path());
    require_prefix(index, "model.encoder.", "T5Gemma encoder");
}

void validate_t5_base_weights(const engine::assets::TensorSource & source) {
    const auto index = engine::io::load_safetensors_index(source.source_path());
    require_prefix(index, "encoder.block.", "T5 encoder");
    require_prefix(index, "shared.", "T5 shared embedding");
}

}  // namespace

bool StableAudioConfig::is_medium() const noexcept {
    return embed_dim >= 1536 || depth >= 24;
}

StableAudioAssetPaths resolve_stable_audio_assets(const std::filesystem::path & model_path) {
    StableAudioAssetPaths paths;
    paths.model_root = resolve_model_root(model_path);
    paths.model_config_path = require_file(paths.model_root / "model_config.json", "model_config.json");
    paths.model_safetensors_path = first_existing_file(
        {paths.model_root / "model.safetensors", paths.model_root / "Foundation_1.safetensors"},
        "model safetensors");

    const auto config = parse_config(paths.model_config_path);
    if (config.prompt_conditioner_type == "t5gemma") {
        paths.t5_root = require_dir(paths.model_root / config.t5_subfolder, "prompt encoder directory");
    } else {
        paths.t5_root = require_dir(paths.model_root.parent_path() / config.t5_model_name, "T5 prompt encoder directory");
    }
    paths.t5_config_path = require_file(paths.t5_root / "config.json", "prompt encoder config.json");
    paths.t5_safetensors_path = require_file(paths.t5_root / "model.safetensors", "prompt encoder model.safetensors");
    paths.t5_tokenizer_json_path = require_file(paths.t5_root / "tokenizer.json", "prompt encoder tokenizer.json");
    paths.t5_tokenizer_model_path = first_existing_file(
        {paths.t5_root / "tokenizer.model", paths.t5_root / "spiece.model"},
        "prompt encoder sentencepiece model");
    paths.t5_tokenizer_config_path = first_existing_file(
        {paths.t5_root / "tokenizer_config.json", paths.t5_root / "config.json"},
        "prompt encoder tokenizer_config.json");
    return paths;
}

std::shared_ptr<const StableAudioAssets> load_stable_audio_assets(const std::filesystem::path & model_path) {
    auto assets = std::make_shared<StableAudioAssets>();
    assets->paths = resolve_stable_audio_assets(model_path);
    assets->config = parse_config(assets->paths.model_config_path);
    if (assets->config.prompt_conditioner_type == "t5gemma") {
        parse_t5gemma_config(assets->paths.t5_config_path, assets->config);
    } else {
        parse_t5_base_config(assets->paths.t5_config_path, assets->config);
    }
    assets->model_weights = engine::assets::open_tensor_source(assets->paths.model_safetensors_path);
    assets->t5_weights = engine::assets::open_tensor_source(assets->paths.t5_safetensors_path);
    validate_model_weights(*assets->model_weights);
    if (assets->config.prompt_conditioner_type == "t5gemma") {
        validate_t5_weights(*assets->t5_weights);
    } else {
        validate_t5_base_weights(*assets->t5_weights);
    }
    return assets;
}

}  // namespace engine::models::stable_audio
