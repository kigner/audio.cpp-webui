#include "engine/models/pocket_tts/loader.h"

#include "engine/framework/io/filesystem.h"
#include "engine/framework/runtime/options.h"
#include "engine/models/pocket_tts/assets.h"
#include "engine/models/pocket_tts/session.h"

#include <filesystem>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>

namespace engine::models::pocket_tts {
namespace {

std::filesystem::path resolve_model_root(const std::filesystem::path & model_path) {
    if (engine::io::is_existing_directory(model_path)) {
        return std::filesystem::weakly_canonical(model_path);
    }
    if (engine::io::is_existing_file(model_path)) {
        return std::filesystem::weakly_canonical(model_path.parent_path());
    }
    throw std::runtime_error("PocketTTS model path does not exist: " + model_path.string());
}

bool has_language_assets(const std::filesystem::path & dir) {
    return engine::io::is_existing_file(dir / "model.safetensors")
        && engine::io::is_existing_file(dir / "tokenizer.model");
}

std::vector<std::string> discover_languages(const std::filesystem::path & root) {
    std::vector<std::string> languages;
    if (has_language_assets(root)) {
        languages.push_back(root.filename().string());
        return languages;
    }
    const auto languages_root = root / "languages";
    if (!engine::io::is_existing_directory(languages_root)) {
        return languages;
    }
    for (const auto & entry : std::filesystem::directory_iterator(languages_root)) {
        if (!entry.is_directory()) {
            continue;
        }
        if (has_language_assets(entry.path())) {
            languages.push_back(entry.path().filename().string());
        }
    }
    return languages;
}

std::filesystem::path select_model_root_for_discovery(const runtime::ModelLoadRequest & request) {
    const auto root = resolve_model_root(request.model_path);
    if (has_language_assets(root)) {
        return root;
    }
    if (const auto language = runtime::find_option(request.options, {"language"})) {
        const auto candidate = root / "languages" / *language;
        if (has_language_assets(candidate)) {
            return candidate;
        }
    }
    return root;
}

std::filesystem::path resolve_model_assets_root(const ModelConfig & config, std::string & language) {
    if (config.model_dir.empty()) {
        throw std::runtime_error("PocketTTS model_dir is required");
    }
    const auto root = resolve_model_root(config.model_dir);
    if (has_language_assets(root)) {
        language = !config.language.empty() ? config.language : root.filename().string();
        return root;
    }
    const std::string desired_language = !config.language.empty() ? config.language : "english";
    const auto candidate = root / "languages" / desired_language;
    if (has_language_assets(candidate)) {
        language = desired_language;
        return candidate;
    }
    throw std::runtime_error(
        "PocketTTS model_dir must point to a language folder containing model.safetensors and tokenizer.model, "
        "or to a root containing languages/<language>");
}

std::vector<runtime::NamedAsset> discover_config_assets(const runtime::ModelLoadRequest & request) {
    return runtime::discover_named_assets(select_model_root_for_discovery(request), {"config.yaml", "config.yml"});
}

std::vector<runtime::NamedAsset> discover_weight_assets(const runtime::ModelLoadRequest & request) {
    return runtime::discover_named_assets(select_model_root_for_discovery(request), {"model.safetensors"});
}

ModelConfig build_model_config(const runtime::ModelLoadRequest & request) {
    ModelConfig config;
    config.model_dir = request.model_path;
    if (const auto language = runtime::find_option(request.options, {"language"})) {
        config.language = *language;
    }
    if (const auto explicit_config_path = runtime::find_option(
            request.options,
            {"pocket_tts.config_path", "config_path"})) {
        config.config_path = *explicit_config_path;
    }
    const auto config_assets = discover_config_assets(request);
    if (const auto * asset = runtime::select_named_asset(config_assets, request.config_id, "config")) {
        config.config_path = asset->path;
    }
    const auto weight_assets = discover_weight_assets(request);
    if (const auto * asset = runtime::select_named_asset(weight_assets, request.weight_id, "weight")) {
        if (asset->path.filename() == "model.safetensors") {
            config.model_dir = asset->path;
        }
    }
    return config;
}

class PocketTTSLoader final : public runtime::IVoiceModelLoader {
public:
    std::string family() const override {
        return "pocket_tts";
    }

    bool can_load(const runtime::ModelLoadRequest & request) const override {
        if (request.family_hint.has_value() && *request.family_hint != family()) {
            return false;
        }
        try {
            const auto root = resolve_model_root(request.model_path);
            return has_language_assets(root) || !discover_languages(root).empty();
        } catch (...) {
            return false;
        }
    }

