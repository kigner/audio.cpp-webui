#include "engine/models/stable_audio/foundation/oobleck_autoencoder.h"

#include "engine/framework/audio/conversion.h"
#include "engine/framework/audio/resampling.h"
#include "engine/framework/core/backend_weight_store.h"
#include "engine/framework/core/execution_context.h"
#include "engine/framework/debug/profiler.h"
#include "engine/framework/modules/activation_modules.h"
#include "engine/framework/modules/primitive_modules.h"
#include "engine/framework/modules/structural_modules.h"
#include "engine/framework/sampling/torch_random.h"

#include <ggml-alloc.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <stdexcept>
#include <string>
#include <utility>

namespace engine::models::stable_audio::foundation {
namespace {

using Clock = std::chrono::steady_clock;

constexpr size_t kOobleckWeightContextBytes = 1400ull * 1024ull * 1024ull;

struct GgmlContextDeleter {
    void operator()(ggml_context * ctx) const noexcept {
        if (ctx != nullptr) {
            ggml_free(ctx);
        }
    }
};

std::vector<int64_t> decoder_channels(const StableAudioConfig & config) {
    std::vector<int64_t> channels;
    channels.reserve(config.same_c_mults.size() + 1);
    channels.push_back(1);
    channels.insert(channels.end(), config.same_c_mults.begin(), config.same_c_mults.end());
    for (int64_t & value : channels) {
        value *= config.same_channels;
    }
    return channels;
}

std::vector<int64_t> encoder_channels(const StableAudioConfig & config) {
    std::vector<int64_t> channels;
    channels.reserve(config.same_c_mults.size() + 1);
    channels.push_back(1);
    channels.insert(channels.end(), config.same_c_mults.begin(), config.same_c_mults.end());
    for (int64_t & value : channels) {
        value *= config.same_channels;
    }
    return channels;
}

std::vector<float> effective_weight_norm_conv(
    const assets::TensorSource & source,
    const std::string & prefix,
    const std::vector<int64_t> & shape) {
    if (shape.size() != 3) {
        throw std::runtime_error("Stable Audio Foundation Oobleck conv shape must be rank 3");
    }
    auto v = source.require_f32(prefix + ".weight_v", shape);
    auto g = source.require_f32(prefix + ".weight_g", {shape[0], 1, 1});
    const int64_t outer = shape[0];
    const int64_t inner = shape[1] * shape[2];
    for (int64_t o = 0; o < outer; ++o) {
        double norm_sq = 0.0;
        for (int64_t i = 0; i < inner; ++i) {
            const float value = v[static_cast<size_t>(o * inner + i)];
            norm_sq += static_cast<double>(value) * static_cast<double>(value);
        }
        const float scale = g[static_cast<size_t>(o)] /
            std::sqrt(static_cast<float>(std::max(norm_sq, 1.0e-24)));
        for (int64_t i = 0; i < inner; ++i) {
            v[static_cast<size_t>(o * inner + i)] *= scale;
        }
    }
    return v;
}

modules::Conv1dWeights load_wn_conv1d(
    core::BackendWeightStore & store,
    const assets::TensorSource & source,
    const std::string & prefix,
    assets::TensorStorageType storage_type,
    int64_t out_channels,
    int64_t in_channels,
    int64_t kernel,
    bool use_bias) {
    modules::Conv1dWeights weights;
    weights.weight = store.make_from_f32(
        core::TensorShape::from_dims({out_channels, in_channels, kernel}),
        storage_type,
        effective_weight_norm_conv(source, prefix, {out_channels, in_channels, kernel}));
    if (use_bias) {
        weights.bias = store.load_f32_tensor(source, prefix + ".bias", {out_channels});
    }
    return weights;
}

modules::ConvTranspose1dWeights load_wn_conv_transpose1d(
    core::BackendWeightStore & store,
    const assets::TensorSource & source,
    const std::string & prefix,
    assets::TensorStorageType storage_type,
    int64_t in_channels,
    int64_t out_channels,
    int64_t kernel,
    bool use_bias) {
    modules::ConvTranspose1dWeights weights;
    weights.weight = store.make_from_f32(
        core::TensorShape::from_dims({in_channels, out_channels, kernel}),
        storage_type,
        effective_weight_norm_conv(source, prefix, {in_channels, out_channels, kernel}));
    if (use_bias) {
        weights.bias = store.load_f32_tensor(source, prefix + ".bias", {out_channels});
    }
    return weights;
}

OobleckSnakeWeights load_snake(core::BackendWeightStore & store, const assets::TensorSource & source, const std::string & prefix, int64_t channels) {
    OobleckSnakeWeights weights;
    weights.alpha = store.load_f32_tensor(source, prefix + ".alpha", {channels});
    weights.beta = store.load_f32_tensor(source, prefix + ".beta", {channels});
    return weights;
}

OobleckResidualUnitWeights load_residual_unit(
    core::BackendWeightStore & store,
    const assets::TensorSource & source,
    const std::string & prefix,
    assets::TensorStorageType storage_type,
    int64_t channels,
    int64_t dilation) {
    OobleckResidualUnitWeights weights;
    weights.snake_0 = load_snake(store, source, prefix + ".layers.0", channels);
    weights.conv_1 = load_wn_conv1d(store, source, prefix + ".layers.1", storage_type, channels, channels, 7, true);
    weights.snake_2 = load_snake(store, source, prefix + ".layers.2", channels);
    weights.conv_3 = load_wn_conv1d(store, source, prefix + ".layers.3", storage_type, channels, channels, 1, true);
    (void)dilation;
    return weights;
}

OobleckDecoderBlockWeights load_decoder_block(
    core::BackendWeightStore & store,
    const assets::TensorSource & source,
    const std::string & prefix,
    assets::TensorStorageType storage_type,
    int64_t in_channels,
    int64_t out_channels,
    int64_t stride) {
    OobleckDecoderBlockWeights weights;
    weights.snake_0 = load_snake(store, source, prefix + ".layers.0", in_channels);
    weights.upsample = load_wn_conv_transpose1d(
        store,
        source,
        prefix + ".layers.1",
        storage_type,
        in_channels,
        out_channels,
        2 * stride,
        true);
    weights.residual_2 = load_residual_unit(store, source, prefix + ".layers.2", storage_type, out_channels, 1);
    weights.residual_3 = load_residual_unit(store, source, prefix + ".layers.3", storage_type, out_channels, 3);
    weights.residual_4 = load_residual_unit(store, source, prefix + ".layers.4", storage_type, out_channels, 9);
    return weights;
}

OobleckEncoderBlockWeights load_encoder_block(
    core::BackendWeightStore & store,
    const assets::TensorSource & source,
    const std::string & prefix,
    assets::TensorStorageType storage_type,
    int64_t in_channels,
    int64_t out_channels,
    int64_t stride) {
    OobleckEncoderBlockWeights weights;
    weights.residual_0 = load_residual_unit(store, source, prefix + ".layers.0", storage_type, in_channels, 1);
    weights.residual_1 = load_residual_unit(store, source, prefix + ".layers.1", storage_type, in_channels, 3);
    weights.residual_2 = load_residual_unit(store, source, prefix + ".layers.2", storage_type, in_channels, 9);
    weights.snake_3 = load_snake(store, source, prefix + ".layers.3", in_channels);
    weights.downsample = load_wn_conv1d(
        store,
        source,
        prefix + ".layers.4",
        storage_type,
        out_channels,
        in_channels,
        2 * stride,
        true);
    return weights;
}

core::TensorValue repeat_channel(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & value,
    const core::TensorValue & like,
    int64_t channels) {
    core::validate_shape(value, core::TensorShape::from_dims({channels}), "Stable Audio Foundation Oobleck channel tensor");
    const auto reshaped = core::reshape_tensor(ctx, value, core::TensorShape::from_dims({1, channels, 1}));
    return core::wrap_tensor(ggml_repeat(ctx.ggml, reshaped.tensor, like.tensor), like.shape, GGML_TYPE_F32);
}

core::TensorValue snake_beta(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & input,
    const OobleckSnakeWeights & weights,
    int64_t channels) {
    auto alpha = core::wrap_tensor(ggml_exp(ctx.ggml, weights.alpha.tensor), weights.alpha.shape, GGML_TYPE_F32);
    auto beta = core::wrap_tensor(ggml_exp(ctx.ggml, weights.beta.tensor), weights.beta.shape, GGML_TYPE_F32);
    alpha = repeat_channel(ctx, alpha, input, channels);
    beta = repeat_channel(ctx, beta, input, channels);
    auto ax = core::wrap_tensor(ggml_mul(ctx.ggml, input.tensor, alpha.tensor), input.shape, GGML_TYPE_F32);
    auto s = core::wrap_tensor(ggml_sin(ctx.ggml, ax.tensor), input.shape, GGML_TYPE_F32);
    auto s2 = core::wrap_tensor(ggml_sqr(ctx.ggml, s.tensor), input.shape, GGML_TYPE_F32);
    auto inv_beta = core::wrap_tensor(ggml_scale_bias(ctx.ggml, beta.tensor, 1.0F, 1.0e-9F), input.shape, GGML_TYPE_F32);
    auto periodic = core::wrap_tensor(ggml_div(ctx.ggml, s2.tensor, inv_beta.tensor), input.shape, GGML_TYPE_F32);
    return core::wrap_tensor(ggml_add(ctx.ggml, input.tensor, periodic.tensor), input.shape, GGML_TYPE_F32);
}

core::TensorValue residual_unit(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & input,
    const OobleckResidualUnitWeights & weights,
    int64_t channels,
    int64_t dilation) {
    auto hidden = snake_beta(ctx, input, weights.snake_0, channels);
    hidden = modules::Conv1dModule({channels, channels, 7, 1, static_cast<int>(dilation * 3), static_cast<int>(dilation), true})
                 .build(ctx, hidden, weights.conv_1);
    hidden = snake_beta(ctx, hidden, weights.snake_2, channels);
    hidden = modules::Conv1dModule({channels, channels, 1, 1, 0, 1, true})
                 .build(ctx, hidden, weights.conv_3);
    return modules::AddModule{}.build(ctx, input, hidden);
}

core::TensorValue decoder_block(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & input,
    const OobleckDecoderBlockWeights & weights,
    int64_t in_channels,
    int64_t out_channels,
    int64_t stride) {
    auto hidden = snake_beta(ctx, input, weights.snake_0, in_channels);
    hidden = modules::ConvTranspose1dModule({
        in_channels,
        out_channels,
        2 * stride,
        static_cast<int>(stride),
        0,
        1,
        true})
                 .build(ctx, hidden, weights.upsample);
    const int64_t crop = static_cast<int64_t>(std::ceil(static_cast<float>(stride) / 2.0F));
    hidden = modules::SliceModule({2, crop, input.shape.dims[2] * stride}).build(ctx, hidden);
    hidden = residual_unit(ctx, hidden, weights.residual_2, out_channels, 1);
    hidden = residual_unit(ctx, hidden, weights.residual_3, out_channels, 3);
    hidden = residual_unit(ctx, hidden, weights.residual_4, out_channels, 9);
    return hidden;
}

core::TensorValue encoder_block(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & input,
    const OobleckEncoderBlockWeights & weights,
    int64_t in_channels,
    int64_t out_channels,
    int64_t stride) {
    auto hidden = residual_unit(ctx, input, weights.residual_0, in_channels, 1);
    hidden = residual_unit(ctx, hidden, weights.residual_1, in_channels, 3);
    hidden = residual_unit(ctx, hidden, weights.residual_2, in_channels, 9);
    hidden = snake_beta(ctx, hidden, weights.snake_3, in_channels);
    return modules::Conv1dModule({
        in_channels,
        out_channels,
        2 * stride,
        static_cast<int>(stride),
        static_cast<int>(std::ceil(static_cast<float>(stride) / 2.0F)),
        1,
        true})
        .build(ctx, hidden, weights.downsample);
}

std::vector<float> prepare_audio_for_oobleck(
    const runtime::AudioBuffer & audio,
    const StableAudioConfig & config,
    int64_t target_frames) {
    if (audio.sample_rate <= 0 || audio.channels <= 0 || target_frames <= 0) {
        throw std::runtime_error("Stable Audio Foundation Oobleck encode audio shape is invalid");
    }
    if (audio.samples.size() % static_cast<size_t>(audio.channels) != 0) {
        throw std::runtime_error("Stable Audio Foundation Oobleck encode audio samples are not aligned to channels");
    }
    const int input_channels = audio.channels;
    std::vector<std::vector<float>> channels;
    channels.reserve(static_cast<size_t>(input_channels));
    for (int c = 0; c < input_channels; ++c) {
        auto channel = engine::audio::extract_interleaved_channel(audio.samples, input_channels, c);
        if (audio.sample_rate != config.sample_rate) {
            channel = engine::audio::resample_mono_torchaudio_sinc_hann(channel, audio.sample_rate, config.sample_rate);
        }
        channel.resize(static_cast<size_t>(target_frames), 0.0F);
        channels.push_back(std::move(channel));
    }

    const int target_channels = config.audio_channels;
    std::vector<float> planar(static_cast<size_t>(target_channels * target_frames), 0.0F);
    if (target_channels == 1) {
        for (int64_t t = 0; t < target_frames; ++t) {
            float sum = 0.0F;
            for (int c = 0; c < input_channels; ++c) {
                sum += channels[static_cast<size_t>(c)][static_cast<size_t>(t)];
            }
            planar[static_cast<size_t>(t)] = sum / static_cast<float>(input_channels);
        }
        return planar;
    }
    for (int c = 0; c < target_channels; ++c) {
        const int src = input_channels == 1 ? 0 : std::min(c, input_channels - 1);
        std::copy_n(
            channels[static_cast<size_t>(src)].data(),
            static_cast<size_t>(target_frames),
            planar.data() + static_cast<std::ptrdiff_t>(c * target_frames));
    }
    return planar;
}

}  // namespace

OobleckAutoencoderWeights load_oobleck_autoencoder_weights(
    const StableAudioAssets & assets,
    ggml_backend_t backend,
    core::BackendType backend_type,
    size_t weight_context_bytes,
    assets::TensorStorageType weight_storage_type) {
    const auto & config = assets.config;
    const auto & source = *assets.model_weights;
    const auto channels = decoder_channels(config);
    const auto enc_channels = encoder_channels(config);
    OobleckAutoencoderWeights weights;
    weights.store = std::make_shared<core::BackendWeightStore>(
        backend,
        backend_type,
        "stable_audio.foundation.oobleck.weights",
        weight_context_bytes == 0 ? kOobleckWeightContextBytes : weight_context_bytes);
    weights.encoder_in_conv = load_wn_conv1d(
        *weights.store,
        source,
        "pretransform.model.encoder.layers.0",
        weight_storage_type,
        enc_channels.front(),
        config.audio_channels,
        7,
        true);
    weights.encoder_blocks.reserve(config.same_strides.size());
    for (size_t block = 0; block < config.same_strides.size(); ++block) {
        weights.encoder_blocks.push_back(load_encoder_block(
            *weights.store,
            source,
            "pretransform.model.encoder.layers." + std::to_string(block + 1),
            weight_storage_type,
            enc_channels[block],
            enc_channels[block + 1],
            config.same_strides[block]));
    }
    weights.encoder_final_snake = load_snake(
        *weights.store,
        source,
        "pretransform.model.encoder.layers." + std::to_string(config.same_strides.size() + 1),
        enc_channels.back());
    weights.encoder_out_conv = load_wn_conv1d(
        *weights.store,
        source,
        "pretransform.model.encoder.layers." + std::to_string(config.same_strides.size() + 2),
        weight_storage_type,
        config.latent_dim * 2,
        enc_channels.back(),
        3,
        true);
    weights.in_conv = load_wn_conv1d(
        *weights.store,
        source,
        "pretransform.model.decoder.layers.0",
        weight_storage_type,
        channels.back(),
        config.latent_dim,
        7,
        true);
    weights.blocks.reserve(config.same_strides.size());
    for (int64_t block = static_cast<int64_t>(config.same_strides.size()); block > 0; --block) {
        const int64_t layer_index = static_cast<int64_t>(config.same_strides.size()) - block + 1;
        weights.blocks.push_back(load_decoder_block(
            *weights.store,
            source,
            "pretransform.model.decoder.layers." + std::to_string(layer_index),
            weight_storage_type,
            channels[static_cast<size_t>(block)],
            channels[static_cast<size_t>(block - 1)],
            config.same_strides[static_cast<size_t>(block - 1)]));
    }
    weights.final_snake = load_snake(
        *weights.store,
        source,
        "pretransform.model.decoder.layers." + std::to_string(config.same_strides.size() + 1),
        channels.front());
    weights.out_conv = load_wn_conv1d(
        *weights.store,
        source,
        "pretransform.model.decoder.layers." + std::to_string(config.same_strides.size() + 2),
        weight_storage_type,
        config.audio_channels,
        channels.front(),
        7,
        false);
    weights.store->upload();
    return weights;
}

class OobleckAutoencoderRuntime::EncodeGraph {
public:
    EncodeGraph(
        core::ExecutionContext & execution,
        std::shared_ptr<const StableAudioAssets> assets,
        const OobleckAutoencoderWeights & weights,
        int64_t frames)
        : backend_(execution.backend()),
          backend_type_(execution.backend_type()),
          threads_(std::max(1, execution.config().threads)),
          assets_(std::move(assets)),
          weights_(weights),
          frames_(frames) {
        if (backend_ == nullptr) {
            throw std::runtime_error("Stable Audio Foundation Oobleck encode backend initialization failed");
        }
        if (frames_ <= 0) {
            throw std::runtime_error("Stable Audio Foundation Oobleck encode graph shape must be positive");
        }
        build();
    }

