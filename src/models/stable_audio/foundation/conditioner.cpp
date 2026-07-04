#include "engine/models/stable_audio/foundation/conditioner.h"

#include "engine/framework/core/backend_weight_store.h"
#include "engine/framework/core/execution_context.h"
#include "engine/framework/debug/profiler.h"

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

constexpr size_t kT5BaseWeightContextBytes = 1100ull * 1024ull * 1024ull;
constexpr int64_t kNumberFourierHalfDim = 128;
constexpr int64_t kNumberEmbeddingDim = 2 * kNumberFourierHalfDim + 1;
constexpr float kMaskNegInf = -1.0e9F;
constexpr float kPi = 3.14159265358979323846F;

struct GgmlContextDeleter {
    void operator()(ggml_context * ctx) const noexcept {
        if (ctx != nullptr) {
            ggml_free(ctx);
        }
    }
};

modules::LinearWeights load_linear(
    core::BackendWeightStore & store,
    const assets::TensorSource & source,
    const std::string & prefix,
    assets::TensorStorageType storage_type,
    int64_t out_features,
    int64_t in_features,
    bool use_bias) {
    modules::LinearWeights weights;
    weights.weight = store.load_tensor(source, prefix + ".weight", storage_type, {out_features, in_features});
    if (use_bias) {
        weights.bias = store.load_f32_tensor(source, prefix + ".bias", {out_features});
    }
    return weights;
}

modules::T5BaseEncoderLayerWeights load_t5_layer(
    core::BackendWeightStore & store,
    const assets::TensorSource & source,
    const std::string & prefix,
    const StableAudioConfig & config,
    assets::TensorStorageType storage_type) {
    modules::T5BaseEncoderLayerWeights weights;
    weights.self_attention_layer_norm =
        store.load_f32_tensor(source, prefix + ".layer.0.layer_norm.weight", {config.t5_hidden_size});
    weights.ffn_layer_norm =
        store.load_f32_tensor(source, prefix + ".layer.1.layer_norm.weight", {config.t5_hidden_size});
    weights.q_proj = load_linear(
        store,
        source,
        prefix + ".layer.0.SelfAttention.q",
        storage_type,
        config.t5_attention_heads * config.t5_head_dim,
        config.t5_hidden_size,
        false);
    weights.k_proj = load_linear(
        store,
        source,
        prefix + ".layer.0.SelfAttention.k",
        storage_type,
        config.t5_attention_heads * config.t5_head_dim,
        config.t5_hidden_size,
        false);
    weights.v_proj = load_linear(
        store,
        source,
        prefix + ".layer.0.SelfAttention.v",
        storage_type,
        config.t5_attention_heads * config.t5_head_dim,
        config.t5_hidden_size,
        false);
    weights.o_proj = load_linear(
        store,
        source,
        prefix + ".layer.0.SelfAttention.o",
        storage_type,
        config.t5_hidden_size,
        config.t5_attention_heads * config.t5_head_dim,
        false);
    weights.wi_proj = load_linear(
        store,
        source,
        prefix + ".layer.1.DenseReluDense.wi",
        storage_type,
        config.t5_intermediate_size,
        config.t5_hidden_size,
        false);
    weights.wo_proj = load_linear(
        store,
        source,
        prefix + ".layer.1.DenseReluDense.wo",
        storage_type,
        config.t5_hidden_size,
        config.t5_intermediate_size,
        false);
    return weights;
}

modules::T5BaseEncoderConfig t5_base_config(const StableAudioConfig & config) {
    modules::T5BaseEncoderConfig out;
    out.hidden_size = config.t5_hidden_size;
    out.layers = config.t5_layers;
    out.attention_heads = config.t5_attention_heads;
    out.head_dim = config.t5_head_dim;
    out.intermediate_size = config.t5_intermediate_size;
    out.vocab_size = config.t5_vocab_size;
    out.rms_norm_eps = config.t5_rms_norm_eps;
    return out;
}

std::vector<float> make_additive_attention_mask(
    const StableAudioTokenBatch & tokens,
    int64_t max_batch,
    int64_t heads) {
    std::vector<float> out(static_cast<size_t>(max_batch * heads * tokens.tokens * tokens.tokens), kMaskNegInf);
    for (int64_t b = 0; b < tokens.batch; ++b) {
        for (int64_t h = 0; h < heads; ++h) {
            for (int64_t q = 0; q < tokens.tokens; ++q) {
                for (int64_t k = 0; k < tokens.tokens; ++k) {
                    const bool keep = tokens.attention_mask[static_cast<size_t>(b * tokens.tokens + k)] != 0;
                    out[static_cast<size_t>(((b * heads + h) * tokens.tokens + q) * tokens.tokens + k)] =
                        keep ? 0.0F : kMaskNegInf;
                }
            }
        }
    }
    return out;
}

