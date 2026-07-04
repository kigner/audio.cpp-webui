#include "engine/models/vibevoice/lora.h"

#include "engine/framework/assets/torch_bin.h"
#include "engine/framework/debug/profiler.h"
#include "engine/framework/debug/trace.h"
#include "engine/framework/io/filesystem.h"
#include "engine/framework/io/json.h"
#include "engine/framework/runtime/options.h"

#include <chrono>
#include <cmath>
#include <cstring>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace engine::models::vibevoice {
namespace json = engine::io::json;
namespace {

constexpr std::string_view kLoraWeightsFile = "adapter_model.safetensors";
constexpr std::string_view kLoraConfigFile = "adapter_config.json";
constexpr std::string_view kPeftPrefix = "base_model.model.";
constexpr std::string_view kLanguageModelPrefix = "model.language_model.";
constexpr std::string_view kLoraASuffix = ".lora_A.weight";
constexpr std::string_view kLoraBSuffix = ".lora_B.weight";
constexpr std::string_view kPredictionHeadPrefix = "model.prediction_head.";
constexpr std::string_view kAcousticConnectorPrefix = "model.acoustic_connector.";
constexpr std::string_view kSemanticConnectorPrefix = "model.semantic_connector.";
constexpr int64_t kParallelLoraMergeWorkItems = 1ll << 20;

void log_line(const std::string & message, engine::debug::LogLevel level = engine::debug::LogLevel::Info) {
    engine::debug::log_message(level, "vibevoice", message);
}

struct LoraAdapterPaths {
    std::filesystem::path weights;
    std::optional<std::filesystem::path> config;
};

struct LoraTensorDelta {
    std::vector<float> a;
    std::vector<float> b;
    int64_t r = 0;
    int64_t in = 0;
    int64_t out = 0;
    float scale = 1.0F;
};

struct OverrideTensor {
    std::vector<int64_t> shape;
    std::vector<float> values;
};

struct LoraMergeResult {
    std::vector<float> values;
    double base_read_ms = 0.0;
    double compute_ms = 0.0;
};

struct LoraTensorNames {
    std::optional<std::string> a_name;
    std::optional<std::string> b_name;
};

bool has_suffix(const std::string & name, std::string_view suffix) {
    return name.size() >= suffix.size() &&
        name.compare(name.size() - suffix.size(), suffix.size(), suffix) == 0;
}

std::string strip_prefix(const std::string & name, std::string_view prefix) {
    if (name.rfind(prefix, 0) == 0) {
        return name.substr(prefix.size());
    }
    return name;
}

LoraAdapterPaths resolve_adapter_paths(const std::filesystem::path & adapter_path) {
    LoraAdapterPaths paths;
    if (engine::io::is_existing_directory(adapter_path)) {
        paths.weights = adapter_path / kLoraWeightsFile;
        const auto config = adapter_path / kLoraConfigFile;
        if (engine::io::is_existing_file(config)) {
            paths.config = config;
        }
    } else if (engine::io::is_existing_file(adapter_path)) {
        paths.weights = adapter_path;
        const auto config = adapter_path.parent_path() / kLoraConfigFile;
        if (engine::io::is_existing_file(config)) {
            paths.config = config;
        }
    } else {
        throw std::runtime_error("VibeVoice LoRA path does not exist: " + adapter_path.string());
    }
    if (!engine::io::is_existing_file(paths.weights)) {
        throw std::runtime_error("VibeVoice LoRA adapter weights not found: " + paths.weights.string());
    }
    return paths;
}

std::filesystem::path resolve_adapter_dir(const std::filesystem::path & adapter_path) {
    if (engine::io::is_existing_directory(adapter_path)) {
        return adapter_path;
    }
    return adapter_path.parent_path();
}

float resolve_adapter_scale(const std::optional<std::filesystem::path> & config_path, float scale_override) {
    if (scale_override > 0.0F) {
        return scale_override;
    }
    if (!config_path.has_value()) {
        throw std::runtime_error(
            "VibeVoice LoRA has no adapter_config.json; pass vibevoice.lora_scale to set the merge scale");
    }
    const auto root = json::parse_file(*config_path);
    const auto rank = json::require_i64(root, "r");
    if (rank <= 0) {
        throw std::runtime_error("VibeVoice LoRA adapter_config.json has non-positive r");
    }
    const float alpha = json::optional_f32(root, "lora_alpha", static_cast<float>(rank));
    const bool use_rslora = json::optional_bool(root, "use_rslora", false);
    const float denom = use_rslora ? std::sqrt(static_cast<float>(rank)) : static_cast<float>(rank);
    return alpha / denom;
}

std::string resolve_base_weight_name(const assets::TensorSource & base, const std::string & module_path) {
    const std::string prefixed = std::string(kLanguageModelPrefix) + module_path + ".weight";
    if (base.has_tensor(prefixed)) {
        return prefixed;
    }
    const std::string bare = module_path + ".weight";
    if (base.has_tensor(bare)) {
        return bare;
    }
    throw std::runtime_error("VibeVoice LoRA targets a module with no matching base weight: " + module_path);
}

LoraMergeResult merged_f32_values(
    const assets::TensorSource & base,
    const std::string & name,
    const LoraTensorDelta & delta) {
    const auto base_read_started = std::chrono::steady_clock::now();
    auto values = base.require_f32(name, std::optional<std::vector<int64_t>>({delta.out, delta.in}));
    const double base_read_ms = engine::debug::elapsed_ms(base_read_started);
    const int64_t merge_work_items = delta.out * delta.in * delta.r;
    // values[o, i] += scale * sum_k B[o, k] * A[k, i]
    const auto compute_started = std::chrono::steady_clock::now();
    #pragma omp parallel for if(merge_work_items >= kParallelLoraMergeWorkItems) schedule(static)
    for (int64_t o = 0; o < delta.out; ++o) {
        const int64_t row = o * delta.in;
        for (int64_t k = 0; k < delta.r; ++k) {
            const float b = delta.scale * delta.b[static_cast<size_t>(o * delta.r + k)];
            if (b == 0.0F) {
                continue;
            }
            const float * a_row = delta.a.data() + static_cast<size_t>(k * delta.in);
            for (int64_t i = 0; i < delta.in; ++i) {
                values[static_cast<size_t>(row + i)] += b * a_row[i];
            }
        }
    }
    return LoraMergeResult{std::move(values), base_read_ms, engine::debug::elapsed_ms(compute_started)};
}

// A weight source that overlays a fine-tune adapter onto a base source: full overrides replace a
// base tensor outright, LoRA deltas add B*A to it, everything else falls through to the base.
class VibeVoiceFineTuneSource final : public assets::TensorSource {
public:
    VibeVoiceFineTuneSource(
        std::shared_ptr<const assets::TensorSource> base,
        std::unordered_map<std::string, LoraTensorDelta> deltas,
        std::unordered_map<std::string, OverrideTensor> overrides)
        : base_(std::move(base)),
          deltas_(std::move(deltas)),
          overrides_(std::move(overrides)) {}

