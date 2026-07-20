#include "engine/models/heartmula/loader.h"

#include "engine/framework/io/filesystem.h"
#include "engine/models/heartmula/session.h"

#include <stdexcept>
#include <utility>

namespace engine::models::heartmula {
namespace {

std::filesystem::path resolve_model_root(const std::filesystem::path & model_path) {
    if (engine::io::is_existing_directory(model_path)) {
        return std::filesystem::weakly_canonical(model_path);
    }
    if (engine::io::is_existing_file(model_path)) {
        return std::filesystem::weakly_canonical(model_path.parent_path());
    }
    throw std::runtime_error("HeartMuLa model path does not exist: " + model_path.string());
}

bool has_heartmula_assets(const std::filesystem::path & root) {
    return engine::io::is_existing_file(root / "tokenizer.json") &&
        engine::io::is_existing_file(root / "gen_config.json") &&
        engine::io::is_existing_file(root / "HeartMuLa-oss-3B" / "config.json") &&
        engine::io::is_existing_file(root / "HeartMuLa-oss-3B" / "model.safetensors.index.json") &&
        engine::io::is_existing_file(root / "HeartCodec-oss" / "config.json") &&
        engine::io::is_existing_file(root / "HeartCodec-oss" / "model.safetensors.index.json");
}

std::vector<runtime::NamedAsset> discover_config_assets(const runtime::ModelLoadRequest & request) {
    const auto root = resolve_model_root(request.model_path);
    return runtime::discover_named_assets(
        root,
        {
            "tokenizer.json",
            "gen_config.json",
            "HeartMuLa-oss-3B/config.json",
            "HeartCodec-oss/config.json",
        });
}

std::vector<runtime::NamedAsset> discover_weight_assets(const runtime::ModelLoadRequest & request) {
    const auto root = resolve_model_root(request.model_path);
    return runtime::discover_named_assets(
        root,
        {
            "HeartMuLa-oss-3B/model.safetensors.index.json",
            "HeartCodec-oss/model.safetensors.index.json",
        });
}

runtime::CapabilitySet heartmula_capabilities() {
    runtime::CapabilitySet capabilities;
    capabilities.supported_tasks = {
        {runtime::VoiceTaskKind::AudioGeneration, {runtime::RunMode::Offline}},
    };
    capabilities.languages = {"Auto"};
    capabilities.supports_style_condition = true;
    return capabilities;
}

runtime::ModelMetadata heartmula_metadata(const HeartMuLaAssets & assets) {
    runtime::ModelMetadata metadata;
    metadata.family = "heartmula";
    metadata.variant = assets.mula_config.backbone_flavor + "-heartcodec";
    metadata.description = "HeartMuLa text-to-music loaded from local safetensors shards.";
    metadata.config_candidates = {
        "tokenizer.json",
        "gen_config.json",
        "HeartMuLa-oss-3B/config.json",
        "HeartCodec-oss/config.json",
    };
    metadata.weight_candidates = {
        "HeartMuLa-oss-3B/model.safetensors.index.json",
        "HeartCodec-oss/model.safetensors.index.json",
    };
    return metadata;
}

class HeartMuLaLoader final : public runtime::IVoiceModelLoader {
public:
    std::string family() const override {
        return "heartmula";
    }

    runtime::CapabilitySet advertised_capabilities() const override {
        runtime::CapabilitySet out;
        out.supported_tasks = {
            {runtime::VoiceTaskKind::AudioGeneration, {runtime::RunMode::Offline}},
        };
        out.supports_style_condition = true;
        return out;
    }

    bool can_load(const runtime::ModelLoadRequest & request) const override {
        try {
            const auto root = resolve_model_root(request.model_path);
            return has_heartmula_assets(root) &&
                (!request.family_hint.has_value() || *request.family_hint == family());
        } catch (...) {
            return false;
        }
    }

