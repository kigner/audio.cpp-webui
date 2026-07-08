#pragma once

#include "engine/framework/assets/tensor_source.h"
#include "engine/framework/runtime/session_base.h"
#include "engine/models/qwen3_asr/assets.h"
#include "engine/models/qwen3_asr/audio_encoder.h"
#include "engine/models/qwen3_asr/frontend_whisper.h"
#include "engine/models/qwen3_asr/postprocess.h"
#include "engine/models/qwen3_asr/prompt_asr.h"
#include "engine/models/qwen3_asr/thinker.h"
#include "engine/models/qwen3_asr/tokenizer_text.h"

#include <cstddef>
#include <filesystem>
#include <memory>
#include <optional>
#include <vector>

namespace engine::models::qwen3_forced_aligner {
class Qwen3ForcedAlignerSession;
}

namespace engine::runtime {
class ILoadedVoiceModel;
}

namespace engine::models::qwen3_asr {

class Qwen3ASRSession final
    : public runtime::RuntimeSessionBase
    , public runtime::IOfflineVoiceTaskSession {
public:
    Qwen3ASRSession(
        runtime::TaskSpec task,
        runtime::SessionOptions options,
        std::shared_ptr<const Qwen3ASRAssets> assets);
    ~Qwen3ASRSession() override;

    std::string family() const override;
    runtime::VoiceTaskKind task_kind() const override;
    runtime::RunMode run_mode() const override;
    void prepare(const runtime::SessionPreparationRequest & request) override;
    runtime::TaskResult run(const runtime::TaskRequest & request) override;

private:
    struct AudioChunkPlan {
        runtime::TimeSpan source_span;
        runtime::TimeSpan keep_span;
    };

    Qwen3ASRRequest make_request(const runtime::TaskRequest & request) const;
    std::vector<AudioChunkPlan> audio_chunk_plan(const runtime::TaskRequest & request);
    runtime::IOfflineVoiceTaskSession & vad_session();
    runtime::TaskResult run_single(const Qwen3ASRRequest & request);

    runtime::TaskSpec task_;
    std::shared_ptr<const Qwen3ASRAssets> assets_;
    size_t audio_encoder_graph_arena_bytes_ = 128ull * 1024ull * 1024ull;
    size_t thinker_prefill_graph_arena_bytes_ = 256ull * 1024ull * 1024ull;
    size_t thinker_decode_graph_arena_bytes_ = 256ull * 1024ull * 1024ull;
    size_t thinker_weight_context_bytes_ = 64ull * 1024ull * 1024ull;
    engine::assets::TensorStorageType audio_encoder_weight_storage_type_ = engine::assets::TensorStorageType::Native;
    engine::assets::TensorStorageType thinker_weight_storage_type_ = engine::assets::TensorStorageType::Native;
    Qwen3ASRTextTokenizer tokenizer_;
    Qwen3ASRWhisperFrontend frontend_;
    Qwen3ASRAudioEncoderRuntime audio_encoder_;
    Qwen3ASRThinkerRuntime thinker_;
    Qwen3ASRPromptBuilder prompt_builder_;
    Qwen3ASRPostprocessor postprocessor_;
    std::unique_ptr<engine::models::qwen3_forced_aligner::Qwen3ForcedAlignerSession> forced_aligner_session_;
    std::filesystem::path vad_model_path_;
    std::unique_ptr<runtime::ILoadedVoiceModel> vad_model_;
    std::unique_ptr<runtime::IOfflineVoiceTaskSession> vad_session_;
};

}  // namespace engine::models::qwen3_asr