    ~EncodeGraph() {
        if (backend_ != nullptr && graph_ != nullptr) {
            engine::core::release_backend_graph_resources(backend_type_, backend_, graph_);
        }
        if (gallocr_ != nullptr) {
            ggml_gallocr_free(gallocr_);
        }
    }

    bool matches(int64_t frames) const noexcept {
        return frames == frames_;
    }

    std::vector<float> encode(
        const runtime::AudioBuffer & audio,
        uint64_t seed,
        uint64_t & rng_offset_blocks,
        const engine::sampling::TorchCudaSamplingPolicy & rng_policy) const {
        const auto total_start = Clock::now();
        const auto & config = assets_->config;
        const auto prepared = prepare_audio_for_oobleck(audio, config, frames_);
        core::write_tensor_f32(input_, prepared);
        core::set_backend_threads(backend_, threads_);
        const auto compute_start = Clock::now();
        const ggml_status status = engine::core::compute_backend_graph(backend_, graph_, nullptr, "stable_audio.foundation.oobleck.encode");
        if (status != GGML_STATUS_SUCCESS) {
            throw std::runtime_error("Stable Audio Foundation Oobleck encode graph compute failed");
        }
        engine::debug::timing_log_scalar(
            "stable_audio.foundation.oobleck.encode.graph.compute_ms",
            engine::debug::elapsed_ms(compute_start, Clock::now()));
        const auto encoded = core::read_tensor_f32(output_);
        const int64_t latent_tokens = output_tokens_;
        if (static_cast<int64_t>(encoded.size()) != 2 * config.latent_dim * latent_tokens) {
            throw std::runtime_error("Stable Audio Foundation Oobleck encode output shape mismatch");
        }
        auto noise = engine::sampling::generate_torch_cuda_tensor_iterator_randn(
            static_cast<size_t>(config.latent_dim * latent_tokens),
            seed,
            rng_offset_blocks,
            rng_policy,
            engine::sampling::TorchRandnPrecision::Float32);
        rng_offset_blocks += engine::sampling::torch_cuda_tensor_iterator_offset_blocks(
            static_cast<uint64_t>(noise.size()),
            rng_policy);
        std::vector<float> latents(static_cast<size_t>(config.latent_dim * latent_tokens), 0.0F);
        for (int64_t c = 0; c < config.latent_dim; ++c) {
            for (int64_t t = 0; t < latent_tokens; ++t) {
                const size_t dst = static_cast<size_t>(c * latent_tokens + t);
                const float mean = encoded[dst];
                const float scale = encoded[static_cast<size_t>((config.latent_dim + c) * latent_tokens + t)];
                const float stdev = std::log1p(std::exp(-std::abs(scale))) + std::max(scale, 0.0F) + 1.0e-4F;
                latents[dst] = mean + noise[dst] * stdev;
                if (!std::isfinite(latents[dst])) {
                    throw std::runtime_error("Stable Audio Foundation Oobleck encode produced non-finite latent");
                }
            }
        }
        engine::debug::timing_log_scalar(
            "stable_audio.foundation.oobleck.encode.total_ms",
            engine::debug::elapsed_ms(total_start, Clock::now()));
        return latents;
    }

private:
    void build() {
        const auto & config = assets_->config;
        ggml_init_params params{256ull * 1024ull * 1024ull, nullptr, true};
        ctx_.reset(ggml_init(params));
        if (ctx_ == nullptr) {
            throw std::runtime_error("Stable Audio Foundation Oobleck encode ggml context initialization failed");
        }
        auto input_ctx = core::ModuleBuildContext{ctx_.get(), "stable_audio.foundation.oobleck.encode.inputs", backend_type_};
        input_ = core::make_tensor(input_ctx, GGML_TYPE_F32, core::TensorShape::from_dims({1, config.audio_channels, frames_}));
        ggml_set_input(input_.tensor);
        core::ModuleBuildContext build_ctx{ctx_.get(), "stable_audio.foundation.oobleck.encode", backend_type_};
        auto output = build_graph_output(build_ctx);
        output_ = output.tensor;
        output_tokens_ = output.shape.dims[2];
        ggml_set_output(output_);
        graph_ = ggml_new_graph_custom(ctx_.get(), 524288, false);
        ggml_build_forward_expand(graph_, output_);
        gallocr_ = ggml_gallocr_new(ggml_backend_get_default_buffer_type(backend_));
        if (gallocr_ == nullptr ||
            !ggml_gallocr_reserve(gallocr_, graph_) ||
            !ggml_gallocr_alloc_graph(gallocr_, graph_)) {
            throw std::runtime_error("Stable Audio Foundation Oobleck encode backend buffer allocation failed");
        }
    }

