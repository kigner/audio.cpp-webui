#include "engine/models/qwen3_asr/loader.h"

#include "engine/framework/assets/model_package.h"
#include "engine/models/qwen3_asr/session.h"

#include <algorithm>
#include <stdexcept>
#include <utility>

namespace engine::models::qwen3_asr {
namespace {

std::filesystem::path spec_path() {
    return engine::assets::default_model_package_spec_path("qwen3_asr");
}

runtime::ModelMetadata qwen3_asr_metadata(const Qwen3ASRAssets & assets) {
    runtime::ModelMetadata metadata;
    metadata.family = "qwen3_asr";
    metadata.variant = assets.config.model_size.empty() ? assets.config.model_type : assets.config.model_size;
    metadata.description = "Qwen3 ASR loaded from local assets.";
    return metadata;
}

runtime::CapabilitySet qwen3_asr_capabilities(const Qwen3ASRAssets & assets) {
    runtime::CapabilitySet capabilities;
    capabilities.supported_tasks = {
        {runtime::VoiceTaskKind::Asr, {runtime::RunMode::Offline}},
    };
    capabilities.languages = assets.config.supported_languages;
    capabilities.supports_timestamps = false;
    return capabilities;
}

class Qwen3ASRLoader final : public runtime::IVoiceModelLoader {
public:
    std::string family() const override {
        return "qwen3_asr";
    }

    bool can_load(const runtime::ModelLoadRequest & request) const override {
        try {
            (void) engine::assets::load_resource_bundle_from_package_spec(request.model_path, spec_path());
            return !request.family_hint.has_value() || *request.family_hint == family();
        } catch (...) {
            return false;
        }
    }

    runtime::ModelInspection inspect(const runtime::ModelLoadRequest & request) const override {
        const auto assets = load_qwen3_asr_assets(request.model_path);
        runtime::ModelInspection inspection;
        inspection.model_root = assets->resources.model_root();
        inspection.metadata = qwen3_asr_metadata(*assets);
        inspection.capabilities = qwen3_asr_capabilities(*assets);
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
        return load_qwen3_asr_model(request.model_path);
    }
};

}  // namespace

Qwen3ASRLoadedModel::Qwen3ASRLoadedModel(
    runtime::ModelMetadata metadata,
    runtime::CapabilitySet capabilities,
    std::shared_ptr<const Qwen3ASRAssets> assets)
    : metadata_(std::move(metadata)),
      capabilities_(std::move(capabilities)),
      assets_(std::move(assets)) {}

const runtime::ModelMetadata & Qwen3ASRLoadedModel::metadata() const noexcept {
    return metadata_;
}

const runtime::CapabilitySet & Qwen3ASRLoadedModel::capabilities() const noexcept {
    return capabilities_;
}

std::unique_ptr<runtime::IVoiceTaskSession> Qwen3ASRLoadedModel::create_task_session(
    const runtime::TaskSpec & task,
    const runtime::SessionOptions & options) const {
    if (task.task != runtime::VoiceTaskKind::Asr) {
        throw std::runtime_error("Qwen3 ASR only supports the Asr task");
    }
    if (task.mode != runtime::RunMode::Offline) {
        throw std::runtime_error("Qwen3 ASR currently supports offline sessions");
    }
    return std::make_unique<Qwen3ASRSession>(task, options, assets_);
}

std::unique_ptr<Qwen3ASRLoadedModel> load_qwen3_asr_model(const std::filesystem::path & model_path) {
    auto assets = load_qwen3_asr_assets(model_path);
    return std::make_unique<Qwen3ASRLoadedModel>(
        qwen3_asr_metadata(*assets),
        qwen3_asr_capabilities(*assets),
        std::move(assets));
}

std::shared_ptr<runtime::IVoiceModelLoader> make_qwen3_asr_loader() {
    return std::make_shared<Qwen3ASRLoader>();
}

}  // namespace engine::models::qwen3_asr