    const std::filesystem::path & source_path() const noexcept override {
        return base_->source_path();
    }

    bool has_tensor(std::string_view name) const noexcept override {
        return base_->has_tensor(name);
    }

    assets::TensorMetadata require_metadata(std::string_view name) const override {
        return base_->require_metadata(name);
    }

    std::vector<assets::TensorMetadata> tensors() const override {
        return base_->tensors();
    }

    void release_storage() const override {
        base_->release_storage();
    }

    assets::RawTensorData require_tensor_data(std::string_view name) const override {
        const std::string key(name);
        if (const auto override_it = overrides_.find(key); override_it != overrides_.end()) {
            const auto started = std::chrono::steady_clock::now();
            auto raw = raw_from_f32(key, override_it->second.shape, override_it->second.values);
            record_override_export(engine::debug::elapsed_ms(started), override_it->second.values.size());
            return raw;
        }
        const auto delta = deltas_.find(key);
        if (delta == deltas_.end()) {
            return base_->require_tensor_data(name);
        }
        auto merged = merged_f32_values(*base_, key, delta->second);
        record_decoder_merge(merged.base_read_ms, merged.compute_ms, merged.values.size());
        return raw_from_f32(key, {delta->second.out, delta->second.in}, merged.values);
    }

    void set_backend_tensor(
        ggml_tensor * tensor,
        std::string_view name,
        assets::TensorStorageType storage_type,
        const std::vector<int64_t> & expected_shape) const override {
        const std::string key(name);
        const auto shape = shape_from_expected(key, expected_shape);
        const ggml_type type = assets::ggml_type_for_tensor_storage(storage_type);
        if (const auto override_it = overrides_.find(key); override_it != overrides_.end()) {
            if (override_it->second.shape != expected_shape) {
                throw std::runtime_error("tensor shape mismatch for " + key);
            }
            const auto started = std::chrono::steady_clock::now();
            assets::set_backend_tensor_from_f32_parallel(tensor, key, override_it->second.values, shape, type);
            record_override_upload(engine::debug::elapsed_ms(started), override_it->second.values.size());
            return;
        }
        const auto delta = deltas_.find(key);
        if (delta == deltas_.end()) {
            base_->set_backend_tensor(tensor, name, storage_type, expected_shape);
            return;
        }
        if (expected_shape != std::vector<int64_t>({delta->second.out, delta->second.in})) {
            throw std::runtime_error("tensor shape mismatch for " + key);
        }
        auto merged = merged_f32_values(*base_, key, delta->second);
        record_decoder_merge(merged.base_read_ms, merged.compute_ms, merged.values.size());
        const auto upload_started = std::chrono::steady_clock::now();
        assets::set_backend_tensor_from_f32_parallel(tensor, key, merged.values, shape, type);
        record_decoder_upload(engine::debug::elapsed_ms(upload_started), merged.values.size());
    }

