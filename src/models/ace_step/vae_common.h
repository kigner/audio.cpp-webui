#pragma once

#include "engine/framework/assets/tensor_source.h"
#include "engine/framework/core/backend.h"
#include "engine/framework/core/backend_weight_store.h"
#include "engine/framework/core/module.h"
#include "engine/framework/modules/conv_modules.h"
#include "engine/framework/runtime/session.h"
#include "engine/models/ace_step/assets.h"
#include "engine/models/ace_step/types.h"

#include <ggml-backend.h>
#include <ggml-alloc.h>
#include <ggml.h>

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace engine::models::ace_step::vae_common {

using Clock = std::chrono::steady_clock;

struct GgmlContextDeleter {
    void operator()(ggml_context * ctx) const noexcept;
};

struct SnakeExactWeights {
    core::TensorValue alpha;
    core::TensorValue beta_inv;
};

struct WeightNormConv1dWeights {
    engine::modules::Conv1dWeights conv;
    int stride = 1;
    int padding = 0;
    int dilation = 1;
};

struct WeightNormConvTranspose1dWeights {
    engine::modules::ConvTranspose1dWeights conv;
    core::TensorValue col_weight;
    int stride = 1;
    int padding = 0;
    int dilation = 1;
};

struct ResidualUnitWeights {
    SnakeExactWeights snake1;
    WeightNormConv1dWeights conv1;
    SnakeExactWeights snake2;
    WeightNormConv1dWeights conv2;
};

struct DecoderBlockWeights {
    SnakeExactWeights snake;
    WeightNormConvTranspose1dWeights conv_t;
    ResidualUnitWeights res1;
    ResidualUnitWeights res2;
    ResidualUnitWeights res3;
};

struct EncoderBlockWeights {
    ResidualUnitWeights res1;
    ResidualUnitWeights res2;
    ResidualUnitWeights res3;
    SnakeExactWeights snake;
    WeightNormConv1dWeights conv;
};

struct VAEEncoderWeights {
    std::shared_ptr<core::BackendWeightStore> store;
    WeightNormConv1dWeights encoder_conv1;
    std::vector<EncoderBlockWeights> encoder_blocks;
    SnakeExactWeights encoder_snake_out;
    WeightNormConv1dWeights encoder_conv2;
};

struct VAEDecoderWeights {
    std::shared_ptr<core::BackendWeightStore> store;
    WeightNormConv1dWeights conv1;
    std::vector<DecoderBlockWeights> blocks;
    SnakeExactWeights snake_out;
    WeightNormConv1dWeights conv2;
};

core::TensorValue ensure_f32(core::ModuleBuildContext & ctx, const core::TensorValue & value);
core::TensorValue ensure_contiguous_nontransposed(core::ModuleBuildContext & ctx, const core::TensorValue & value);
core::TensorValue require_contiguous_nontransposed_weight(const core::TensorValue & weight, const char * module_name);
core::TensorValue require_f32_weight(const core::TensorValue & value, const char * module_name);
core::TensorValue build_snake1d_exact_bct(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & input,
    const SnakeExactWeights & weights,
    int64_t channels);
core::TensorValue build_conv1d(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & input,
    const WeightNormConv1dWeights & weights,
    int64_t in_channels,
    int64_t out_channels,
    bool use_bias);
core::TensorValue build_residual_unit(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & input,
    const ResidualUnitWeights & weights,
    int64_t channels,
    int dilation);
SnakeExactWeights load_snake_exact(
    core::BackendWeightStore & store,
    const assets::TensorSource & source,
    const std::string & prefix,
    int64_t channels);
WeightNormConv1dWeights load_weight_norm_conv1d(
    core::BackendWeightStore & store,
    const assets::TensorSource & source,
    const std::string & prefix,
    int64_t out_channels,
    int64_t in_channels,
    int64_t kernel,
    int stride,
    int padding,
    int dilation,
    assets::TensorStorageType storage_type,
    bool use_bias);
ResidualUnitWeights load_residual_unit(
    core::BackendWeightStore & store,
    const assets::TensorSource & source,
    const std::string & prefix,
    int64_t channels,
    assets::TensorStorageType storage_type);
int64_t audio_frames_per_latent(const AceStepVAEConfig & config);
VAEEncoderWeights load_vae_encoder_weights(
    const AceStepAssets & assets,
    ggml_backend_t backend,
    core::BackendType backend_type,
    size_t weight_context_bytes,
    assets::TensorStorageType storage_type);
VAEDecoderWeights load_vae_decoder_weights(
    const AceStepAssets & assets,
    ggml_backend_t backend,
    core::BackendType backend_type,
    size_t weight_context_bytes,
    assets::TensorStorageType storage_type);

class AceStepVAEEncodeGraph {
public:
    AceStepVAEEncodeGraph(
        std::shared_ptr<const AceStepAssets> assets,
        ggml_backend_t backend,
        core::BackendType backend_type,
        int threads,
        std::shared_ptr<const VAEEncoderWeights> weights,
        int64_t audio_frames,
        size_t graph_arena_bytes);
    ~AceStepVAEEncodeGraph();

    bool can_run(int64_t audio_frames) const noexcept;

    AceStepLatents encode(
        const runtime::AudioBuffer & audio,
        uint64_t seed,
        uint64_t & noise_offset,
        const std::vector<float> * noise_override = nullptr) const;

private:
    void build(size_t graph_arena_bytes);

    std::shared_ptr<const AceStepAssets> assets_;
    ggml_backend_t backend_ = nullptr;
    core::BackendType backend_type_ = core::BackendType::Cpu;
    int threads_ = 1;
    std::shared_ptr<const VAEEncoderWeights> weights_;
    int64_t audio_frames_ = 0;
    int64_t latent_frames_ = 0;
    int64_t latent_channels_ = 0;
    std::unique_ptr<ggml_context, GgmlContextDeleter> ctx_;
    core::TensorValue input_value_;
    core::TensorValue output_value_;
    ggml_cgraph * graph_ = nullptr;
    mutable std::vector<float> bct_input_scratch_;
    mutable std::vector<float> bct_output_scratch_;
    ggml_gallocr_t gallocr_ = nullptr;
};

class AceStepVAEEncoderRuntimeCore {
public:
    AceStepVAEEncoderRuntimeCore(
        std::shared_ptr<const AceStepAssets> assets,
        ggml_backend_t backend,
        core::BackendType backend_type,
        int threads,
        std::shared_ptr<const VAEEncoderWeights> weights,
        size_t graph_arena_bytes);

    AceStepLatents encode(const runtime::AudioBuffer & audio, uint32_t seed, const std::string & noise_file);
    void release_runtime_graphs();

private:
    void ensure_graph(int64_t audio_frames);

    std::shared_ptr<const AceStepAssets> assets_;
    ggml_backend_t backend_ = nullptr;
    core::BackendType backend_type_ = core::BackendType::Cpu;
    int threads_ = 1;
    std::shared_ptr<const VAEEncoderWeights> weights_;
    size_t graph_arena_bytes_ = 0;
    std::unique_ptr<AceStepVAEEncodeGraph> graph_;
};

}  // namespace engine::models::ace_step::vae_common
