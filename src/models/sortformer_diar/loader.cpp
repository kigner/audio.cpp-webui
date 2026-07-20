#include "engine/models/sortformer_diar/loader.h"

#include "engine/framework/io/filesystem.h"
#include "engine/framework/io/json.h"
#include "engine/models/sortformer_diar/session.h"

#include <stdexcept>

namespace engine::models::sortformer_diar {

namespace {

std::filesystem::path resolve_model_root(const std::filesystem::path & model_path) {
    if (engine::io::is_existing_directory(model_path)) {
        return std::filesystem::weakly_canonical(model_path);
    }
    throw std::runtime_error("Sortformer diar expects a model directory: " + model_path.string());
}

bool looks_like_sortformer_model(const std::filesystem::path & root) {
    if (!engine::io::is_existing_file(root / "config.json") ||
        !engine::io::is_existing_file(root / "processor_config.json") ||
        !engine::io::is_existing_file(root / "model.safetensors")) {
        return false;
    }
    const auto config = engine::io::json::parse_file(root / "config.json");
    if (config.find("model_type") == nullptr || config.require("model_type").as_string() != "sortformer") {
        return false;
    }
    if (config.find("architectures") == nullptr || config.require("architectures").as_array().empty()) {
        return false;
    }
    return config.require("architectures").as_array().front().as_string() == "SortformerOffline";
}

std::vector<runtime::NamedAsset> discover_config_assets(const runtime::ModelLoadRequest & request) {
    return runtime::discover_named_assets(
        resolve_model_root(request.model_path),
        {"config.json", "processor_config.json"});
}

std::vector<runtime::NamedAsset> discover_weight_assets(const runtime::ModelLoadRequest & request) {
    return runtime::discover_named_assets(resolve_model_root(request.model_path), {"model.safetensors"});
}

class SortformerDiarLoader final : public runtime::IVoiceModelLoader {
public:
    std::string family() const override {
        return "sortformer_diar";
    }

    runtime::CapabilitySet advertised_capabilities() const override {
        runtime::CapabilitySet out;
        out.supported_tasks = {
            {runtime::VoiceTaskKind::Diarization, {runtime::RunMode::Offline}},
        };
        out.supports_timestamps = true;
        return out;
    }

    bool can_load(const runtime::ModelLoadRequest & request) const override {
        try {
            const auto root = resolve_model_root(request.model_path);
            return looks_like_sortformer_model(root) &&
                (!request.family_hint.has_value() || *request.family_hint == family());
        } catch (...) {
            return false;
        }
    }

    runtime::ModelInspection inspect(const runtime::ModelLoadRequest & request) const override {
        const auto root = resolve_model_root(request.model_path);
        runtime::ModelInspection inspection;
        inspection.model_root = root;
        inspection.metadata.family = family();
        inspection.metadata.variant = root.filename().string();
        inspection.metadata.description = "Sortformer offline diarization model loaded from local HF-style assets.";
        inspection.metadata.config_candidates = {"config.json", "processor_config.json"};
        inspection.metadata.weight_candidates = {"model.safetensors"};
        inspection.capabilities.supported_tasks = {
            {runtime::VoiceTaskKind::Diarization, {runtime::RunMode::Offline}},
        };
        inspection.capabilities.supports_timestamps = true;
        inspection.discovered_configs = discover_config_assets(request);
        inspection.discovered_weights = discover_weight_assets(request);
        return inspection;
    }

    std::unique_ptr<runtime::ILoadedVoiceModel> load(const runtime::ModelLoadRequest & request) const override {
        return load_sortformer_diar_model(resolve_model_root(request.model_path));
    }
};

}  // namespace

SortformerDiarLoadedModel::SortformerDiarLoadedModel(
    runtime::ModelMetadata metadata,
    runtime::CapabilitySet capabilities,
    std::shared_ptr<const SortformerAssets> assets)
    : metadata_(std::move(metadata)),
      capabilities_(std::move(capabilities)),
      assets_(std::move(assets)) {}

const runtime::ModelMetadata & SortformerDiarLoadedModel::metadata() const noexcept {
    return metadata_;
}

const runtime::CapabilitySet & SortformerDiarLoadedModel::capabilities() const noexcept {
    return capabilities_;
}

std::unique_ptr<runtime::IVoiceTaskSession> SortformerDiarLoadedModel::create_task_session(
    const runtime::TaskSpec & task,
    const runtime::SessionOptions & options) const {
    if (task.task != runtime::VoiceTaskKind::Diarization) {
        throw std::runtime_error("Sortformer diar only supports VoiceTaskKind::Diarization");
    }
    if (task.mode != runtime::RunMode::Offline) {
        throw std::runtime_error("Sortformer diar only supports offline sessions");
    }
    return std::make_unique<SortformerDiarSession>(task, options, assets_);
}

std::unique_ptr<SortformerDiarLoadedModel> load_sortformer_diar_model(const std::filesystem::path & model_path) {
    const auto root = resolve_model_root(model_path);
    if (!looks_like_sortformer_model(root)) {
        throw std::runtime_error("Sortformer diar model assets not recognized: " + root.string());
    }

    auto assets = load_sortformer_assets(root);

    runtime::ModelMetadata metadata;
    metadata.family = "sortformer_diar";
    metadata.variant = root.filename().string();
    metadata.description = "Sortformer offline diarization model loaded from local HF-style assets.";
    metadata.config_candidates = {"config.json", "processor_config.json"};
    metadata.weight_candidates = {"model.safetensors"};

    runtime::CapabilitySet capabilities;
    capabilities.supported_tasks = {
        {runtime::VoiceTaskKind::Diarization, {runtime::RunMode::Offline}},
    };
    capabilities.supports_timestamps = true;

    return std::make_unique<SortformerDiarLoadedModel>(std::move(metadata), std::move(capabilities), std::move(assets));
}

std::shared_ptr<runtime::IVoiceModelLoader> make_sortformer_diar_loader() {
    return std::make_shared<SortformerDiarLoader>();
}

}  // namespace engine::models::sortformer_diar