    std::vector<float> require_f32(
        std::string_view name,
        const std::optional<std::vector<int64_t>> & expected_shape) const override {
        const std::string key(name);
        if (const auto override_it = overrides_.find(key); override_it != overrides_.end()) {
            const auto started = std::chrono::steady_clock::now();
            auto values = override_it->second.values;
            record_override_export(engine::debug::elapsed_ms(started), values.size());
            return values;
        }
        const auto delta = deltas_.find(key);
        if (delta == deltas_.end()) {
            return base_->require_f32(name, expected_shape);
        }
        auto merged = merged_f32_values(*base_, key, delta->second);
        record_decoder_merge(merged.base_read_ms, merged.compute_ms, merged.values.size());
        return std::move(merged.values);
    }

    std::optional<std::vector<float>> optional_f32(
        std::string_view name,
        const std::optional<std::vector<int64_t>> & expected_shape) const override {
        if (!has_tensor(name)) {
            return std::nullopt;
        }
        return require_f32(name, expected_shape);
    }

    int64_t require_i64_scalar(std::string_view name) const override {
        return base_->require_i64_scalar(name);
    }

private:
    static assets::RawTensorData raw_from_f32(
        const std::string & name,
        const std::vector<int64_t> & shape,
        const std::vector<float> & values) {
        assets::RawTensorData raw;
        raw.metadata = assets::TensorMetadata{name, "F32", shape};
        raw.bytes.resize(values.size() * sizeof(float));
        std::memcpy(raw.bytes.data(), values.data(), raw.bytes.size());
        return raw;
    }

    static engine::core::TensorShape shape_from_expected(
        const std::string & name,
        const std::vector<int64_t> & expected_shape) {
        switch (expected_shape.size()) {
            case 1:
                return engine::core::TensorShape::from_dims({expected_shape[0]});
            case 2:
                return engine::core::TensorShape::from_dims({expected_shape[0], expected_shape[1]});
            case 3:
                return engine::core::TensorShape::from_dims({expected_shape[0], expected_shape[1], expected_shape[2]});
            case 4:
                return engine::core::TensorShape::from_dims(
                    {expected_shape[0], expected_shape[1], expected_shape[2], expected_shape[3]});
            default:
                throw std::runtime_error("tensor rank must be between 1 and 4: " + name);
        }
    }

    void record_decoder_merge(double base_read_ms, double compute_ms, size_t values) const {
        decoder_base_read_ms_ += base_read_ms;
        decoder_merge_compute_ms_ += compute_ms;
        decoder_merge_values_ += static_cast<uint64_t>(values);
        ++decoder_merge_tensors_;
        if (!decoder_merge_logged_ && decoder_merge_tensors_ == deltas_.size()) {
            engine::debug::timing_log_scalar("vibevoice.lora.decoder_base_read_ms", decoder_base_read_ms_);
            engine::debug::timing_log_scalar("vibevoice.lora.decoder_merge_compute_ms", decoder_merge_compute_ms_);
            engine::debug::timing_log_scalar(
                "vibevoice.lora.decoder_merge_ms",
                decoder_base_read_ms_ + decoder_merge_compute_ms_);
            engine::debug::timing_log_scalar("vibevoice.lora.decoder_merge_tensors", decoder_merge_tensors_);
            engine::debug::timing_log_scalar("vibevoice.lora.decoder_merge_values", decoder_merge_values_);
            decoder_merge_logged_ = true;
        }
    }