std::vector<int32_t> relative_buckets(int64_t tokens) {
    return modules::t5_base_relative_position_buckets(tokens, tokens, 32, 128, true);
}

std::shared_ptr<const StableAudioAssets> require_assets(std::shared_ptr<const StableAudioAssets> assets) {
    if (assets == nullptr) {
        throw std::runtime_error("Stable Audio Foundation conditioner requires assets");
    }
    return assets;
}

void validate_batch_seconds(const StableAudioTokenBatch & tokens, const std::vector<float> & normalized_seconds) {
    if (tokens.batch <= 0) {
        throw std::runtime_error("Stable Audio Foundation conditioner requires a positive batch");
    }
    if (static_cast<int64_t>(normalized_seconds.size()) != tokens.batch) {
        throw std::runtime_error("Stable Audio Foundation conditioner seconds batch does not match prompt batch");
    }
}

FoundationNumberConditionerWeights load_number_conditioner(
    const assets::TensorSource & source,
    const std::string & prefix,
    int64_t output_dim) {
    FoundationNumberConditionerWeights weights;
    weights.frequencies = source.require_f32(prefix + ".embedder.embedding.0.weights", {kNumberFourierHalfDim});
    weights.projection_weight =
        source.require_f32(prefix + ".embedder.embedding.1.weight", {output_dim, kNumberEmbeddingDim});
    weights.projection_bias = source.require_f32(prefix + ".embedder.embedding.1.bias", {output_dim});
    return weights;
}

std::vector<float> number_embedding(
    const FoundationNumberConditionerWeights & weights,
    float normalized,
    int64_t output_dim) {
    std::vector<float> features(static_cast<size_t>(kNumberEmbeddingDim), 0.0F);
    features[0] = normalized;
    for (int64_t i = 0; i < kNumberFourierHalfDim; ++i) {
        const float arg = normalized * weights.frequencies[static_cast<size_t>(i)] * 2.0F * kPi;
        features[static_cast<size_t>(1 + i)] = std::sin(arg);
        features[static_cast<size_t>(1 + kNumberFourierHalfDim + i)] = std::cos(arg);
    }
    std::vector<float> out(static_cast<size_t>(output_dim), 0.0F);
    for (int64_t o = 0; o < output_dim; ++o) {
        float sum = weights.projection_bias[static_cast<size_t>(o)];
        for (int64_t i = 0; i < kNumberEmbeddingDim; ++i) {
            sum += weights.projection_weight[static_cast<size_t>(o * kNumberEmbeddingDim + i)] *
                   features[static_cast<size_t>(i)];
        }
        out[static_cast<size_t>(o)] = sum;
    }
    return out;
}

}  // namespace

T5BaseRuntimeWeights load_t5_base_runtime_weights(
    const StableAudioAssets & assets,
    ggml_backend_t backend,
    core::BackendType backend_type,
    size_t weight_context_bytes,
    assets::TensorStorageType weight_storage_type) {
    const auto & config = assets.config;
    const auto & source = *assets.t5_weights;
    T5BaseRuntimeWeights weights;
    weights.store = std::make_shared<core::BackendWeightStore>(
        backend,
        backend_type,
        "stable_audio.foundation.t5_base.weights",
        weight_context_bytes == 0 ? kT5BaseWeightContextBytes : weight_context_bytes);
    weights.encoder.embed_tokens =
        weights.store->load_tensor(source, "shared.weight", weight_storage_type, {config.t5_vocab_size, config.t5_hidden_size});
    weights.encoder.relative_attention_bias =
        weights.store->load_f32_tensor(source, "encoder.block.0.layer.0.SelfAttention.relative_attention_bias.weight", {32, config.t5_attention_heads});
    weights.encoder.layers.reserve(static_cast<size_t>(config.t5_layers));
    for (int64_t layer = 0; layer < config.t5_layers; ++layer) {
        weights.encoder.layers.push_back(load_t5_layer(
            *weights.store,
            source,
            "encoder.block." + std::to_string(layer),
            config,
            weight_storage_type));
    }
    weights.encoder.final_layer_norm =
        weights.store->load_f32_tensor(source, "encoder.final_layer_norm.weight", {config.t5_hidden_size});
    weights.store->upload();
    return weights;
}

