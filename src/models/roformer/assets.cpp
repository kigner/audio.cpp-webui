#include "engine/models/roformer/assets.h"

#include "engine/framework/audio/dsp.h"
#include "engine/framework/io/filesystem.h"
#include "engine/framework/io/json.h"
#include "engine/framework/io/yaml.h"

#include <algorithm>
#include <cctype>
#include <sstream>
#include <numeric>
#include <stdexcept>

namespace engine::models::roformer {
namespace json = engine::io::json;
namespace {

std::filesystem::path resolve_model_root(const std::filesystem::path & model_path) {
    if (engine::io::is_existing_directory(model_path)) {
        return std::filesystem::weakly_canonical(model_path);
    }
    throw std::runtime_error("RoFormer models expect a model directory: " + model_path.string());
}

std::string trim_copy(std::string value) {
    const auto is_space = [](unsigned char ch) { return std::isspace(ch) != 0; };
    value.erase(value.begin(), std::find_if(value.begin(), value.end(), [&](char ch) { return !is_space(static_cast<unsigned char>(ch)); }));
    value.erase(std::find_if(value.rbegin(), value.rend(), [&](char ch) { return !is_space(static_cast<unsigned char>(ch)); }).base(), value.end());
    return value;
}

std::string normalize_scalar(std::string value) {
    value = trim_copy(std::move(value));
    if (value == "True") {
        return "true";
    }
    if (value == "False") {
        return "false";
    }
    if (value == "!!python/tuple") {
        return "";
    }
    if (value == "None") {
        return "";
    }
    return value;
}

engine::io::yaml::FlattenedDocument parse_roformer_yaml_file(const std::filesystem::path & path) {
    engine::io::yaml::FlattenedDocument parsed;
    std::istringstream stream(engine::io::read_text_file(path));
    std::string line;
    std::string current_section;
    std::string current_list_key;
    int line_number = 0;
    while (std::getline(stream, line)) {
        ++line_number;
        const auto comment = line.find('#');
        if (comment != std::string::npos) {
            line.erase(comment);
        }
        if (line.empty()) {
            continue;
        }
        const size_t indent = line.find_first_not_of(' ');
        if (indent == std::string::npos) {
            continue;
        }
        auto trimmed = trim_copy(line.substr(indent));
        if (trimmed.empty() || trimmed == "!!python/tuple") {
            continue;
        }
        if (indent == 0) {
            if (trimmed.back() != ':') {
                throw std::runtime_error(
                    "Unsupported RoFormer config syntax at line " + std::to_string(line_number));
            }
            current_section = trim_copy(trimmed.substr(0, trimmed.size() - 1));
            current_list_key.clear();
            continue;
        }
        if (current_section.empty()) {
            throw std::runtime_error(
                "RoFormer config is missing a top-level section before line " + std::to_string(line_number));
        }
        if (trimmed.rfind("- ", 0) == 0 && !current_list_key.empty()) {
            parsed.lists[current_list_key].push_back(normalize_scalar(trimmed.substr(2)));
            continue;
        }
        if (indent == 2) {
            const auto colon = trimmed.find(':');
            if (colon == std::string::npos) {
                throw std::runtime_error(
                    "Unsupported RoFormer config entry at line " + std::to_string(line_number));
            }
            const auto key = trim_copy(trimmed.substr(0, colon));
            auto value = normalize_scalar(trimmed.substr(colon + 1));
            if (value.empty()) {
                current_list_key = current_section + "." + key;
                parsed.lists[current_list_key] = {};
            } else {
                parsed.scalars[current_section + "." + key] = std::move(value);
                current_list_key.clear();
            }
            continue;
        }
        throw std::runtime_error(
            "Unsupported RoFormer config indentation at line " + std::to_string(line_number));
    }
    return parsed;
}

std::vector<runtime::NamedAsset> discover_config_assets(const runtime::ModelLoadRequest & request) {
    return runtime::discover_named_assets(resolve_model_root(request.model_path), {"config.json", "config.yaml", "config.yml"});
}

std::vector<runtime::NamedAsset> discover_weight_assets(const runtime::ModelLoadRequest & request) {
    return runtime::discover_named_assets(resolve_model_root(request.model_path), {"model.safetensors"});
}

bool optional_bool_scalar(
    const engine::io::yaml::FlattenedDocument & parsed,
    const std::string & key,
    bool default_value) {
    const auto it = parsed.scalars.find(key);
    if (it == parsed.scalars.end()) {
        return default_value;
    }
    return engine::io::yaml::parse_bool_scalar(it->second, key);
}

std::vector<std::string> require_string_list(
    const engine::io::yaml::FlattenedDocument & parsed,
    const std::string & key) {
    const auto it = parsed.lists.find(key);
    if (it == parsed.lists.end() || it->second.empty()) {
        throw std::runtime_error("Missing RoFormer config list: " + key);
    }
    return it->second;
}

std::vector<int64_t> require_i64_list(
    const engine::io::yaml::FlattenedDocument & parsed,
    const std::string & key) {
    const auto values = require_string_list(parsed, key);
    std::vector<int64_t> out;
    out.reserve(values.size());
    for (const auto & value : values) {
        out.push_back(std::stoll(value));
    }
    return out;
}

std::optional<std::string> optional_scalar(
    const engine::io::yaml::FlattenedDocument & parsed,
    const std::string & key) {
    const auto it = parsed.scalars.find(key);
    if (it == parsed.scalars.end()) {
        return std::nullopt;
    }
    return it->second;
}

}  // namespace

void validate_roformer_weight_storage_type(assets::TensorStorageType storage_type) {
    switch (storage_type) {
    case assets::TensorStorageType::Native:
    case assets::TensorStorageType::F32:
    case assets::TensorStorageType::F16:
    case assets::TensorStorageType::BF16:
    case assets::TensorStorageType::Q8_0:
        return;
    default:
        throw std::runtime_error(
            "mel_band_roformer weight_type currently supports only native, f32, f16, bf16, and q8_0");
    }
}

namespace {

bool json_matches_family(const engine::io::json::Value & value, RoformerFamily family) {
    const auto * model_type = value.find("model_type");
    if (model_type == nullptr || !model_type->is_string()) {
        return false;
    }
    switch (family) {
    case RoformerFamily::BSRoformer:
        return model_type->as_string() == "bs_roformer";
    case RoformerFamily::MelBandRoformer:
        return model_type->as_string() == "mel_band_roformer";
    }
    return false;
}

RoformerModelConfig resolve_model_config(
    const runtime::ModelLoadRequest & request,
    RoformerFamily family) {
    const auto root = resolve_model_root(request.model_path);
    const auto configs = discover_config_assets(request);
    const auto weights = discover_weight_assets(request);
    const auto * selected_config = runtime::select_named_asset(configs, request.config_id, "config");
    const auto * selected_weight = runtime::select_named_asset(weights, request.weight_id, "weight");
    if (selected_config == nullptr) {
        throw std::runtime_error("RoFormer config asset is required");
    }
    if (selected_weight == nullptr) {
        throw std::runtime_error("RoFormer weight asset is required");
    }
    const auto ext = selected_config->path.extension().string();
    const bool is_json = ext == ".json";
    if (is_json) {
        const auto parsed = engine::io::json::parse_file(selected_config->path);
        if (!json_matches_family(parsed, family)) {
            throw std::runtime_error(
                "RoFormer JSON config does not match requested family '" + family_name(family) + "'");
        }
    } else {
        const auto parsed = parse_roformer_yaml_file(selected_config->path);
        if (!config_matches_family(parsed, family)) {
            throw std::runtime_error(
                "RoFormer config does not match requested family '" + family_name(family) + "'");
        }
    }
    return {
        root,
        selected_config->path,
        selected_weight->path,
        is_json,
    };
}

void fill_mel_band_layout(
    RoformerArchitectureConfig & config,
    int num_bands) {
    engine::audio::MelFilterbankConfig mel_config;
    mel_config.sample_rate = config.sample_rate;
    mel_config.n_fft = config.n_fft;
    mel_config.n_mels = num_bands;
    mel_config.lowfreq = 0.0f;
    mel_config.highfreq = 0.0f;
    mel_config.slaney_norm = true;
    auto filterbank = engine::audio::MelFilterbank().build(mel_config);
    if (filterbank.shape.size() != 2) {
        throw std::runtime_error("RoFormer mel filterbank must be rank-2");
    }
    const int64_t bands = filterbank.shape[0];
    const int64_t freqs = filterbank.shape[1];
    if (bands != num_bands) {
        throw std::runtime_error("RoFormer mel filterbank band count mismatch");
    }
    auto & values = filterbank.values;
    values[0] = 1.0f;
    values[static_cast<size_t>((bands - 1) * freqs + (freqs - 1))] = 1.0f;

    std::vector<int64_t> num_freqs_per_band(static_cast<size_t>(bands), 0);
    std::vector<int64_t> num_bands_per_freq(static_cast<size_t>(freqs), 0);
    std::vector<int64_t> freq_indices;
    for (int64_t band = 0; band < bands; ++band) {
        for (int64_t freq = 0; freq < freqs; ++freq) {
            if (values[static_cast<size_t>(band * freqs + freq)] <= 0.0f) {
                continue;
            }
            ++num_freqs_per_band[static_cast<size_t>(band)];
            ++num_bands_per_freq[static_cast<size_t>(freq)];
            if (config.stereo) {
                freq_indices.push_back(freq * 2);
                freq_indices.push_back(freq * 2 + 1);
            } else {
                freq_indices.push_back(freq);
            }
        }
    }

    config.band_input_dims.reserve(static_cast<size_t>(bands));
    for (const int64_t count : num_freqs_per_band) {
        config.band_input_dims.push_back(2 * count * config.channels);
    }
    config.num_bands = num_bands;
    config.total_band_input_dim = 0;
    for (const int64_t dim : config.band_input_dims) {
        config.total_band_input_dim += static_cast<int>(dim);
    }
    config.merged_freq_indices = std::move(freq_indices);
    config.merged_band_counts.reserve(static_cast<size_t>(freqs * config.channels));
    for (int64_t freq = 0; freq < freqs; ++freq) {
        const int64_t count = std::max<int64_t>(1, num_bands_per_freq[static_cast<size_t>(freq)]);
        for (int channel = 0; channel < config.channels; ++channel) {
            config.merged_band_counts.push_back(count);
        }
    }
}

RoformerArchitectureConfig parse_yaml_architecture_config(
    const engine::io::yaml::FlattenedDocument & parsed,
    const assets::TensorSource & tensor_source,
    RoformerFamily family) {
    RoformerArchitectureConfig config;
    config.family = family;
    config.sample_rate = engine::io::yaml::require_int(parsed, "audio.sample_rate");
    config.channels = engine::io::yaml::require_int(parsed, "audio.num_channels");
    config.chunk_size = engine::io::yaml::require_int(parsed, "audio.chunk_size");
    config.inference_batch_size = engine::io::yaml::require_int(parsed, "inference.batch_size");
    config.inference_num_overlap = engine::io::yaml::require_int(parsed, "inference.num_overlap");
    config.inference_normalize = optional_bool_scalar(parsed, "inference.normalize", false);
    config.dim = engine::io::yaml::require_int(parsed, "model.dim");
    config.depth = engine::io::yaml::require_int(parsed, "model.depth");
    config.stereo = optional_bool_scalar(parsed, "model.stereo", config.channels == 2);
    config.num_stems = engine::io::yaml::require_int(parsed, "model.num_stems");
    config.time_transformer_depth = engine::io::yaml::require_int(parsed, "model.time_transformer_depth");
    config.freq_transformer_depth = engine::io::yaml::require_int(parsed, "model.freq_transformer_depth");
    config.linear_transformer_depth = engine::io::yaml::require_int(parsed, "model.linear_transformer_depth");
    config.dim_head = engine::io::yaml::require_int(parsed, "model.dim_head");
    config.heads = engine::io::yaml::require_int(parsed, "model.heads");
    config.n_fft = engine::io::yaml::require_int(parsed, "model.stft_n_fft");
    config.hop_length = engine::io::yaml::require_int(parsed, "model.stft_hop_length");
    config.win_length = engine::io::yaml::require_int(parsed, "model.stft_win_length");
    config.stft_normalized = optional_bool_scalar(parsed, "model.stft_normalized", false);
    config.mask_estimator_depth = engine::io::yaml::require_int(parsed, "model.mask_estimator_depth");
    config.mlp_expansion_factor = engine::io::yaml::optional_int(parsed, "model.mlp_expansion_factor").value_or(4);
    config.skip_connection = optional_bool_scalar(parsed, "model.skip_connection", false);
    config.stft_freq_bins = engine::io::yaml::require_int(parsed, "model.dim_freqs_in");
    config.chunk_frames = engine::io::yaml::require_int(parsed, "inference.dim_t");
    config.instruments = require_string_list(parsed, "training.instruments");
    config.target_instrument = optional_scalar(parsed, "training.target_instrument");
    config.has_final_norm = tensor_source.has_tensor("final_norm.gamma");

    if (config.channels != (config.stereo ? 2 : 1)) {
        throw std::runtime_error("RoFormer audio.num_channels must match model.stereo");
    }
    if (config.n_fft / 2 + 1 != config.stft_freq_bins) {
        throw std::runtime_error("RoFormer dim_freqs_in does not match stft_n_fft");
    }
    if (config.linear_transformer_depth != 0) {
        throw std::runtime_error("RoFormer native port does not support linear_transformer_depth > 0 yet");
    }

    if (family == RoformerFamily::BSRoformer) {
        const auto freqs_per_bands = require_i64_list(parsed, "model.freqs_per_bands");
        const auto total_freqs = std::accumulate(freqs_per_bands.begin(), freqs_per_bands.end(), int64_t{0});
        if (total_freqs != config.stft_freq_bins) {
            throw std::runtime_error("RoFormer freqs_per_bands does not sum to dim_freqs_in");
        }
        config.band_input_dims.reserve(freqs_per_bands.size());
        for (const int64_t freqs : freqs_per_bands) {
            config.band_input_dims.push_back(2 * freqs * config.channels);
        }
    } else {
        const int num_bands = engine::io::yaml::require_int(parsed, "model.num_bands");
        fill_mel_band_layout(config, num_bands);
    }

    return config;
}

RoformerArchitectureConfig parse_json_architecture_config(const engine::io::json::Value & parsed) {
    if (!parsed.is_object()) {
        throw std::runtime_error("RoFormer JSON config root must be an object");
    }
    RoformerArchitectureConfig config;
    config.family = RoformerFamily::MelBandRoformer;
    config.sample_rate = json::require_i32(parsed, "sample_rate");
    config.channels = 2;
    config.stereo = true;
    config.chunk_size = json::require_i32(parsed, "chunk_size");
    config.inference_batch_size = 1;
    config.inference_num_overlap = json::require_i32(parsed, "num_overlap");
    config.inference_normalize = false;
    config.dim = json::require_i32(parsed, "dim");
    config.depth = json::require_i32(parsed, "depth");
    config.num_bands = json::require_i32(parsed, "num_bands");
    config.num_stems = json::require_i32(parsed, "num_stems");
    config.time_transformer_depth = json::optional_i32(parsed, "time_transformer_depth", 1);
    config.freq_transformer_depth = json::optional_i32(parsed, "freq_transformer_depth", 1);
    config.dim_head = json::require_i32(parsed, "dim_head");
    config.heads = json::require_i32(parsed, "heads");
    config.n_fft = json::require_i32(parsed, "n_fft");
    config.hop_length = json::require_i32(parsed, "hop_length");
    config.win_length = json::require_i32(parsed, "win_length");
    config.stft_normalized = json::optional_bool(parsed, "stft_normalized", false);
    config.mask_estimator_depth = json::require_i32(parsed, "mask_estimator_depth");
    config.mlp_expansion_factor = json::optional_i32(parsed, "mlp_expansion_factor", 4);
    config.skip_connection = false;
    config.stft_freq_bins = config.n_fft / 2 + 1;
    config.chunk_frames = 1 + config.chunk_size / config.hop_length;
    config.instruments = {"vocals"};
    config.target_instrument = std::string("vocals");
    config.has_final_norm = json::optional_bool(parsed, "has_final_norm", false);
    fill_mel_band_layout(config, config.num_bands);
    return config;
}

runtime::ModelMetadata make_metadata(
    const RoformerModelConfig & config,
    RoformerFamily family) {
    runtime::ModelMetadata metadata;
    metadata.family = family_name(family);
    metadata.variant = config.model_root.filename().string();
    metadata.description =
        family == RoformerFamily::BSRoformer
            ? "Band-split RoFormer music source separation model."
            : "Mel-band RoFormer music source separation model.";
    metadata.config_candidates = {"config.json", "config.yaml", "config.yml"};
    metadata.weight_candidates = {"model.safetensors"};
    return metadata;
}

runtime::CapabilitySet make_capabilities() {
    runtime::CapabilitySet capabilities;
    capabilities.supported_tasks = {
        {runtime::VoiceTaskKind::SourceSeparation, {runtime::RunMode::Offline}},
    };
    return capabilities;
}

}  // namespace

std::string family_name(RoformerFamily family) {
    switch (family) {
    case RoformerFamily::BSRoformer:
        return "band_split_roformer";
    case RoformerFamily::MelBandRoformer:
        return "mel_band_roformer";
    }
    throw std::runtime_error("unknown RoFormer family");
}

std::string family_variant(RoformerFamily family) {
    switch (family) {
    case RoformerFamily::BSRoformer:
        return "band-split";
    case RoformerFamily::MelBandRoformer:
        return "mel-band";
    }
    throw std::runtime_error("unknown RoFormer family");
}

bool config_matches_family(
    const engine::io::yaml::FlattenedDocument & parsed,
    RoformerFamily family) {
    switch (family) {
    case RoformerFamily::BSRoformer:
        return parsed.lists.find("model.freqs_per_bands") != parsed.lists.end();
    case RoformerFamily::MelBandRoformer:
        return parsed.scalars.find("model.num_bands") != parsed.scalars.end();
    }
    return false;
}

runtime::ModelInspection inspect_roformer_model(
    const runtime::ModelLoadRequest & request,
    RoformerFamily family) {
    const auto model_config = resolve_model_config(request, family);
    runtime::ModelInspection inspection;
    inspection.model_root = model_config.model_root;
    inspection.metadata = make_metadata(model_config, family);
    inspection.capabilities = make_capabilities();
    inspection.discovered_configs = discover_config_assets(request);
    inspection.discovered_weights = discover_weight_assets(request);
    return inspection;
}

std::shared_ptr<const RoformerAssets> load_roformer_assets(
    const runtime::ModelLoadRequest & request,
    RoformerFamily family) {
    const auto model_config = resolve_model_config(request, family);
    auto assets = std::make_shared<RoformerAssets>();
    assets->metadata = make_metadata(model_config, family);
    assets->capabilities = make_capabilities();
    assets->resources = assets::ResourceBundle(model_config.model_root);
    assets->resources.add_file("config", model_config.config_path);
    assets->resources.add_file("weights", model_config.weight_path);
    assets->tensor_source = assets->resources.open_tensor_source("weights");
    if (model_config.config_is_json) {
        const auto parsed = engine::io::json::parse_file(model_config.config_path);
        assets->config = parse_json_architecture_config(parsed);
    } else {
        const auto parsed = parse_roformer_yaml_file(model_config.config_path);
        assets->config = parse_yaml_architecture_config(parsed, *assets->tensor_source, family);
    }
    return assets;
}

}  // namespace engine::models::roformer
