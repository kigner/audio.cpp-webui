#include "engine/models/demucs/assets.h"

#include "engine/framework/io/filesystem.h"
#include "engine/framework/io/json.h"

#include <cmath>
#include <stdexcept>
#include <utility>

namespace engine::models::demucs {
namespace io = engine::io;
namespace {

std::filesystem::path resolve_model_root(const std::filesystem::path & model_path) {
    if (io::is_existing_directory(model_path)) {
        return std::filesystem::weakly_canonical(model_path);
    }
    if (io::is_existing_file(model_path)) {
        return std::filesystem::weakly_canonical(model_path.parent_path());
    }
    throw std::runtime_error("HTDemucs model path does not exist: " + model_path.string());
}

std::filesystem::path require_relative_path(const io::json::Value & object, const std::string & key) {
    const auto & value = object.require(key);
    if (!value.is_string()) {
        throw std::runtime_error("HTDemucs manifest key '" + key + "' must be a string");
    }
    return std::filesystem::path(value.as_string());
}

DemucsConvertedModelRef parse_model_ref(const io::json::Value & value) {
    DemucsConvertedModelRef model;
    model.signature = value.require("signature").as_string();
    model.checkpoint_file = value.require("checkpoint_file").as_string();
    model.output_dir = require_relative_path(value, "output_dir");
    const auto * tensor_count = value.find("tensor_count");
    model.tensor_count = tensor_count != nullptr && tensor_count->is_number() ? tensor_count->as_i64() : 0;
    return model;
}

DemucsBagManifest parse_manifest(const std::filesystem::path & root) {
    const auto manifest = io::json::parse_file(root / "manifest.json");
    DemucsBagManifest out;
    out.model_type = manifest.require("model_type").as_string();
    out.name = manifest.require("name").as_string();

    if (out.model_type == "demucs_single") {
        out.models.push_back(parse_model_ref(manifest.require("model")));
    } else if (out.model_type == "demucs_single_alias") {
        out.models.push_back(parse_model_ref(manifest.require("model")));
    } else if (out.model_type == "demucs_bag") {
        for (const auto & item : manifest.require("models").as_array()) {
            out.models.push_back(parse_model_ref(item));
        }
        const auto * weights = manifest.find("weights");
        if (weights != nullptr && !weights->is_null()) {
            for (const auto & row : weights->as_array()) {
                std::vector<float> values;
                for (const auto & item : row.as_array()) {
                    values.push_back(item.as_f32());
                }
                out.weights.push_back(std::move(values));
            }
        }
        const auto * segment = manifest.find("segment");
        if (segment != nullptr && segment->is_number()) {
            out.segment_override_seconds = segment->as_f32();
        }
    } else {
        throw std::runtime_error("Unsupported HTDemucs manifest type: " + out.model_type);
    }

    if (out.models.empty()) {
        throw std::runtime_error("HTDemucs manifest has no models");
    }
    return out;
}

HTDemucsConfig parse_submodel_config(const std::filesystem::path & config_path) {
    const auto root = io::json::parse_file(config_path);
    HTDemucsConfig config;
    config.class_name = root.require("class_name").as_string();
    if (config.class_name != "HTDemucs") {
        throw std::runtime_error("Only HTDemucs class_name is supported, got: " + config.class_name);
    }
    config.signature = root.require("signature").as_string();
    config.checkpoint_file = root.require("checkpoint_file").as_string();
    for (const auto & item : root.require("sources").as_array()) {
        config.sources.push_back(item.as_string());
    }
    config.audio_channels = root.require("audio_channels").as_i64();
    config.sample_rate = root.require("samplerate").as_i64();
    config.segment_seconds = root.require("segment").as_f32();

    const auto & kwargs = root.require("kwargs");
    config.channels = kwargs.require("channels").as_i64();
    config.growth = kwargs.require("growth").as_i64();
    config.n_fft = kwargs.require("nfft").as_i64();
    config.hop_length = config.n_fft / 4;
    config.wiener_iters = kwargs.require("wiener_iters").as_i64();
    config.wiener_residual = kwargs.require("wiener_residual").as_bool();
    config.cac = kwargs.require("cac").as_bool();
    config.depth = kwargs.require("depth").as_i64();
    config.rewrite = kwargs.require("rewrite").as_bool();
    config.multi_freqs_depth = kwargs.require("multi_freqs_depth").as_i64();
    config.freq_emb_scale = kwargs.require("freq_emb").as_f32();
    config.embedding_scale = kwargs.require("emb_scale").as_f32();
    config.embedding_smooth = kwargs.require("emb_smooth").as_bool();
    config.kernel_size = kwargs.require("kernel_size").as_i64();
    config.stride = kwargs.require("stride").as_i64();
    config.time_stride = kwargs.require("time_stride").as_i64();
    config.context = kwargs.require("context").as_i64();
    config.context_enc = kwargs.require("context_enc").as_i64();
    config.norm_starts = kwargs.require("norm_starts").as_i64();
    config.norm_groups = kwargs.require("norm_groups").as_i64();
    config.dconv_mode = kwargs.require("dconv_mode").as_i64();
    config.dconv_depth = kwargs.require("dconv_depth").as_i64();
    config.dconv_comp = kwargs.require("dconv_comp").as_i64();
    config.dconv_init = kwargs.require("dconv_init").as_f32();
    config.bottom_channels = kwargs.require("bottom_channels").as_i64();
    config.transformer_layers = kwargs.require("t_layers").as_i64();
    config.transformer_hidden_scale = kwargs.require("t_hidden_scale").as_f32();
    config.transformer_heads = kwargs.require("t_heads").as_i64();
    config.transformer_dropout = kwargs.require("t_dropout").as_f32();
    config.transformer_layer_scale = kwargs.require("t_layer_scale").as_bool();
    config.transformer_gelu = kwargs.require("t_gelu").as_bool();
    config.transformer_norm_in_group = kwargs.require("t_norm_in_group").as_bool();
    config.transformer_group_norm = kwargs.require("t_group_norm").as_bool();
    config.transformer_norm_in = kwargs.require("t_norm_in").as_bool();
    config.transformer_norm_first = kwargs.require("t_norm_first").as_bool();
    config.transformer_norm_out = kwargs.require("t_norm_out").as_bool();
    config.transformer_cross_first = kwargs.require("t_cross_first").as_bool();
    config.transformer_max_period = kwargs.require("t_max_period").as_f32();
    config.transformer_weight_pos_embed = kwargs.require("t_weight_pos_embed").as_f32();

    if (kwargs.require("channels_time").is_null() == false) {
        throw std::runtime_error("HTDemucs channels_time != null is not supported yet");
    }
    if (!kwargs.require("multi_freqs").as_array().empty()) {
        throw std::runtime_error("HTDemucs multi_freqs is not supported yet");
    }
    if (kwargs.require("t_emb").as_string() != "sin") {
        throw std::runtime_error("HTDemucs only supports t_emb=sin");
    }
    if (config.transformer_norm_in_group || config.transformer_group_norm) {
        throw std::runtime_error("HTDemucs native runtime currently supports only layer-norm transformer checkpoints");
    }
    if (kwargs.require("t_sin_random_shift").as_i64() != 0) {
        throw std::runtime_error("HTDemucs only supports t_sin_random_shift=0");
    }
    if (kwargs.require("t_sparse_self_attn").as_bool() || kwargs.require("t_sparse_cross_attn").as_bool()) {
        throw std::runtime_error("HTDemucs sparse attention is not supported");
    }
    if (!config.cac) {
        throw std::runtime_error("HTDemucs native runtime currently supports only cac=true");
    }
    if (config.wiener_iters != 0 || config.wiener_residual) {
        throw std::runtime_error("HTDemucs native runtime currently supports only cac path with wiener_iters=0");
    }

    config.segment_samples = static_cast<int64_t>(std::llround(static_cast<double>(config.sample_rate) * config.segment_seconds));
    config.stft_freq_bins = config.n_fft / 2;
    config.stft_frames = static_cast<int>(std::ceil(static_cast<double>(config.segment_samples) / static_cast<double>(config.hop_length)));
    config.input_freq_channels = config.audio_channels * 2;
    config.output_freq_channels = static_cast<int>(config.sources.size()) * config.audio_channels * 2;
    config.output_time_channels = static_cast<int>(config.sources.size()) * config.audio_channels;
    return config;
}

runtime::ModelMetadata build_metadata(const DemucsBagManifest & manifest) {
    runtime::ModelMetadata metadata;
    metadata.family = "htdemucs";
    metadata.variant = manifest.name;
    metadata.description = manifest.model_type == "demucs_bag"
        ? "HTDemucs source separation bag converted from Demucs reference checkpoints."
        : "HTDemucs base source separation model converted from Demucs reference checkpoints.";
    metadata.config_candidates = {"manifest.json", "*/config.json"};
    metadata.weight_candidates = {"*/model.safetensors"};
    return metadata;
}

runtime::CapabilitySet build_capabilities(const HTDemucsConfig & config) {
    runtime::CapabilitySet capabilities;
    capabilities.supported_tasks = {
        {runtime::VoiceTaskKind::SourceSeparation, {runtime::RunMode::Offline}},
    };
    capabilities.languages = {"N/A"};
    (void) config;
    return capabilities;
}

std::shared_ptr<const DemucsSubmodelAssets> load_submodel(
    const std::filesystem::path & root,
    const DemucsConvertedModelRef & model) {
    auto sub = std::make_shared<DemucsSubmodelAssets>();
    sub->manifest_entry = model;
    sub->resources = assets::ResourceBundle(root / model.output_dir);
    sub->resources.add_model_files({
        {"config", "config.json", true},
        {"weights", "model.safetensors", true},
    });
    sub->tensor_source = sub->resources.open_tensor_source("weights");
    sub->config = parse_submodel_config(sub->resources.require_file("config"));
    return sub;
}

}  // namespace

void validate_demucs_weight_storage_type(assets::TensorStorageType storage_type) {
    switch (storage_type) {
    case assets::TensorStorageType::Native:
    case assets::TensorStorageType::F32:
    case assets::TensorStorageType::F16:
    case assets::TensorStorageType::BF16:
    case assets::TensorStorageType::Q8_0:
        return;
    default:
        throw std::runtime_error(
            "htdemucs weight_type currently supports only native, f32, f16, bf16, and q8_0");
    }
}

runtime::ModelInspection inspect_htdemucs_model(const runtime::ModelLoadRequest & request) {
    const auto root = resolve_model_root(request.model_path);
    const auto manifest = parse_manifest(root);
    const auto first = load_submodel(root, manifest.models.front());

    runtime::ModelInspection inspection;
    inspection.model_root = root;
    inspection.metadata = build_metadata(manifest);
    inspection.capabilities = build_capabilities(first->config);
    inspection.discovered_configs = runtime::discover_named_assets(root, {"manifest.json", "*/config.json"});
    inspection.discovered_weights = runtime::discover_named_assets(root, {"*/model.safetensors"});
    return inspection;
}

std::shared_ptr<const DemucsAssets> load_htdemucs_assets(const runtime::ModelLoadRequest & request) {
    const auto root = resolve_model_root(request.model_path);
    const auto manifest = parse_manifest(root);
    auto assets = std::make_shared<DemucsAssets>();
    assets->manifest = manifest;
    assets->metadata = build_metadata(manifest);
    for (const auto & model : manifest.models) {
        assets->submodels.push_back(load_submodel(root, model));
    }
    assets->capabilities = build_capabilities(assets->submodels.front()->config);
    return assets;
}

}  // namespace engine::models::demucs