    void record_decoder_upload(double ms, size_t values) const {
        decoder_upload_ms_ += ms;
        decoder_upload_values_ += static_cast<uint64_t>(values);
        ++decoder_upload_tensors_;
        if (!decoder_upload_logged_ && decoder_upload_tensors_ == deltas_.size()) {
            engine::debug::timing_log_scalar("vibevoice.lora.decoder_upload_ms", decoder_upload_ms_);
            engine::debug::timing_log_scalar("vibevoice.lora.decoder_upload_tensors", decoder_upload_tensors_);
            engine::debug::timing_log_scalar("vibevoice.lora.decoder_upload_values", decoder_upload_values_);
            decoder_upload_logged_ = true;
        }
    }

    void record_override_export(double ms, size_t values) const {
        override_export_ms_ += ms;
        override_export_values_ += static_cast<uint64_t>(values);
        ++override_export_tensors_;
        maybe_log_override_summary();
    }

    void record_override_upload(double ms, size_t values) const {
        override_upload_ms_ += ms;
        override_upload_values_ += static_cast<uint64_t>(values);
        ++override_upload_tensors_;
        maybe_log_override_summary();
    }

    void maybe_log_override_summary() const {
        if (!override_summary_logged_ && override_upload_tensors_ + override_export_tensors_ == overrides_.size()) {
            engine::debug::timing_log_scalar("vibevoice.lora.override_export_ms", override_export_ms_);
            engine::debug::timing_log_scalar("vibevoice.lora.override_export_tensors", override_export_tensors_);
            engine::debug::timing_log_scalar("vibevoice.lora.override_export_values", override_export_values_);
            engine::debug::timing_log_scalar("vibevoice.lora.override_upload_ms", override_upload_ms_);
            engine::debug::timing_log_scalar("vibevoice.lora.override_upload_tensors", override_upload_tensors_);
            engine::debug::timing_log_scalar("vibevoice.lora.override_upload_values", override_upload_values_);
            override_summary_logged_ = true;
        }
    }

