#include "engine/models/omnivoice/loader.h"

#include "engine/framework/assets/model_package.h"
#include "engine/models/omnivoice/session.h"

#include <stdexcept>
#include <utility>

namespace engine::models::omnivoice {
namespace {

std::filesystem::path spec_path() {
    return engine::assets::default_model_package_spec_path("omnivoice");
}

class OmniVoiceLoader final : public runtime::IVoiceModelLoader {
public:
    std::string family() const override {
        return "omnivoice";
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
        const auto assets = load_omnivoice_assets(request.model_path);
        runtime::ModelInspection inspection;
        inspection.model_root = assets->resources.model_root();
        inspection.metadata.family = family();
        inspection.metadata.variant = assets->config.model_type;
        inspection.metadata.description = "OmniVoice multilingual TTS with voice clone and voice design pipelines.";
        inspection.cli.request_options = {
            {"text_chunk_mode", "default|tag_aware|japanese|endline", "Text chunking mode; default tag_aware."},
        };
        inspection.cli.session_options = {
            {"omnivoice.mem_saver", "true|false", "Release staged runtime graphs after request phases; default false."},
        };
        inspection.capabilities.supported_tasks = {
            {runtime::VoiceTaskKind::Tts, {runtime::RunMode::Offline}},
        };
        inspection.capabilities.supports_speaker_reference = true;
        inspection.capabilities.supports_style_condition = true;
        inspection.capabilities.languages = assets->config.supported_languages;
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
        return load_omnivoice_model(request.model_path);
    }
};

}  // namespace

OmniVoiceLoadedModel::OmniVoiceLoadedModel(
    runtime::ModelMetadata metadata,
    runtime::CapabilitySet capabilities,
    std::shared_ptr<const OmniVoiceAssets> assets)
    : metadata_(std::move(metadata)),
      capabilities_(std::move(capabilities)),
      assets_(std::move(assets)) {}

const runtime::ModelMetadata & OmniVoiceLoadedModel::metadata() const noexcept {
    return metadata_;
}

const runtime::CapabilitySet & OmniVoiceLoadedModel::capabilities() const noexcept {
    return capabilities_;
}

std::unique_ptr<runtime::IVoiceTaskSession> OmniVoiceLoadedModel::create_task_session(
    const runtime::TaskSpec & task,
    const runtime::SessionOptions & options) const {
    return std::make_unique<OmniVoiceSession>(task, options, assets_);
}

std::unique_ptr<OmniVoiceLoadedModel> load_omnivoice_model(const std::filesystem::path & model_path) {
    auto assets = load_omnivoice_assets(model_path);

    runtime::ModelMetadata metadata;
    metadata.family = "omnivoice";
    metadata.variant = assets->config.model_type;
    metadata.description = "OmniVoice multilingual TTS with voice clone and voice design pipelines.";
    runtime::CapabilitySet capabilities;
    capabilities.supported_tasks = {
        {runtime::VoiceTaskKind::Tts, {runtime::RunMode::Offline}},
    };
    capabilities.supports_speaker_reference = true;
    capabilities.supports_style_condition = true;
    capabilities.languages = assets->config.supported_languages;

    return std::make_unique<OmniVoiceLoadedModel>(std::move(metadata), std::move(capabilities), std::move(assets));
}

std::shared_ptr<runtime::IVoiceModelLoader> make_omnivoice_loader() {
    return std::make_shared<OmniVoiceLoader>();
}

}  // namespace engine::models::omnivoice