    core::TensorValue build_graph_output(core::ModuleBuildContext & ctx) const {
        const auto & config = assets_->config;
        const auto channels = encoder_channels(config);
        auto hidden = modules::Conv1dModule({config.audio_channels, channels.front(), 7, 1, 3, 1, true})
                          .build(ctx, input_, weights_.encoder_in_conv);
        for (size_t i = 0; i < weights_.encoder_blocks.size(); ++i) {
            hidden = encoder_block(
                ctx,
                hidden,
                weights_.encoder_blocks[i],
                channels[i],
                channels[i + 1],
                config.same_strides[i]);
        }
        hidden = snake_beta(ctx, hidden, weights_.encoder_final_snake, channels.back());
        return modules::Conv1dModule({channels.back(), config.latent_dim * 2, 3, 1, 1, 1, true})
            .build(ctx, hidden, weights_.encoder_out_conv);
    }

    ggml_backend_t backend_ = nullptr;
    core::BackendType backend_type_ = core::BackendType::Cpu;
    int threads_ = 1;
    std::shared_ptr<const StableAudioAssets> assets_;
    const OobleckAutoencoderWeights & weights_;
    int64_t frames_ = 0;
    int64_t output_tokens_ = 0;
    std::unique_ptr<ggml_context, GgmlContextDeleter> ctx_;
    core::TensorValue input_;
    ggml_tensor * output_ = nullptr;
    ggml_cgraph * graph_ = nullptr;
    ggml_gallocr_t gallocr_ = nullptr;
};

class OobleckAutoencoderRuntime::DecodeGraph {
public:
    DecodeGraph(
        core::ExecutionContext & execution,
        std::shared_ptr<const StableAudioAssets> assets,
        const OobleckAutoencoderWeights & weights,
        int64_t batch,
        int64_t latent_tokens)
        : backend_(execution.backend()),
          backend_type_(execution.backend_type()),
          threads_(std::max(1, execution.config().threads)),
          assets_(std::move(assets)),
          weights_(weights),
          batch_(batch),
          latent_tokens_(latent_tokens) {
        if (backend_ == nullptr) {
            throw std::runtime_error("Stable Audio Foundation Oobleck backend initialization failed");
        }
        if (batch_ <= 0 || latent_tokens_ <= 0) {
            throw std::runtime_error("Stable Audio Foundation Oobleck graph shape must be positive");
        }
        build();
    }