    std::shared_ptr<const assets::TensorSource> base_;
    std::unordered_map<std::string, LoraTensorDelta> deltas_;
    std::unordered_map<std::string, OverrideTensor> overrides_;
    mutable double decoder_base_read_ms_ = 0.0;
    mutable double decoder_merge_compute_ms_ = 0.0;
    mutable uint64_t decoder_merge_values_ = 0;
    mutable size_t decoder_merge_tensors_ = 0;
    mutable bool decoder_merge_logged_ = false;
    mutable double decoder_upload_ms_ = 0.0;
    mutable uint64_t decoder_upload_values_ = 0;
    mutable size_t decoder_upload_tensors_ = 0;
    mutable bool decoder_upload_logged_ = false;
    mutable double override_export_ms_ = 0.0;
    mutable uint64_t override_export_values_ = 0;
    mutable size_t override_export_tensors_ = 0;
    mutable double override_upload_ms_ = 0.0;
    mutable uint64_t override_upload_values_ = 0;
    mutable size_t override_upload_tensors_ = 0;
    mutable bool override_summary_logged_ = false;
};

std::unordered_map<std::string, LoraTensorNames> collect_lora_tensor_names(const assets::TensorSource & adapter) {
    std::unordered_map<std::string, LoraTensorNames> names;
    for (const auto & metadata : adapter.tensors()) {
        const std::string stripped = strip_prefix(metadata.name, kPeftPrefix);
        if (has_suffix(stripped, kLoraASuffix)) {
            names[stripped.substr(0, stripped.size() - kLoraASuffix.size())].a_name = metadata.name;
        } else if (has_suffix(stripped, kLoraBSuffix)) {
            names[stripped.substr(0, stripped.size() - kLoraBSuffix.size())].b_name = metadata.name;
        }
    }
    return names;
}

LoraTensorDelta load_lora_delta(
    const assets::TensorSource & base,
    const assets::TensorSource & adapter,
    const std::string & module_path,
    const LoraTensorNames & names,
    const std::string & base_name,
    float scale) {
    if (!names.a_name.has_value() || !names.b_name.has_value()) {
        throw std::runtime_error("VibeVoice LoRA module is missing an A/B pair: " + module_path);
    }
    const auto a_meta = adapter.require_metadata(*names.a_name);
    const auto b_meta = adapter.require_metadata(*names.b_name);
    if (a_meta.shape.size() != 2 || b_meta.shape.size() != 2) {
        throw std::runtime_error("VibeVoice LoRA A/B tensors must be rank-2: " + module_path);
    }
    LoraTensorDelta delta;
    delta.r = a_meta.shape[0];
    delta.in = a_meta.shape[1];
    delta.out = b_meta.shape[0];
    delta.scale = scale;
    if (b_meta.shape[1] != delta.r) {
        throw std::runtime_error("VibeVoice LoRA A/B rank mismatch for " + module_path);
    }
    if (base.require_metadata(base_name).shape != std::vector<int64_t>({delta.out, delta.in})) {
        throw std::runtime_error(
            "VibeVoice LoRA shape mismatch for " + base_name + " (adapter is trained for a different model size)");
    }
    delta.a = adapter.require_f32(*names.a_name, std::optional<std::vector<int64_t>>({delta.r, delta.in}));
    delta.b = adapter.require_f32(*names.b_name, std::optional<std::vector<int64_t>>({delta.out, delta.r}));
    return delta;
}

// Opens the diffusion-head fine-tune weights, preferring safetensors over the pickled variants.
std::shared_ptr<const assets::TensorSource> open_diffusion_head_source(const std::filesystem::path & adapter_dir) {
    const auto safetensors = adapter_dir / "diffusion_head" / "model.safetensors";
    if (engine::io::is_existing_file(safetensors)) {
        return assets::open_tensor_source(safetensors);
    }
    const auto bin = adapter_dir / "diffusion_head_full.bin";
    if (engine::io::is_existing_file(bin)) {
        return assets::open_torch_bin_tensor_source(bin);
    }
    const auto nested_bin = adapter_dir / "diffusion_head" / "diffusion_head_full.bin";
    if (engine::io::is_existing_file(nested_bin)) {
        return assets::open_torch_bin_tensor_source(nested_bin);
    }
    return nullptr;
}

// Registers full-weight overrides for every adapter tensor that has a matching base tensor. A shape
// mismatch is a hard error (wrong model size); a missing base tensor is skipped like strict=False.
int add_full_overrides(
    const assets::TensorSource & base,
    const assets::TensorSource & source,
    std::string_view base_prefix,
    std::unordered_map<std::string, OverrideTensor> & overrides) {
    int count = 0;
    for (const auto & metadata : source.tensors()) {
        const std::string base_name = std::string(base_prefix) + metadata.name;
        if (!base.has_tensor(base_name)) {
            log_line("skip " + base_name + " (no matching base tensor)", engine::debug::LogLevel::Warning);
            continue;
        }
        if (base.require_metadata(base_name).shape != metadata.shape) {
            throw std::runtime_error(
                "VibeVoice fine-tune shape mismatch for " + base_name +
                " (adapter is trained for a different model size)");
        }
        OverrideTensor override_tensor;
        override_tensor.shape = metadata.shape;
        override_tensor.values = source.require_f32(metadata.name);
        overrides[base_name] = std::move(override_tensor);
        ++count;
    }
    return count;
}

void add_connector_overrides(
    const assets::TensorSource & base,
    const std::filesystem::path & adapter_dir,
    const char * subdir,
    std::string_view base_prefix,
    const char * label,
    std::unordered_map<std::string, OverrideTensor> & overrides) {
    const auto path = adapter_dir / subdir / "pytorch_model.bin";
    if (!engine::io::is_existing_file(path)) {
        log_line(std::string(label) + ": not present, skipped");
        return;
    }
    const auto source = assets::open_torch_bin_tensor_source(path);
    const int count = add_full_overrides(base, *source, base_prefix, overrides);
    log_line(std::string(label) + ": overrode " + std::to_string(count) + " tensors");
}

}  // namespace