class FoundationConditionerRuntime::T5Graph {
public:
    T5Graph(
        core::ExecutionContext & execution,
        std::shared_ptr<const StableAudioAssets> assets,
        assets::TensorStorageType weight_storage_type,
        int64_t max_batch)
        : backend_(execution.backend()),
          backend_type_(execution.backend_type()),
          threads_(std::max(1, execution.config().threads)),
          assets_(std::move(assets)),
          max_batch_(max_batch),
          weights_(load_t5_base_runtime_weights(*assets_, backend_, backend_type_, 0, weight_storage_type)) {
        if (backend_ == nullptr) {
            throw std::runtime_error("Stable Audio Foundation T5Base backend initialization failed");
        }
        if (max_batch_ <= 0) {
            throw std::runtime_error("Stable Audio Foundation T5Base max_batch must be positive");
        }
        assets_->t5_weights->release_storage();
        build();
    }

    ~T5Graph() {
        if (backend_ != nullptr && graph_ != nullptr) {
            engine::core::release_backend_graph_resources(backend_type_, backend_, graph_);
        }
        if (gallocr_ != nullptr) {
            ggml_gallocr_free(gallocr_);
        }
    }

    std::vector<float> encode(const StableAudioTokenBatch & tokens) const {
        const auto total_start = Clock::now();
        const auto & config = assets_->config;
        if (tokens.batch <= 0 || tokens.batch > max_batch_) {
            throw std::runtime_error("Stable Audio Foundation T5Base token batch exceeds prepared max_batch");
        }
        if (tokens.tokens != config.prompt_max_length) {
            throw std::runtime_error("Stable Audio Foundation T5Base token length mismatch");
        }
        const auto input_start = Clock::now();
        std::vector<int32_t> padded_ids(static_cast<size_t>(max_batch_ * tokens.tokens), static_cast<int32_t>(config.t5_pad_token_id));
        for (int64_t b = 0; b < tokens.batch; ++b) {
            std::copy_n(
                tokens.input_ids.data() + static_cast<std::ptrdiff_t>(b * tokens.tokens),
                static_cast<size_t>(tokens.tokens),
                padded_ids.data() + static_cast<std::ptrdiff_t>(b * tokens.tokens));
        }
        core::write_tensor_i32(input_ids_, padded_ids);
        core::write_tensor_f32(attention_mask_, make_additive_attention_mask(tokens, max_batch_, config.t5_attention_heads));
        core::set_backend_threads(backend_, threads_);
        engine::debug::timing_log_scalar(
            "stable_audio.foundation.t5.input_upload_ms",
            engine::debug::elapsed_ms(input_start, Clock::now()));
        const auto compute_start = Clock::now();
        const ggml_status status = engine::core::compute_backend_graph(backend_, graph_, nullptr, "stable_audio.foundation.t5");
        if (status != GGML_STATUS_SUCCESS) {
            throw std::runtime_error("Stable Audio Foundation T5Base graph compute failed");
        }
        engine::debug::timing_log_scalar(
            "stable_audio.foundation.t5.graph.compute_ms",
            engine::debug::elapsed_ms(compute_start, Clock::now()));
        const auto output_start = Clock::now();
        const auto full = core::read_tensor_f32(output_);
        std::vector<float> out(static_cast<size_t>(tokens.batch * tokens.tokens * config.t5_hidden_size));
        const int64_t row_values = tokens.tokens * config.t5_hidden_size;
        for (int64_t b = 0; b < tokens.batch; ++b) {
            std::copy_n(
                full.data() + static_cast<std::ptrdiff_t>(b * row_values),
                static_cast<size_t>(row_values),
                out.data() + static_cast<std::ptrdiff_t>(b * row_values));
        }
        engine::debug::timing_log_scalar(
            "stable_audio.foundation.t5.output_read_ms",
            engine::debug::elapsed_ms(output_start, Clock::now()));
        engine::debug::timing_log_scalar(
            "stable_audio.foundation.t5.total_ms",
            engine::debug::elapsed_ms(total_start, Clock::now()));
        return out;
    }

private:
    void build() {
        const auto & config = assets_->config;
        ggml_init_params params{256ull * 1024ull * 1024ull, nullptr, true};
        ctx_.reset(ggml_init(params));
        if (ctx_ == nullptr) {
            throw std::runtime_error("Stable Audio Foundation T5Base ggml context initialization failed");
        }
        const int64_t tokens = config.prompt_max_length;
        input_ids_ = core::wrap_tensor(
            ggml_new_tensor_2d(ctx_.get(), GGML_TYPE_I32, tokens, max_batch_),
            core::TensorShape::from_dims({max_batch_, tokens}),
            GGML_TYPE_I32);
        relative_buckets_ = core::wrap_tensor(
            ggml_new_tensor_2d(ctx_.get(), GGML_TYPE_I32, tokens, tokens),
            core::TensorShape::from_dims({tokens, tokens}),
            GGML_TYPE_I32);
        attention_mask_ = core::wrap_tensor(
            ggml_new_tensor_4d(ctx_.get(), GGML_TYPE_F32, tokens, tokens, config.t5_attention_heads, max_batch_),
            core::TensorShape::from_dims({max_batch_, config.t5_attention_heads, tokens, tokens}),
            GGML_TYPE_F32);
        ggml_set_input(input_ids_.tensor);
        ggml_set_input(relative_buckets_.tensor);
        ggml_set_input(attention_mask_.tensor);
        core::ModuleBuildContext build_ctx{ctx_.get(), "stable_audio.foundation.t5", backend_type_};
        auto output = modules::T5BaseEncoderModule(t5_base_config(config))
                          .build(build_ctx, input_ids_, relative_buckets_, attention_mask_, weights_.encoder);
        output_ = output.tensor;
        ggml_set_output(output_);
        graph_ = ggml_new_graph_custom(ctx_.get(), 262144, false);
        ggml_build_forward_expand(graph_, output_);
        gallocr_ = ggml_gallocr_new(ggml_backend_get_default_buffer_type(backend_));
        if (gallocr_ == nullptr ||
            !ggml_gallocr_reserve(gallocr_, graph_) ||
            !ggml_gallocr_alloc_graph(gallocr_, graph_)) {
            throw std::runtime_error("Stable Audio Foundation T5Base backend buffer allocation failed");
        }
        core::write_tensor_i32(relative_buckets_, relative_buckets(tokens));
    }

