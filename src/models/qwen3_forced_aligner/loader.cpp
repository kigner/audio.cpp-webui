#include "engine/models/qwen3_forced_aligner/loader.h"

#include "engine/framework/assets/model_package.h"
#include "engine/models/qwen3_asr/assets.h"
#include "engine/models/qwen3_forced_aligner/session.h"

#include <stdexcept>
#include <utility>

namespace engine::models::qwen3_forced_aligner {
namespace {

std::filesystem::path spec_path() {
    return engine::assets::default_model_package_spec_path("qwen3_forced_aligner");
}

std::shared_ptr<const engine::models::qwen3_asr::Qwen3ASRAssets> load_assets(
    const std::filesystem::path & model_path) {
    auto assets = engine::models::qwen3_asr::load_qwen3_asr_assets(model_path, "qwen3_forced_aligner");
    if (assets->config.thinker_model_type != "qwen3_forced_aligner") {
        throw std::runtime_error("Qwen3 forced aligner loader received non-aligner assets");
    }
    return assets;
}

runtime::ModelMetadata qwen3_forced_aligner_metadata(
    const engine::models::qwen3_asr::Qwen3ASRAssets & assets) {
    runtime::ModelMetadata metadata;
    metadata.family = "qwen3_forced_aligner";
    metadata.variant = assets.config.model_size.empty() ? assets.config.thinker_model_type : assets.config.model_size;
    metadata.description = "Qwen3 forced aligner loaded from local assets.";
    return metadata;
}

runtime::CapabilitySet qwen3_forced_aligner_capabilities(
    const engine::models::qwen3_asr::Qwen3ASRAssets & assets) {
    runtime::CapabilitySet capabilities;
    capabilities.supported_tasks = {
        {runtime::VoiceTaskKind::Alignment, {runtime::RunMode::Offline}},
    };
    capabilities.languages = assets.config.supported_languages;
    capabilities.supports_timestamps = true;
    return capabilities;
}

class Qwen3ForcedAlignerLoader final : public runtime::IVoiceModelLoader {
public:
    std::string family() const override {
        return "qwen3_forced_aligner";
    }

    bool can_load(const runtime::ModelLoadRequest & request) const override {
        try {
            (void) load_assets(request.model_path);
            return !request.family_hint.has_value() || *request.family_hint == family();
        } catch (...) {
            return false;
        }
    }

    runtime::ModelInspection inspect(const runtime::ModelLoadRequest & request) const override {
        const auto assets = load_assets(request.model_path);
        runtime::ModelInspection inspection;
        inspection.model_root = assets->resources.model_root();
        inspection.metadata = qwen3_forced_aligner_metadata(*assets);
        inspection.capabilities = qwen3_forced_aligner_capabilities(*assets);
        inspection.discovered_configs = runtime::discover_named_assets_from_package_spec(
            request.model_path,
            spec_path(),
            engine::assets::ModelPackageResourceKind::Files);
        inspection.discovered_weights = runtime::discover_named_assets_from_package_spec(
            request.model_path,
            spec_path(),
            engine::assets::ModelPackageResourceKind::Tensors);
        return inspection;
    }

    std::unique_ptr<runtime::ILoadedVoiceModel> load(const runtime::ModelLoadRequest & request) const override {
        return load_qwen3_forced_aligner_model(request.model_path);
    }
};

}  // namespace

Qwen3ForcedAlignerLoadedModel::Qwen3ForcedAlignerLoadedModel(
    runtime::ModelMetadata metadata,
    runtime::CapabilitySet capabilities,
    std::shared_ptr<const engine::models::qwen3_asr::Qwen3ASRAssets> assets)
    : metadata_(std::move(metadata)),
      capabilities_(std::move(capabilities)),
      assets_(std::move(assets)) {}

const runtime::ModelMetadata & Qwen3ForcedAlignerLoadedModel::metadata() const noexcept {
    return metadata_;
}

const runtime::CapabilitySet & Qwen3ForcedAlignerLoadedModel::capabilities() const noexcept {
    return capabilities_;
}

std::unique_ptr<runtime::IVoiceTaskSession> Qwen3ForcedAlignerLoadedModel::create_task_session(
    const runtime::TaskSpec & task,
    const runtime::SessionOptions & options) const {
    if (task.task != runtime::VoiceTaskKind::Alignment) {
        throw std::runtime_error("Qwen3 forced aligner only supports the Alignment task");
    }
    if (task.mode != runtime::RunMode::Offline) {
        throw std::runtime_error("Qwen3 forced aligner currently supports offline sessions");
    }
    return std::make_unique<Qwen3ForcedAlignerSession>(task, options, assets_);
}

std::unique_ptr<Qwen3ForcedAlignerLoadedModel> load_qwen3_forced_aligner_model(const std::filesystem::path & model_path) {
    auto assets = load_assets(model_path);
    return std::make_unique<Qwen3ForcedAlignerLoadedModel>(
        qwen3_forced_aligner_metadata(*assets),
        qwen3_forced_aligner_capabilities(*assets),
        std::move(assets));
}

std::shared_ptr<runtime::IVoiceModelLoader> make_qwen3_forced_aligner_loader() {
    return std::make_shared<Qwen3ForcedAlignerLoader>();
}

}  // namespace engine::models::qwen3_forced_aligner