    runtime::ModelInspection inspect(const runtime::ModelLoadRequest & request) const override {
        const auto root = resolve_model_root(request.model_path);
        runtime::ModelInspection inspection;
        inspection.metadata.family = family();
        inspection.metadata.variant = select_model_root_for_discovery(request).filename().string();
        inspection.metadata.description = "Pocket TTS loaded from local extracted assets.";
        inspection.metadata.config_candidates = {"config.yaml", "config.yml"};
        inspection.metadata.weight_candidates = {"model.safetensors"};
        inspection.capabilities.supported_tasks = {
            {runtime::VoiceTaskKind::Tts, {runtime::RunMode::Offline}},
        };
        inspection.capabilities.languages = discover_languages(root);
        inspection.capabilities.supports_speaker_reference = true;
        inspection.capabilities.supports_style_condition = false;
        inspection.cli.session_options = {
            {
                "pocket_tts.voice_state_cache_slots",
                "n",
                "Prepared voice-state cache slots; default 4, set 0 to disable.",
            },
        };
        inspection.model_root = root;
        inspection.discovered_configs = discover_config_assets(request);
        inspection.discovered_weights = discover_weight_assets(request);
        return inspection;
    }

    std::unique_ptr<runtime::ILoadedVoiceModel> load(const runtime::ModelLoadRequest & request) const override {
        return load_pocket_tts_model(request);
    }
};

}  // namespace

PocketTTSModel::PocketTTSModel(
    std::filesystem::path model_dir,
    std::shared_ptr<const PocketTTSAssets> manifest)
    : model_dir_(std::move(model_dir)),
      manifest_(std::move(manifest)) {}

PocketTTSModel PocketTTSModel::load(const ModelConfig & config) {
    if (config.model_dir.empty()) {
        throw std::runtime_error("PocketTTS model_dir is required");
    }
    std::string language;
    const auto model_root = resolve_model_assets_root(config, language);
    const std::optional<std::filesystem::path> config_path =
        config.config_path.empty() ? std::nullopt : std::optional<std::filesystem::path>(config.config_path);
    auto manifest = std::make_shared<PocketTTSAssets>(load_pocket_tts_assets(model_root, language, config_path));
    return PocketTTSModel(model_root, std::move(manifest));
}

std::unique_ptr<runtime::IVoiceTaskSession> PocketTTSModel::create_task_session(
    const runtime::TaskSpec & task,
    const runtime::SessionOptions & options) const {
    if (!manifest_) {
        throw std::runtime_error("PocketTTS model is not loaded");
    }
    return std::make_unique<PocketTTSSession>(task, options, manifest_, model_dir_);
}

const std::filesystem::path & PocketTTSModel::model_dir() const noexcept {
    return model_dir_;
}

PocketTTSLoadedModel::PocketTTSLoadedModel(
    runtime::ModelMetadata metadata,
    runtime::CapabilitySet capabilities,
    PocketTTSModel model)
    : metadata_(std::move(metadata)),
      capabilities_(std::move(capabilities)),
      model_(std::move(model)) {}

const runtime::ModelMetadata & PocketTTSLoadedModel::metadata() const noexcept {
    return metadata_;
}

const runtime::CapabilitySet & PocketTTSLoadedModel::capabilities() const noexcept {
    return capabilities_;
}

std::unique_ptr<runtime::IVoiceTaskSession> PocketTTSLoadedModel::create_task_session(
    const runtime::TaskSpec & task,
    const runtime::SessionOptions & options) const {
    return model_.create_task_session(task, options);
}

std::unique_ptr<PocketTTSLoadedModel> load_pocket_tts_model(const runtime::ModelLoadRequest & request) {
    PocketTTSModel model = PocketTTSModel::load(build_model_config(request));

    runtime::ModelMetadata metadata;
    metadata.family = "pocket_tts";
    metadata.variant = model.model_dir().filename().string();
    metadata.description = "Pocket TTS loaded from local extracted assets.";
    metadata.config_candidates = {"config.yaml", "config.yml"};
    metadata.weight_candidates = {"model.safetensors"};

    runtime::CapabilitySet capabilities;
    capabilities.supported_tasks = {
        {runtime::VoiceTaskKind::Tts, {runtime::RunMode::Offline}},
    };
    capabilities.languages = discover_languages(resolve_model_root(request.model_path));
    capabilities.supports_speaker_reference = true;
    capabilities.supports_style_condition = false;

    return std::make_unique<PocketTTSLoadedModel>(std::move(metadata), std::move(capabilities), std::move(model));
}

std::shared_ptr<runtime::IVoiceModelLoader> make_pocket_tts_loader() {
    return std::make_shared<PocketTTSLoader>();
}

}  // namespace engine::models::pocket_tts
