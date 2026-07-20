#include "engine/models/ace_step/loader.h"

#include "engine/framework/io/filesystem.h"
#include "engine/models/ace_step/session.h"

#include <stdexcept>
#include <string>
#include <utility>

namespace engine::models::ace_step {
namespace {

std::filesystem::path resolve_model_root(const std::filesystem::path & model_path) {
    if (engine::io::is_existing_directory(model_path)) {
        return std::filesystem::weakly_canonical(model_path);
    }
    if (engine::io::is_existing_file(model_path)) {
        return std::filesystem::weakly_canonical(model_path.parent_path());
    }
    throw std::runtime_error("ACE-Step model path does not exist: " + model_path.string());
}

AceStepModelSelection selection_from_request(const runtime::ModelLoadRequest & request) {
    AceStepModelSelection selection;
    if (const auto it = request.options.find("ace_step.dit_model_path"); it != request.options.end()) {
        selection.dit_model_path = it->second;
    }
    if (const auto it = request.options.find("ace_step.lm_model_path"); it != request.options.end()) {
        selection.lm_model_path = it->second;
    }
    if (const auto it = request.options.find("ace_step.text_encoder_path"); it != request.options.end()) {
        selection.text_encoder_path = it->second;
    }
    if (const auto it = request.options.find("ace_step.vae_model_path"); it != request.options.end()) {
        selection.vae_model_path = it->second;
    }
    return selection;
}

bool has_ace_step_assets(const std::filesystem::path & root, const AceStepModelSelection & selection) {
    return engine::io::is_existing_file(root / selection.dit_model_path / "config.json")
        && engine::io::is_existing_file(root / selection.dit_model_path / "model.safetensors")
        && engine::io::is_existing_file(root / selection.dit_model_path / "silence_latent.safetensors")
        && engine::io::is_existing_file(root / selection.lm_model_path / "config.json")
        && engine::io::is_existing_file(root / selection.lm_model_path / "model.safetensors")
        && engine::io::is_existing_file(root / selection.lm_model_path / "tokenizer_config.json")
        && engine::io::is_existing_file(root / selection.lm_model_path / "vocab.json")
        && engine::io::is_existing_file(root / selection.lm_model_path / "merges.txt")
        && engine::io::is_existing_file(root / selection.text_encoder_path / "config.json")
        && engine::io::is_existing_file(root / selection.text_encoder_path / "model.safetensors")
        && engine::io::is_existing_file(root / selection.text_encoder_path / "tokenizer_config.json")
        && engine::io::is_existing_file(root / selection.text_encoder_path / "vocab.json")
        && engine::io::is_existing_file(root / selection.text_encoder_path / "merges.txt")
        && engine::io::is_existing_file(root / selection.vae_model_path / "config.json")
        && engine::io::is_existing_file(root / selection.vae_model_path / "diffusion_pytorch_model.safetensors");
}

std::vector<runtime::NamedAsset> discover_config_assets(const runtime::ModelLoadRequest & request) {
    const auto root = resolve_model_root(request.model_path);
    const auto selection = selection_from_request(request);
    return runtime::discover_named_assets(
        root,
        {
            selection.dit_model_path + "/config.json",
            selection.lm_model_path + "/config.json",
            selection.lm_model_path + "/tokenizer_config.json",
            selection.text_encoder_path + "/config.json",
            selection.text_encoder_path + "/tokenizer_config.json",
            selection.vae_model_path + "/config.json",
        });
}

std::vector<runtime::NamedAsset> discover_weight_assets(const runtime::ModelLoadRequest & request) {
    const auto root = resolve_model_root(request.model_path);
    const auto selection = selection_from_request(request);
    return runtime::discover_named_assets(
        root,
        {
            selection.dit_model_path + "/model.safetensors",
            selection.dit_model_path + "/silence_latent.safetensors",
            selection.lm_model_path + "/model.safetensors",
            selection.text_encoder_path + "/model.safetensors",
            selection.vae_model_path + "/diffusion_pytorch_model.safetensors",
        });
}

class AceStepLoader final : public runtime::IVoiceModelLoader {
public:
    std::string family() const override {
        return "ace_step";
    }

    runtime::CapabilitySet advertised_capabilities() const override {
        runtime::CapabilitySet out;
        out.supported_tasks = {
            {runtime::VoiceTaskKind::AudioGeneration, {runtime::RunMode::Offline}},
        };
        return out;
    }