    ~DecodeGraph() {
        if (backend_ != nullptr && graph_ != nullptr) {
            engine::core::release_backend_graph_resources(backend_type_, backend_, graph_);
        }
        if (gallocr_ != nullptr) {
            ggml_gallocr_free(gallocr_);
        }
    }

    bool matches(int64_t batch, int64_t latent_tokens) const noexcept {
        return batch == batch_ && latent_tokens == latent_tokens_;
    }

    std::vector<runtime::AudioBuffer> decode(const std::vector<float> & latents) const {
        const auto total_start = Clock::now();
        const auto & config = assets_->config;
        if (static_cast<int64_t>(latents.size()) != batch_ * config.latent_dim * latent_tokens_) {
            throw std::runtime_error("Stable Audio Foundation Oobleck latent shape mismatch");
        }
        core::write_tensor_f32(input_, latents);
        core::set_backend_threads(backend_, threads_);
        const auto compute_start = Clock::now();
        const ggml_status status = engine::core::compute_backend_graph(backend_, graph_, nullptr, "stable_audio.foundation.oobleck.decode");
        if (status != GGML_STATUS_SUCCESS) {
            throw std::runtime_error("Stable Audio Foundation Oobleck decode graph compute failed");
        }
        engine::debug::timing_log_scalar(
            "stable_audio.foundation.oobleck.decode.graph.compute_ms",
            engine::debug::elapsed_ms(compute_start, Clock::now()));
        auto decoded = core::read_tensor_f32(output_);
        for (const float value : decoded) {
            if (!std::isfinite(value)) {
                throw std::runtime_error("Stable Audio Foundation Oobleck decode produced non-finite output");
            }
        }
        const int64_t frames = output_frames_;
        std::vector<runtime::AudioBuffer> out;
        out.reserve(static_cast<size_t>(batch_));
        for (int64_t b = 0; b < batch_; ++b) {
            runtime::AudioBuffer audio;
            audio.sample_rate = config.sample_rate;
            audio.channels = config.audio_channels;
            audio.samples.assign(static_cast<size_t>(frames * config.audio_channels), 0.0F);
            for (int64_t c = 0; c < config.audio_channels; ++c) {
                for (int64_t t = 0; t < frames; ++t) {
                    audio.samples[static_cast<size_t>(t * config.audio_channels + c)] =
                        decoded[static_cast<size_t>((b * config.audio_channels + c) * frames + t)];
                }
            }
            out.push_back(std::move(audio));
        }
        engine::debug::timing_log_scalar(
            "stable_audio.foundation.oobleck.decode.total_ms",
            engine::debug::elapsed_ms(total_start, Clock::now()));
        return out;
    }

private:
    void build() {
        const auto & config = assets_->config;
        ggml_init_params params{256ull * 1024ull * 1024ull, nullptr, true};
        ctx_.reset(ggml_init(params));
        if (ctx_ == nullptr) {
            throw std::runtime_error("Stable Audio Foundation Oobleck ggml context initialization failed");
        }
        auto input_ctx = core::ModuleBuildContext{ctx_.get(), "stable_audio.foundation.oobleck.inputs", backend_type_};
        input_ = core::make_tensor(input_ctx, GGML_TYPE_F32, core::TensorShape::from_dims({batch_, config.latent_dim, latent_tokens_}));
        ggml_set_input(input_.tensor);
        core::ModuleBuildContext build_ctx{ctx_.get(), "stable_audio.foundation.oobleck.decode", backend_type_};
        auto output = build_graph_output(build_ctx);
        output_ = output.tensor;
        output_frames_ = output.shape.dims[2];
        ggml_set_output(output_);
        graph_ = ggml_new_graph_custom(ctx_.get(), 524288, false);
        ggml_build_forward_expand(graph_, output_);
        gallocr_ = ggml_gallocr_new(ggml_backend_get_default_buffer_type(backend_));
        if (gallocr_ == nullptr ||
            !ggml_gallocr_reserve(gallocr_, graph_) ||
            !ggml_gallocr_alloc_graph(gallocr_, graph_)) {
            throw std::runtime_error("Stable Audio Foundation Oobleck backend buffer allocation failed");
        }
    }

