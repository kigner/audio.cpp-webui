#include "engine/models/stable_audio/t5gemma.h"

#include "engine/framework/core/backend_weight_store.h"
#include "engine/framework/debug/profiler.h"

#include <ggml-alloc.h>

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>

namespace engine::models::stable_audio {
namespace {

using Clock = std::chrono::steady_clock;

constexpr size_t kT5WeightContextBytes = 1400ull * 1024ull * 1024ull;
constexpr float kMaskNegInf = -1.0e9F;

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

modules::T5GemmaEncoderLayerWeights load_layer(
    core::BackendWeightStore & store,
    const assets::TensorSource & source,
    const std::string & prefix,
    const StableAudioConfig & config,
    assets::TensorStorageType storage_type) {
    modules::T5GemmaEncoderLayerWeights weights;
    weights.pre_self_attn_norm = store.load_f32_tensor(source, prefix + ".pre_self_attn_layernorm.weight", {config.t5_hidden_size});
    weights.post_self_attn_norm = store.load_f32_tensor(source, prefix + ".post_self_attn_layernorm.weight", {config.t5_hidden_size});
    weights.pre_ff_norm = store.load_f32_tensor(source, prefix + ".pre_feedforward_layernorm.weight", {config.t5_hidden_size});
    weights.post_ff_norm = store.load_f32_tensor(source, prefix + ".post_feedforward_layernorm.weight", {config.t5_hidden_size});
    weights.q_proj = load_linear(
        store,
        source,
        prefix + ".self_attn.q_proj",
        storage_type,
        config.t5_attention_heads * config.t5_head_dim,
        config.t5_hidden_size,
        false);
    weights.k_proj = load_linear(
        store,
        source,
        prefix + ".self_attn.k_proj",
        storage_type,
        config.t5_kv_heads * config.t5_head_dim,
        config.t5_hidden_size,
        false);
    weights.v_proj = load_linear(
        store,
        source,
        prefix + ".self_attn.v_proj",
        storage_type,
        config.t5_kv_heads * config.t5_head_dim,
        config.t5_hidden_size,
        false);
    weights.o_proj = load_linear(
        store,
        source,
        prefix + ".self_attn.o_proj",
        storage_type,
        config.t5_hidden_size,
        config.t5_attention_heads * config.t5_head_dim,
        false);
    weights.gate_proj = load_linear(
        store,
        source,
        prefix + ".mlp.gate_proj",
        storage_type,
        config.t5_intermediate_size,
        config.t5_hidden_size,
        false);
    weights.up_proj = load_linear(
        store,
        source,
        prefix + ".mlp.up_proj",
        storage_type,
        config.t5_intermediate_size,
        config.t5_hidden_size,
        false);
    weights.down_proj = load_linear(
        store,
        source,
        prefix + ".mlp.down_proj",
        storage_type,
        config.t5_hidden_size,
        config.t5_intermediate_size,
        false);
    return weights;
}

modules::T5GemmaEncoderConfig encoder_config(const StableAudioConfig & config) {
    modules::T5GemmaEncoderConfig out;
    out.hidden_size = config.t5_hidden_size;
    out.layers = config.t5_layers;
    out.attention_heads = config.t5_attention_heads;
    out.kv_heads = config.t5_kv_heads;
    out.head_dim = config.t5_head_dim;
    out.intermediate_size = config.t5_intermediate_size;
    out.vocab_size = config.t5_vocab_size;
    out.rope_theta = config.t5_rope_theta;
    out.rms_norm_eps = config.t5_rms_norm_eps;
    out.attn_logit_softcap = config.t5_attn_logit_softcap;
    out.query_pre_attn_scalar = config.t5_query_pre_attn_scalar;
    out.scale_embeddings = true;
    return out;
}

std::vector<int32_t> positions(int64_t tokens) {
    std::vector<int32_t> out(static_cast<size_t>(tokens));
    for (int64_t i = 0; i < tokens; ++i) {
        out[static_cast<size_t>(i)] = static_cast<int32_t>(i);
    }
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
                    out[static_cast<size_t>(((b * heads + h) * tokens.tokens + q) * tokens.tokens + k)] = keep ? 0.0F : kMaskNegInf;
                }
            }
        }
    }
    return out;
}

}  // namespace