    ggml_backend_t backend_ = nullptr;
    core::BackendType backend_type_ = core::BackendType::Cpu;
    int threads_ = 1;
    std::shared_ptr<const StableAudioAssets> assets_;
    int64_t max_batch_ = 1;
    T5BaseRuntimeWeights weights_;
    std::unique_ptr<ggml_context, GgmlContextDeleter> ctx_;
    core::TensorValue input_ids_;
    core::TensorValue relative_buckets_;
    core::TensorValue attention_mask_;
    ggml_tensor * output_ = nullptr;
    ggml_cgraph * graph_ = nullptr;
    ggml_gallocr_t gallocr_ = nullptr;
};

FoundationConditionerRuntime::FoundationConditionerRuntime(
    core::ExecutionContext & execution,
    std::shared_ptr<const StableAudioAssets> assets,
    assets::TensorStorageType weight_storage_type,
    int64_t max_batch)
    : assets_(require_assets(std::move(assets))),
      execution_(&execution),
      weight_storage_type_(weight_storage_type),
      max_batch_(max_batch),
      seconds_start_(load_number_conditioner(
          *assets_->model_weights,
          "conditioner.conditioners.seconds_start",
          assets_->config.cond_dim)),
      seconds_total_(load_number_conditioner(
          *assets_->model_weights,
          "conditioner.conditioners.seconds_total",
          assets_->config.cond_dim)) {
    if (execution_ == nullptr) {
        throw std::runtime_error("Stable Audio Foundation conditioner requires execution context");
    }
    if (max_batch_ <= 0) {
        throw std::runtime_error("Stable Audio Foundation conditioner max_batch must be positive");
    }
    if (assets_->config.cond_dim != assets_->config.t5_hidden_size) {
        throw std::runtime_error("Stable Audio Foundation conditioner expects T5 hidden size to match cond_dim");
    }
    if (assets_->config.global_cond_dim != 2 * assets_->config.cond_dim) {
        throw std::runtime_error("Stable Audio Foundation global conditioning dimension must be seconds_start + seconds_total");
    }
}