    core::TensorValue build_graph_output(core::ModuleBuildContext & ctx) const {
        const auto & config = assets_->config;
        const auto channels = decoder_channels(config);
        auto hidden = modules::Conv1dModule({config.latent_dim, channels.back(), 7, 1, 3, 1, true})
                          .build(ctx, input_, weights_.in_conv);
        for (size_t i = 0; i < weights_.blocks.size(); ++i) {
            const int64_t block = static_cast<int64_t>(config.same_strides.size() - i);
            hidden = decoder_block(
                ctx,
                hidden,
                weights_.blocks[i],
                channels[static_cast<size_t>(block)],
                channels[static_cast<size_t>(block - 1)],
                config.same_strides[static_cast<size_t>(block - 1)]);
        }
        hidden = snake_beta(ctx, hidden, weights_.final_snake, channels.front());
        return modules::Conv1dModule({channels.front(), config.audio_channels, 7, 1, 3, 1, false})
            .build(ctx, hidden, weights_.out_conv);
    }

    ggml_backend_t backend_ = nullptr;
    core::BackendType backend_type_ = core::BackendType::Cpu;
    int threads_ = 1;
    std::shared_ptr<const StableAudioAssets> assets_;
    const OobleckAutoencoderWeights & weights_;
    int64_t batch_ = 0;
    int64_t latent_tokens_ = 0;
    int64_t output_frames_ = 0;
    std::unique_ptr<ggml_context, GgmlContextDeleter> ctx_;
    core::TensorValue input_;
    ggml_tensor * output_ = nullptr;
    ggml_cgraph * graph_ = nullptr;
    ggml_gallocr_t gallocr_ = nullptr;
};

OobleckAutoencoderRuntime::OobleckAutoencoderRuntime(
    core::ExecutionContext & execution,
    std::shared_ptr<const StableAudioAssets> assets,
    assets::TensorStorageType weight_storage_type)
    : execution_(&execution),
      assets_(std::move(assets)),
      weight_storage_type_(weight_storage_type) {
    if (execution_ == nullptr) {
        throw std::runtime_error("Stable Audio Foundation Oobleck runtime requires execution context");
    }
    if (assets_ == nullptr) {
        throw std::runtime_error("Stable Audio Foundation Oobleck runtime requires assets");
    }
}

OobleckAutoencoderRuntime::~OobleckAutoencoderRuntime() = default;

const OobleckAutoencoderWeights & require_oobleck_weights(
    std::unique_ptr<OobleckAutoencoderWeights> & weights,
    core::ExecutionContext & execution,
    const std::shared_ptr<const StableAudioAssets> & assets,
    assets::TensorStorageType weight_storage_type) {
    if (!weights) {
        weights = std::make_unique<OobleckAutoencoderWeights>(load_oobleck_autoencoder_weights(
            *assets,
            execution.backend(),
            execution.backend_type(),
            0,
            weight_storage_type));
        assets->model_weights->release_storage();
    }
    return *weights;
}

std::vector<float> OobleckAutoencoderRuntime::encode(
    const runtime::AudioBuffer & audio,
    int64_t target_frames,
    uint64_t seed,
    uint64_t & rng_offset_blocks,
    const engine::sampling::TorchCudaSamplingPolicy & rng_policy) const {
    const auto & weights = require_oobleck_weights(weights_, *execution_, assets_, weight_storage_type_);
    if (!encode_graph_ || !encode_graph_->matches(target_frames)) {
        encode_graph_ = std::make_unique<EncodeGraph>(*execution_, assets_, weights, target_frames);
    }
    return encode_graph_->encode(audio, seed, rng_offset_blocks, rng_policy);
}

void OobleckAutoencoderRuntime::prepare_decode(int64_t batch, int64_t latent_tokens) const {
    const auto & weights = require_oobleck_weights(weights_, *execution_, assets_, weight_storage_type_);
    if (!decode_graph_ || !decode_graph_->matches(batch, latent_tokens)) {
        decode_graph_ = std::make_unique<DecodeGraph>(*execution_, assets_, weights, batch, latent_tokens);
    }
}

std::vector<runtime::AudioBuffer> OobleckAutoencoderRuntime::decode(
    const std::vector<float> & latents,
    int64_t batch,
    int64_t latent_tokens) const {
    prepare_decode(batch, latent_tokens);
    return decode_graph_->decode(latents);
}

}  // namespace engine::models::stable_audio::foundation
