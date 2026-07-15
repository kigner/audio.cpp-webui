#include "engine/models/supertonic/loader.h"

#include "engine/framework/assets/model_package.h"
#include "engine/models/supertonic/session.h"

#include <stdexcept>
#include <utility>

namespace engine::models::supertonic {
namespace {

runtime::CapabilitySet supertonic_capabilities() {
    runtime::CapabilitySet capabilities;
    capabilities.supported_tasks = {
        {runtime::VoiceTaskKind::Tts, {runtime::RunMode::Offline, runtime::RunMode::Streaming}},
    };
    capabilities.languages = {
        "en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es", "et", "fi", "fr", "hi", "hr", "hu",
        "id", "it", "lt", "lv", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi", "na",
    };
    capabilities.supports_style_condition = true;
    return capabilities;
}

runtime::ModelMetadata supertonic_metadata() {
    runtime::ModelMetadata metadata;
    metadata.family = "supertonic";
    metadata.variant = "supertonic-3";
    metadata.description = "Supertonic 3 loaded from GGML safetensors assets.";
    return metadata;
}

runtime::ModelCliInterface supertonic_cli() {
    runtime::ModelCliInterface cli;
    cli.request_options = {
        {"voice_id", "M1|M2|M3|M4|M5|F1|F2|F3|F4|F5", "Preset voice style id, default M1; also exposed as --voice-id."},
        {"num_inference_steps", "n", "Flow denoising steps, default 8."},
        {"speaking_rate", "float", "Speech speed multiplier, default 1.05."},
        {"seed", "n", "Noise seed, default 1234."},
        {"text_chunk_mode", "default|tag_aware|japanese|endline", "Long-form text chunking mode."},
    };
    cli.session_options = {
        {"supertonic.weight_type", "native|f32|f16|bf16|q8_0", "Supertonic weight storage type."},
        {"supertonic.style_cache_slots", "n", "Preset voice style cache slots; default 4."},
    };
    return cli;
}

class SupertonicLoader final : public runtime::IVoiceModelLoader {
public:
    std::string family() const override { return "supertonic"; }

    bool can_load(const runtime::ModelLoadRequest & request) const override {
        try {
            (void) engine::assets::load_resource_bundle_from_package_spec(
                request.model_path,
                engine::assets::default_model_package_spec_path(family()));
            return !request.family_hint.has_value() || *request.family_hint == family();
        } catch (...) {
            return false;
        }
    }

    runtime::ModelInspection inspect(const runtime::ModelLoadRequest & request) const override {
        const auto assets = load_supertonic_assets(request.model_path);
        runtime::ModelInspection inspection;
        inspection.model_root = assets->resources.model_root();
        inspection.metadata = supertonic_metadata();
        inspection.capabilities = supertonic_capabilities();
        inspection.cli = supertonic_cli();
        const auto spec_path = engine::assets::default_model_package_spec_path(family());
        inspection.discovered_configs = runtime::discover_named_assets_from_package_spec(
            request.model_path,
            spec_path,
            engine::assets::ModelPackageResourceKind::Files);
        inspection.discovered_weights = runtime::discover_named_assets_from_package_spec(
            request.model_path,
            spec_path,
            engine::assets::ModelPackageResourceKind::Tensors);
        return inspection;
    }

    std::unique_ptr<runtime::ILoadedVoiceModel> load(const runtime::ModelLoadRequest & request) const override {
        return load_supertonic_model(request.model_path);
    }
};

}  // namespace

SupertonicLoadedModel::SupertonicLoadedModel(
    runtime::ModelMetadata metadata,
    runtime::CapabilitySet capabilities,
    std::shared_ptr<const SupertonicAssets> assets)
    : metadata_(std::move(metadata)),
      capabilities_(std::move(capabilities)),
      assets_(std::move(assets)) {}

const runtime::ModelMetadata & SupertonicLoadedModel::metadata() const noexcept {
    return metadata_;
}

const runtime::CapabilitySet & SupertonicLoadedModel::capabilities() const noexcept {
    return capabilities_;
}

std::unique_ptr<runtime::IVoiceTaskSession> SupertonicLoadedModel::create_task_session(
    const runtime::TaskSpec & task,
    const runtime::SessionOptions & options) const {
    if (task.mode != runtime::RunMode::Offline && task.mode != runtime::RunMode::Streaming) {
        throw std::runtime_error("Supertonic only supports offline and streaming sessions");
    }
    if (task.task != runtime::VoiceTaskKind::Tts) {
        throw std::runtime_error("Supertonic only supports the Tts task");
    }
    return std::make_unique<SupertonicSession>(task, options, assets_);
}

std::unique_ptr<SupertonicLoadedModel> load_supertonic_model(const std::filesystem::path & model_path) {
    auto assets = load_supertonic_assets(model_path);
    return std::make_unique<SupertonicLoadedModel>(
        supertonic_metadata(),
        supertonic_capabilities(),
        std::move(assets));
}

std::shared_ptr<runtime::IVoiceModelLoader> make_supertonic_loader() {
    return std::make_shared<SupertonicLoader>();
}

}  // namespace engine::models::supertonic