    runtime::ModelInspection inspect(const runtime::ModelLoadRequest & request) const override {
        const auto assets = load_heartmula_assets(resolve_model_root(request.model_path));
        runtime::ModelInspection inspection;
        inspection.model_root = assets->paths.model_root;
        inspection.metadata = heartmula_metadata(*assets);
        inspection.capabilities = heartmula_capabilities();
        inspection.cli.request_options = {
            {"lyrics", "text", "Lyrics text."},
            {"tags", "text", "Comma-separated music tags."},
            {"duration_seconds", "seconds", "Maximum generated audio duration."},
            {"temperature", "float", "Audio token sampling temperature."},
            {"top_k", "n", "Audio token top-k sampling limit."},
            {"guidance_scale", "float", "MuLa classifier-free guidance scale."},
            {"codec_duration", "seconds", "Codec detokenization chunk duration."},
            {"num_inference_steps", "n", "Codec flow solver steps."},
            {"codec_guidance_scale", "float", "Codec classifier-free guidance scale."},
            {"infinite_mode", "bool", "Generate long outputs by splitting lyrics into bounded HeartMuLa requests."},
            {"text_chunk_size", "n", "Text chunk size for infinite mode."},
            {"infinite_chunk_audio_length_ms", "n", "Per-chunk audio cap for infinite mode."},
            {"seed", "n", "Torch RNG seed."},
        };
        inspection.cli.session_options = {
            {"heartmula.weight_type", "native|f32|f16|bf16|q8_0", "MuLa and codec weight storage type."},
            {"heartmula.mula_weight_type", "native|f32|f16|bf16|q8_0", "MuLa weight storage type."},
            {"heartmula.codec_weight_type", "native|f32|f16|bf16|q8_0", "Codec weight storage type."},
            {"heartmula.mula_weight_context_mb", "n", "MuLa weight context size."},
            {"heartmula.codec_weight_context_mb", "n", "Codec weight context size."},
            {"heartmula.mula_constant_context_mb", "n", "MuLa reusable constant context size."},
            {"heartmula.mula_backbone_prefill_graph_arena_mb", "n", "MuLa backbone prefill graph arena size."},
            {"heartmula.mula_backbone_step_graph_arena_mb", "n", "MuLa backbone cached-step graph arena size."},
            {"heartmula.mula_decoder_prefill_graph_arena_mb", "n", "MuLa decoder prefill graph arena size."},
            {"heartmula.mula_decoder_step_graph_arena_mb", "n", "MuLa decoder cached-step graph arena size."},
            {"heartmula.mula_frame_embedding_graph_arena_mb", "n", "MuLa frame-embedding graph arena size."},
            {"heartmula.codec_flow_estimator_graph_arena_mb", "n", "Codec flow-estimator graph arena size."},
            {"heartmula.codec_conditioning_graph_arena_mb", "n", "Codec conditioning graph arena size."},
            {"heartmula.codec_scalar_decoder_graph_arena_mb", "n", "Codec scalar-decoder graph arena size."},
            {"heartmula.mem_saver", "true|false", "Release staged runtime graphs after each request; default false."},
        };
        inspection.discovered_configs = discover_config_assets(request);
        inspection.discovered_weights = discover_weight_assets(request);
        return inspection;
    }

    std::unique_ptr<runtime::ILoadedVoiceModel> load(const runtime::ModelLoadRequest & request) const override {
        return load_heartmula_model(resolve_model_root(request.model_path));
    }
};

}  // namespace

HeartMuLaLoadedModel::HeartMuLaLoadedModel(
    runtime::ModelMetadata metadata,
    runtime::CapabilitySet capabilities,
    std::shared_ptr<const HeartMuLaAssets> assets)
    : metadata_(std::move(metadata)),
      capabilities_(std::move(capabilities)),
      assets_(std::move(assets)) {}

const runtime::ModelMetadata & HeartMuLaLoadedModel::metadata() const noexcept {
    return metadata_;
}

const runtime::CapabilitySet & HeartMuLaLoadedModel::capabilities() const noexcept {
    return capabilities_;
}

std::unique_ptr<runtime::IVoiceTaskSession> HeartMuLaLoadedModel::create_task_session(
    const runtime::TaskSpec & task,
    const runtime::SessionOptions & options) const {
    if (task.mode != runtime::RunMode::Offline) {
        throw std::runtime_error("HeartMuLa only supports offline sessions");
    }
    if (task.task != runtime::VoiceTaskKind::AudioGeneration) {
        throw std::runtime_error("HeartMuLa only supports the gen task");
    }
    return std::make_unique<HeartMuLaSession>(task, options, assets_);
}

std::unique_ptr<HeartMuLaLoadedModel> load_heartmula_model(const std::filesystem::path & model_path) {
    auto assets = load_heartmula_assets(model_path);
    return std::make_unique<HeartMuLaLoadedModel>(
        heartmula_metadata(*assets),
        heartmula_capabilities(),
        std::move(assets));
}

std::shared_ptr<runtime::IVoiceModelLoader> make_heartmula_loader() {
    return std::make_shared<HeartMuLaLoader>();
}

}  // namespace engine::models::heartmula