    bool can_load(const runtime::ModelLoadRequest & request) const override {
        try {
            const auto root = resolve_model_root(request.model_path);
            return has_ace_step_assets(root, selection_from_request(request))
                && (!request.family_hint.has_value() || *request.family_hint == family());
        } catch (...) {
            return false;
        }
    }

    runtime::ModelInspection inspect(const runtime::ModelLoadRequest & request) const override {
        const auto assets = load_ace_step_assets(resolve_model_root(request.model_path), selection_from_request(request));
        runtime::ModelInspection inspection;
        inspection.model_root = assets->paths.model_root;
        inspection.metadata.family = family();
        inspection.metadata.variant = assets->config.diffusion.model_version;
        inspection.metadata.description = "ACE-Step loaded from local extracted assets.";
        inspection.metadata.config_candidates = {
            assets->selection.dit_model_path + "/config.json",
            assets->selection.lm_model_path + "/config.json",
            assets->selection.lm_model_path + "/tokenizer_config.json",
            assets->selection.text_encoder_path + "/config.json",
            assets->selection.text_encoder_path + "/tokenizer_config.json",
            assets->selection.vae_model_path + "/config.json",
        };
        inspection.metadata.weight_candidates = {
            assets->selection.dit_model_path + "/model.safetensors",
            assets->selection.dit_model_path + "/silence_latent.safetensors",
            assets->selection.lm_model_path + "/model.safetensors",
            assets->selection.text_encoder_path + "/model.safetensors",
            assets->selection.vae_model_path + "/diffusion_pytorch_model.safetensors",
        };
        inspection.capabilities.supported_tasks = {
            {runtime::VoiceTaskKind::AudioGeneration, {runtime::RunMode::Offline}},
        };
        inspection.cli.request_options = {
            {"route", "text2music|complete|lego|extract|cover|cover-nofsq|repaint", "ACE-Step operation; also exposed as --task-route."},
            {"lyrics", "text", "Vocal lyrics."},
            {"duration_seconds", "seconds", "Target duration; also exposed as --duration-seconds."},
            {"language", "code", "Vocal language for lyrics; also exposed as --language."},
            {"track_name", "text", "Track name used by lego and extract routes; also exposed as --track-name."},
            {"complete_track_classes", "a,b", "Track classes for complete route."},
            {"repainting_start", "seconds", "Start time for repaint route; also exposed as --repaint-start."},
            {"repainting_end", "seconds", "End time for repaint route; also exposed as --repaint-end."},
            {"repaint_mode", "balanced|conservative|aggressive", "Preset repaint blending policy; also exposed as --repaint-mode."},
            {"repaint_strength", "0..1", "Repaint strength; also exposed as --repaint-strength."},
            {"num_inference_steps", "n", "Diffusion denoising steps; also exposed as --num-inference-steps."},
            {"guidance_scale", "float", "Diffusion guidance scale; also exposed as --guidance-scale."},
            {"seed", "n", "Generation seed; also exposed as --seed."},
            {"bpm", "n", "Force BPM metadata."},
            {"keyscale", "text", "Force key metadata."},
            {"timesignature", "text", "Force time signature metadata."},
            {"negative_prompt", "text", "Negative prompt."},
            {"audio_codes", "text", "Use supplied ACE semantic code text instead of planner generation."},
            {"audio_cover_strength", "float", "Cover strength for cover/edit-style conditioning."},
            {"cover_noise_strength", "float", "Noise strength for cover conditioning."},
            {"lm_temperature", "float", "Planner sampling temperature."},
            {"lm_cfg_scale", "float", "Planner CFG scale."},
            {"lm_top_k", "n", "Planner top-k; 0 disables top-k."},
            {"lm_top_p", "float", "Planner top-p."},
            {"lm_repetition_penalty", "float", "Planner repetition penalty."},
            {"sampler_mode", "euler|heun", "Diffusion sampler mode."},
            {"retake_seed", "n", "Optional retake noise seed; -1 clears it."},
            {"retake_variance", "float", "Retake noise mixing strength."},
            {"flow_edit_morph", "bool", "Status: parsed for text2music, but not usable because the flow-edit diffusion overlay is not implemented."},
            {"dcw_enabled", "bool", "Status: experimental dynamic-cfg wavelet path; keep disabled unless validating that path."},
        };
        inspection.cli.session_options = {
            {"ace_step.weight_type", "native|f32|f16|bf16|q8_0", "Shared ACE-Step weight storage type."},
            {"ace_step.dit_weight_type", "native|f32|f16|bf16|q8_0", "DiT weight storage type; f16 is promoted to bf16."},
            {"ace_step.planner_weight_type", "native|f32|f16|bf16|q8_0", "Planner LM weight storage type."},
            {"ace_step.text_encoder_weight_type", "native|f32|f16|bf16|q8_0", "Text encoder weight storage type."},
            {"ace_step.vae_weight_type", "native|f32|f16|bf16|q8_0", "VAE weight storage type."},
            {"ace_step.mem_saver", "true|false", "Release staged runtime graphs after each request; default false."},
        };
        inspection.cli.load_options = {
            {"ace_step.dit_model_path", "dir", "DiT subdirectory inside the model root."},
            {"ace_step.lm_model_path", "dir", "Planner LM subdirectory inside the model root."},
            {"ace_step.text_encoder_path", "dir", "Text encoder subdirectory inside the model root."},
            {"ace_step.vae_model_path", "dir", "VAE subdirectory inside the model root."},
        };
        inspection.discovered_configs = discover_config_assets(request);
        inspection.discovered_weights = discover_weight_assets(request);
        return inspection;
    }