std::shared_ptr<const assets::TensorSource> make_vibevoice_finetune_source(
    std::shared_ptr<const assets::TensorSource> base,
    const std::filesystem::path & adapter_path,
    float scale_override) {
    if (base == nullptr) {
        throw std::runtime_error("VibeVoice LoRA merge requires a base tensor source");
    }
    const auto prepare_started = std::chrono::steady_clock::now();
    const auto paths = resolve_adapter_paths(adapter_path);
    const float scale = resolve_adapter_scale(paths.config, scale_override);
    const auto adapter_open_started = std::chrono::steady_clock::now();
    const auto adapter = assets::open_tensor_source(paths.weights);
    engine::debug::timing_log_scalar("vibevoice.lora.adapter_open_ms", engine::debug::elapsed_ms(adapter_open_started));

    const auto tensor_names = collect_lora_tensor_names(*adapter);
    if (tensor_names.empty()) {
        throw std::runtime_error("VibeVoice LoRA adapter contains no lora_A/lora_B tensors: " + paths.weights.string());
    }

    std::unordered_map<std::string, LoraTensorDelta> deltas;
    deltas.reserve(tensor_names.size());
    const auto delta_load_started = std::chrono::steady_clock::now();
    for (const auto & [module_path, names] : tensor_names) {
        const std::string base_name = resolve_base_weight_name(*base, module_path);
        deltas.emplace(base_name, load_lora_delta(*base, *adapter, module_path, names, base_name, scale));
    }
    engine::debug::timing_log_scalar("vibevoice.lora.delta_load_ms", engine::debug::elapsed_ms(delta_load_started));

    log_line("applying fine-tune adapter: " + adapter_path.string());
    log_line("LM LoRA: merged " + std::to_string(deltas.size()) + " decoder modules (scale " +
        std::to_string(scale) + ")");

    const auto adapter_dir = resolve_adapter_dir(adapter_path);
    std::unordered_map<std::string, OverrideTensor> overrides;
    if (const auto head = open_diffusion_head_source(adapter_dir)) {
        const auto override_started = std::chrono::steady_clock::now();
        const int count = add_full_overrides(*base, *head, kPredictionHeadPrefix, overrides);
        engine::debug::timing_log_scalar(
            "vibevoice.lora.diffusion_head_override_load_ms",
            engine::debug::elapsed_ms(override_started));
        log_line("diffusion head: overrode " + std::to_string(count) + " tensors");
    } else {
        log_line("diffusion head: not present, skipped");
    }
    const auto acoustic_started = std::chrono::steady_clock::now();
    add_connector_overrides(*base, adapter_dir, "acoustic_connector", kAcousticConnectorPrefix,
        "acoustic connector", overrides);
    engine::debug::timing_log_scalar(
        "vibevoice.lora.acoustic_connector_override_load_ms",
        engine::debug::elapsed_ms(acoustic_started));
    const auto semantic_started = std::chrono::steady_clock::now();
    add_connector_overrides(*base, adapter_dir, "semantic_connector", kSemanticConnectorPrefix,
        "semantic connector", overrides);
    engine::debug::timing_log_scalar(
        "vibevoice.lora.semantic_connector_override_load_ms",
        engine::debug::elapsed_ms(semantic_started));
    engine::debug::timing_log_scalar("vibevoice.lora.prepare_ms", engine::debug::elapsed_ms(prepare_started));
    engine::debug::timing_log_scalar("vibevoice.lora.decoder_delta_tensors", deltas.size());
    engine::debug::timing_log_scalar("vibevoice.lora.full_override_tensors", overrides.size());

    return std::make_shared<VibeVoiceFineTuneSource>(std::move(base), std::move(deltas), std::move(overrides));
}

std::shared_ptr<const VibeVoiceAssets> apply_vibevoice_finetune_options(
    std::shared_ptr<const VibeVoiceAssets> assets,
    const std::unordered_map<std::string, std::string> & options) {
    const auto lora_path = runtime::find_option(options, {"vibevoice.lora"});
    if (!lora_path.has_value() || lora_path->empty()) {
        return assets;
    }
    if (assets == nullptr) {
        throw std::runtime_error("VibeVoice fine-tune requires assets");
    }
    if (assets->fine_tune_applied) {
        throw std::runtime_error(
            "VibeVoice LoRA already applied via --load-option; do not also pass it via --session-option");
    }
    float scale_override = -1.0F;
    if (const auto value = runtime::parse_finite_float_option(options, {"vibevoice.lora_scale"})) {
        if (*value <= 0.0F) {
            throw std::runtime_error("VibeVoice vibevoice.lora_scale must be positive");
        }
        scale_override = *value;
    }
    auto updated = std::make_shared<VibeVoiceAssets>(*assets);
    updated->model_weights = make_vibevoice_finetune_source(assets->model_weights, *lora_path, scale_override);
    updated->fine_tune_applied = true;
    return updated;
}

}  // namespace engine::models::vibevoice