StableAudioT5Weights load_stable_audio_t5_weights(
    const StableAudioAssets & assets,
    ggml_backend_t backend,
    core::BackendType backend_type,
    size_t weight_context_bytes,
    assets::TensorStorageType weight_storage_type) {
    const auto & config = assets.config;
    const auto & source = *assets.t5_weights;
    StableAudioT5Weights weights;
    weights.store = std::make_shared<core::BackendWeightStore>(
        backend,
        backend_type,
        "stable_audio.t5gemma.weights",
        weight_context_bytes == 0 ? kT5WeightContextBytes : weight_context_bytes);
    weights.encoder.embed_tokens = weights.store->load_tensor(
        source,
        "model.encoder.embed_tokens.weight",
        weight_storage_type,
        {config.t5_vocab_size, config.t5_hidden_size});
    weights.encoder.layers.reserve(static_cast<size_t>(config.t5_layers));
    for (int64_t layer = 0; layer < config.t5_layers; ++layer) {
        weights.encoder.layers.push_back(load_layer(
            *weights.store,
            source,
            "model.encoder.layers." + std::to_string(layer),
            config,
            weight_storage_type));
    }
    weights.encoder.norm = weights.store->load_f32_tensor(source, "model.encoder.norm.weight", {config.t5_hidden_size});
    weights.store->upload();
    return weights;
}

core::TensorValue build_stable_audio_t5_encoder(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & input_ids,
    const core::TensorValue & positions,
    const core::TensorValue & additive_attention_mask,
    const StableAudioT5Weights & weights,
    const StableAudioConfig & config) {
    return modules::T5GemmaEncoderModule(encoder_config(config)).build(
        ctx,
        input_ids,
        positions,
        additive_attention_mask,
        weights.encoder);
}

class StableAudioT5EncoderRuntime::Graph {
public:
    Graph(
        core::ExecutionContext & execution,
        std::shared_ptr<const StableAudioAssets> assets,
        assets::TensorStorageType weight_storage_type,
        int64_t max_batch)
        : backend_(execution.backend()),
          backend_type_(execution.backend_type()),
          threads_(std::max(1, execution.config().threads)),
          assets_(std::move(assets)),
          max_batch_(max_batch),
          weights_(load_stable_audio_t5_weights(*assets_, backend_, backend_type_, 0, weight_storage_type)) {
        if (backend_ == nullptr) {
            throw std::runtime_error("Stable Audio T5 backend initialization failed");
        }
        if (max_batch_ <= 0) {
            throw std::runtime_error("Stable Audio T5 max_batch must be positive");
        }
        assets_->t5_weights->release_storage();
        build();
    }

    ~Graph() {
        if (backend_ != nullptr && graph_ != nullptr) {
            engine::core::release_backend_graph_resources(backend_type_, backend_, graph_);
        }
        if (gallocr_ != nullptr) {
            ggml_gallocr_free(gallocr_);
        }
    }