    std::unique_ptr<runtime::ILoadedVoiceModel> load(const runtime::ModelLoadRequest & request) const override {
        return load_ace_step_model(resolve_model_root(request.model_path), selection_from_request(request));
    }
};

}  // namespace

AceStepLoadedModel::AceStepLoadedModel(
    runtime::ModelMetadata metadata,
    runtime::CapabilitySet capabilities,
    std::shared_ptr<const AceStepAssets> assets)
    : metadata_(std::move(metadata)),
      capabilities_(std::move(capabilities)),
      assets_(std::move(assets)) {}

const runtime::ModelMetadata & AceStepLoadedModel::metadata() const noexcept {
    return metadata_;
}

const runtime::CapabilitySet & AceStepLoadedModel::capabilities() const noexcept {
    return capabilities_;
}

std::unique_ptr<runtime::IVoiceTaskSession> AceStepLoadedModel::create_task_session(
    const runtime::TaskSpec & task,
    const runtime::SessionOptions & options) const {
    if (task.task != runtime::VoiceTaskKind::AudioGeneration) {
        throw std::runtime_error("ACE-Step supports only the gen task");
    }
    if (task.mode != runtime::RunMode::Offline) {
        throw std::runtime_error("ACE-Step supports only offline mode");
    }
    return std::make_unique<AceStepSession>(task, options, assets_);
}

std::unique_ptr<AceStepLoadedModel> load_ace_step_model(
    const std::filesystem::path & model_path,
    const AceStepModelSelection & selection) {
    auto assets = load_ace_step_assets(model_path, selection);

    runtime::ModelMetadata metadata;
    metadata.family = "ace_step";
    metadata.variant = assets->selection.dit_model_path;
    metadata.description = "ACE-Step loaded from local extracted assets.";
    metadata.config_candidates = {
        assets->selection.dit_model_path + "/config.json",
        assets->selection.lm_model_path + "/config.json",
        assets->selection.lm_model_path + "/tokenizer_config.json",
        assets->selection.text_encoder_path + "/config.json",
        assets->selection.text_encoder_path + "/tokenizer_config.json",
        assets->selection.vae_model_path + "/config.json",
    };
    metadata.weight_candidates = {
        assets->selection.dit_model_path + "/model.safetensors",
        assets->selection.dit_model_path + "/silence_latent.safetensors",
        assets->selection.lm_model_path + "/model.safetensors",
        assets->selection.text_encoder_path + "/model.safetensors",
        assets->selection.vae_model_path + "/diffusion_pytorch_model.safetensors",
    };

    runtime::CapabilitySet capabilities;
    capabilities.supported_tasks = {
        {runtime::VoiceTaskKind::AudioGeneration, {runtime::RunMode::Offline}},
    };

    return std::make_unique<AceStepLoadedModel>(std::move(metadata), std::move(capabilities), std::move(assets));
}

std::shared_ptr<runtime::IVoiceModelLoader> make_ace_step_loader() {
    return std::make_shared<AceStepLoader>();
}

}  // namespace engine::models::ace_step