FoundationConditionerRuntime::~FoundationConditionerRuntime() = default;

void FoundationConditionerRuntime::prepare() const {
    if (!t5_graph_) {
        t5_graph_ = std::make_unique<T5Graph>(*execution_, assets_, weight_storage_type_, max_batch_);
    }
}

StableAudioConditioningInputs FoundationConditionerRuntime::encode(const StableAudioConditioningBatch & inputs) const {
    StableAudioConditioningInputs out;
    std::vector<float> normalized_start_seconds(static_cast<size_t>(inputs.prompt_tokens.batch), 0.0F);
    out.positive = encode_one(inputs.prompt_tokens, normalized_start_seconds, inputs.normalized_seconds);
    if (inputs.negative_prompt_tokens.batch > 0) {
        out.negative = encode_one(inputs.negative_prompt_tokens, normalized_start_seconds, inputs.normalized_seconds);
        out.has_negative = true;
    }
    return out;
}

StableAudioConditionedInput FoundationConditionerRuntime::encode_one(
    const StableAudioTokenBatch & tokens,
    const std::vector<float> & normalized_start_seconds,
    const std::vector<float> & normalized_total_seconds) const {
    validate_batch_seconds(tokens, normalized_start_seconds);
    validate_batch_seconds(tokens, normalized_total_seconds);
    const auto & config = assets_->config;
    if (tokens.tokens != config.prompt_max_length) {
        throw std::runtime_error("Stable Audio Foundation conditioner token length mismatch");
    }
    prepare();
    const auto prompt = t5_graph_->encode(tokens);
    if (static_cast<int64_t>(prompt.size()) != tokens.batch * tokens.tokens * config.cond_dim) {
        throw std::runtime_error("Stable Audio Foundation T5 output shape mismatch");
    }
    StableAudioConditionedInput out;
    out.batch = tokens.batch;
    out.cross_tokens = tokens.tokens + 2;
    out.cond_dim = config.cond_dim;
    out.cross_attention.assign(static_cast<size_t>(out.batch * out.cross_tokens * out.cond_dim), 0.0F);
    out.cross_attention_mask.assign(static_cast<size_t>(out.batch * out.cross_tokens), 0);
    out.global.assign(static_cast<size_t>(out.batch * config.global_cond_dim), 0.0F);
    for (int64_t b = 0; b < out.batch; ++b) {
        for (int64_t t = 0; t < tokens.tokens; ++t) {
            const bool keep = tokens.attention_mask[static_cast<size_t>(b * tokens.tokens + t)] != 0;
            out.cross_attention_mask[static_cast<size_t>(b * out.cross_tokens + t)] = keep ? 1 : 0;
            if (!keep) {
                continue;
            }
            std::copy_n(
                prompt.data() + static_cast<std::ptrdiff_t>((b * tokens.tokens + t) * out.cond_dim),
                static_cast<size_t>(out.cond_dim),
                out.cross_attention.data() + static_cast<std::ptrdiff_t>((b * out.cross_tokens + t) * out.cond_dim));
        }
        const auto start = number_embedding(seconds_start_, normalized_start_seconds[static_cast<size_t>(b)], out.cond_dim);
        const auto total = number_embedding(seconds_total_, normalized_total_seconds[static_cast<size_t>(b)], out.cond_dim);
        float * start_cross = out.cross_attention.data() +
            static_cast<std::ptrdiff_t>((b * out.cross_tokens + tokens.tokens) * out.cond_dim);
        float * total_cross = out.cross_attention.data() +
            static_cast<std::ptrdiff_t>((b * out.cross_tokens + tokens.tokens + 1) * out.cond_dim);
        std::copy_n(start.data(), static_cast<size_t>(out.cond_dim), start_cross);
        std::copy_n(total.data(), static_cast<size_t>(out.cond_dim), total_cross);
        out.cross_attention_mask[static_cast<size_t>(b * out.cross_tokens + tokens.tokens)] = 1;
        out.cross_attention_mask[static_cast<size_t>(b * out.cross_tokens + tokens.tokens + 1)] = 1;
        float * global = out.global.data() + static_cast<std::ptrdiff_t>(b * config.global_cond_dim);
        std::copy_n(start.data(), static_cast<size_t>(out.cond_dim), global);
        std::copy_n(total.data(), static_cast<size_t>(out.cond_dim), global + out.cond_dim);
    }
    return out;
}

}  // namespace engine::models::stable_audio::foundation