    StableAudioT5Encoding encode(const StableAudioTokenBatch & tokens) const {
        const auto total_start = Clock::now();
        const auto & config = assets_->config;
        if (tokens.batch <= 0 || tokens.batch > max_batch_) {
            throw std::runtime_error("Stable Audio T5 token batch exceeds prepared max_batch");
        }
        if (tokens.tokens != config.prompt_max_length) {
            throw std::runtime_error("Stable Audio T5 token length must match configured prompt_max_length");
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
        core::write_tensor_i32(positions_, positions(tokens.tokens));
        const auto mask = make_additive_attention_mask(tokens, max_batch_, config.t5_attention_heads);
        core::write_tensor_f32(attention_mask_, mask);
        core::set_backend_threads(backend_, threads_);
        engine::debug::timing_log_scalar("stable_audio.t5.input_upload_ms", engine::debug::elapsed_ms(input_start, Clock::now()));
        const auto compute_start = Clock::now();
        const ggml_status status = engine::core::compute_backend_graph(backend_, graph_, nullptr, "stable_audio.t5");
        if (status != GGML_STATUS_SUCCESS) {
            throw std::runtime_error("Stable Audio T5 graph compute failed");
        }
        engine::debug::timing_log_scalar("stable_audio.t5.graph.compute_ms", engine::debug::elapsed_ms(compute_start, Clock::now()));
        const auto output_start = Clock::now();
        const auto full = core::read_tensor_f32(output_);
        StableAudioT5Encoding out;
        out.batch = tokens.batch;
        out.tokens = tokens.tokens;
        out.hidden_size = config.t5_hidden_size;
        out.values.resize(static_cast<size_t>(tokens.batch * tokens.tokens * config.t5_hidden_size));
        const int64_t row_values = tokens.tokens * config.t5_hidden_size;
        for (int64_t b = 0; b < tokens.batch; ++b) {
            std::copy_n(
                full.data() + static_cast<std::ptrdiff_t>(b * row_values),
                static_cast<size_t>(row_values),
                out.values.data() + static_cast<std::ptrdiff_t>(b * row_values));
        }
        engine::debug::timing_log_scalar("stable_audio.t5.output_read_ms", engine::debug::elapsed_ms(output_start, Clock::now()));
        engine::debug::timing_log_scalar("stable_audio.t5.total_ms", engine::debug::elapsed_ms(total_start, Clock::now()));
        return out;
    }

private:
    void build() {
        const auto & config = assets_->config;
        ggml_init_params params{256ull * 1024ull * 1024ull, nullptr, true};
        ctx_.reset(ggml_init(params));
        if (ctx_ == nullptr) {
            throw std::runtime_error("Stable Audio T5 ggml context initialization failed");
        }
        const int64_t tokens = config.prompt_max_length;
        input_ids_ = core::wrap_tensor(
            ggml_new_tensor_2d(ctx_.get(), GGML_TYPE_I32, tokens, max_batch_),
            core::TensorShape::from_dims({max_batch_, tokens}),
            GGML_TYPE_I32);
        positions_ = core::wrap_tensor(
            ggml_new_tensor_1d(ctx_.get(), GGML_TYPE_I32, tokens),
            core::TensorShape::from_dims({tokens}),
            GGML_TYPE_I32);
        attention_mask_ = core::wrap_tensor(
            ggml_new_tensor_4d(ctx_.get(), GGML_TYPE_F32, tokens, tokens, config.t5_attention_heads, max_batch_),
            core::TensorShape::from_dims({max_batch_, config.t5_attention_heads, tokens, tokens}),
            GGML_TYPE_F32);
        ggml_set_input(input_ids_.tensor);
        ggml_set_input(positions_.tensor);
        ggml_set_input(attention_mask_.tensor);
        core::ModuleBuildContext build_ctx{ctx_.get(), "stable_audio.t5", backend_type_};
        auto output = build_stable_audio_t5_encoder(build_ctx, input_ids_, positions_, attention_mask_, weights_, config);
        output_ = output.tensor;
        ggml_set_output(output_);
        graph_ = ggml_new_graph_custom(ctx_.get(), 262144, false);
        ggml_build_forward_expand(graph_, output_);
        gallocr_ = ggml_gallocr_new(ggml_backend_get_default_buffer_type(backend_));
        if (gallocr_ == nullptr ||
            !ggml_gallocr_reserve(gallocr_, graph_) ||
            !ggml_gallocr_alloc_graph(gallocr_, graph_)) {
            throw std::runtime_error("Stable Audio T5 backend buffer allocation failed");
        }
        core::write_tensor_i32(positions_, positions(tokens));
    }

    ggml_backend_t backend_ = nullptr;
    core::BackendType backend_type_ = core::BackendType::Cpu;
    int threads_ = 1;
    std::shared_ptr<const StableAudioAssets> assets_;
    int64_t max_batch_ = 1;
    StableAudioT5Weights weights_;
    std::unique_ptr<ggml_context, GgmlContextDeleter> ctx_;
    core::TensorValue input_ids_;
    core::TensorValue positions_;
    core::TensorValue attention_mask_;
    ggml_tensor * output_ = nullptr;
    ggml_cgraph * graph_ = nullptr;
    ggml_gallocr_t gallocr_ = nullptr;
};

StableAudioT5EncoderRuntime::StableAudioT5EncoderRuntime(
    core::ExecutionContext & execution,
    std::shared_ptr<const StableAudioAssets> assets,
    assets::TensorStorageType weight_storage_type,
    int64_t max_batch)
    : execution_(&execution),
      assets_(std::move(assets)),
      weight_storage_type_(weight_storage_type),
      max_batch_(max_batch) {
    if (execution_ == nullptr) {
        throw std::runtime_error("Stable Audio T5 runtime requires execution context");
    }
    if (assets_ == nullptr) {
        throw std::runtime_error("Stable Audio T5 runtime requires assets");
    }
    if (max_batch_ <= 0) {
        throw std::runtime_error("Stable Audio T5 max_batch must be positive");
    }
}

StableAudioT5EncoderRuntime::~StableAudioT5EncoderRuntime() = default;

void StableAudioT5EncoderRuntime::prepare() const {
    if (!graph_) {
        graph_ = std::make_unique<Graph>(*execution_, assets_, weight_storage_type_, max_batch_);
    }
}

StableAudioT5Encoding StableAudioT5EncoderRuntime::encode(const StableAudioTokenBatch & tokens) const {
    prepare();
    return graph_->encode(tokens);
}

void StableAudioT5EncoderRuntime::release_runtime_graphs() const {
    graph_.reset();
}

}  // namespace engine::models::stable_audio
