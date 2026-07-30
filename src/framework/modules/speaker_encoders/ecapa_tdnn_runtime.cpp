#include "engine/framework/modules/speaker_encoders/ecapa_tdnn_runtime.h"

#include "engine/framework/audio/conversion.h"
#include "engine/framework/audio/dsp.h"
#include "engine/framework/core/backend.h"
#include "engine/framework/core/backend_weight_store.h"
#include "engine/framework/debug/profiler.h"
#include "engine/framework/modules/activation_modules.h"
#include "engine/framework/modules/conditioning_modules.h"
#include "engine/framework/modules/conv_modules.h"
#include "engine/framework/modules/norm_modules.h"
#include "engine/framework/modules/optimizations/fast_conv_modules.h"
#include "engine/framework/modules/primitive_modules.h"
#include "engine/framework/modules/structural_modules.h"
#include "engine/framework/modules/speaker_encoders/ecapa_tdnn_speaker.h"

#include <ggml.h>
#include <ggml-backend.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace engine::modules::ecapa_tdnn {

struct BackendConv1dWeights {
    int64_t out_channels = 0;
    int64_t in_channels = 0;
    int64_t kernel = 0;
    int64_t stride = 1;
    int64_t padding = 0;
    int64_t dilation = 1;
    bool use_bias = true;
    modules::Conv1dWeights conv;
};

struct BackendTDNNBlockWeights {
    BackendConv1dWeights conv;
    modules::BatchNorm1dEvalWeights norm;
    int64_t norm_channels = 0;
};

struct BackendRes2NetBlockWeights {
    std::vector<BackendTDNNBlockWeights> blocks;
    int64_t scale = 8;
    int64_t width = 0;
};

struct BackendSEBlockWeights {
    BackendConv1dWeights conv1;
    BackendConv1dWeights conv2;
};

struct BackendSERes2NetBlockWeights {
    BackendTDNNBlockWeights tdnn1;
    BackendRes2NetBlockWeights res2net;
    BackendTDNNBlockWeights tdnn2;
    BackendSEBlockWeights se;
};

struct BackendAspWeights {
    BackendTDNNBlockWeights tdnn;
    BackendConv1dWeights tdnn_x_conv;
    BackendConv1dWeights tdnn_stats_conv;
    modules::BatchNorm1dEvalWeights tdnn_norm;
    int64_t tdnn_norm_channels = 0;
    BackendConv1dWeights conv;
};

struct EcapaBackendWeights {
    std::shared_ptr<core::BackendWeightStore> store;
    BackendTDNNBlockWeights block0;
    std::vector<BackendSERes2NetBlockWeights> se_blocks;
    BackendTDNNBlockWeights mfa;
    BackendAspWeights asp;
    modules::BatchNorm1dEvalWeights asp_bn;
    int64_t asp_bn_channels = 0;
    BackendConv1dWeights fc;
    core::TensorValue stats_eps;
};

namespace {


constexpr int64_t kFeatureDim = 80;
constexpr int64_t kEmbeddingDim = 192;
constexpr float kBatchNormEps = 1.0e-5f;
constexpr float kStatsEps = 1.0e-12f;
constexpr int kTargetSampleRate = 16000;
constexpr int kNfft = 400;
constexpr int kWinLength = 400;
constexpr int kHopLength = 160;
constexpr int kFreqBins = kNfft / 2 + 1;
constexpr float kFbankAmin = 1.0e-10f;
constexpr float kFbankTopDb = 80.0f;
constexpr double kPi = 3.14159265358979323846264338327950288;

using Clock = std::chrono::steady_clock;

struct GgmlContextDeleter {
    void operator()(ggml_context * ctx) const {
        if (ctx != nullptr) {
            ggml_free(ctx);
        }
    }
};

core::TensorValue store_weight(
    core::BackendWeightStore & store,
    const assets::TensorSource & source,
    const Conv1dWeights & tensor,
    assets::TensorStorageType storage_type) {
    return store.load_tensor_as_shape(
        source,
        tensor.weight_name,
        storage_type,
        tensor.weight_source_shape,
        core::TensorShape::from_dims({tensor.out_channels, tensor.in_channels, tensor.kernel}));
}

core::TensorValue store_f32(
    core::BackendWeightStore & store,
    const core::TensorShape & shape,
    const std::vector<float> & values) {
    return store.make_f32(shape, values);
}

BackendConv1dWeights make_backend_conv(
    core::BackendWeightStore & store,
    const assets::TensorSource & source,
    const Conv1dWeights & conv,
    assets::TensorStorageType storage_type) {
    BackendConv1dWeights weights;
    weights.out_channels = conv.out_channels;
    weights.in_channels = conv.in_channels;
    weights.kernel = conv.kernel;
    weights.stride = conv.stride;
    weights.padding = conv.padding;
    weights.dilation = conv.dilation;
    weights.use_bias = conv.use_bias;
    weights.conv.weight = store_weight(store, source, conv, storage_type);
    if (conv.use_bias) {
        weights.conv.bias = store.load_f32_tensor(source, *conv.bias_name, {conv.out_channels});
    }
    return weights;
}

std::vector<float> read_f32_tensor_values(
    const assets::TensorSource & source,
    const std::string & name,
    const std::vector<int64_t> & expected_shape) {
    const auto tensor = source.require_f32_tensor(name);
    if (tensor.shape.rank != expected_shape.size()) {
        throw std::runtime_error("ECAPA tensor rank mismatch: " + name);
    }
    for (size_t i = 0; i < expected_shape.size(); ++i) {
        if (tensor.shape.dims[i] != expected_shape[i]) {
            throw std::runtime_error("ECAPA tensor shape mismatch: " + name);
        }
    }
    return tensor.values;
}

std::pair<BackendConv1dWeights, BackendConv1dWeights> make_backend_split_pool_conv(
    core::BackendWeightStore & store,
    const assets::TensorSource & source,
    const Conv1dWeights & conv,
    int64_t feature_channels,
    assets::TensorStorageType storage_type) {
    if (conv.kernel != 1 || conv.stride != 1 || conv.padding != 0 || conv.dilation != 1 ||
        conv.in_channels != feature_channels * 3) {
        throw std::runtime_error("ECAPA attentive pooling projection has unsupported shape");
    }
    auto values = read_f32_tensor_values(source, conv.weight_name, conv.weight_source_shape);
    std::vector<float> x_values(static_cast<size_t>(conv.out_channels * feature_channels), 0.0f);
    std::vector<float> stats_values(static_cast<size_t>(conv.out_channels * feature_channels * 2), 0.0f);
    for (int64_t out = 0; out < conv.out_channels; ++out) {
        for (int64_t in = 0; in < conv.in_channels; ++in) {
            const float value = values[static_cast<size_t>(out * conv.in_channels + in)];
            if (in < feature_channels) {
                x_values[static_cast<size_t>(out * feature_channels + in)] = value;
            } else {
                stats_values[static_cast<size_t>(out * feature_channels * 2 + (in - feature_channels))] = value;
            }
        }
    }

    BackendConv1dWeights x_conv;
    x_conv.out_channels = conv.out_channels;
    x_conv.in_channels = feature_channels;
    x_conv.kernel = 1;
    x_conv.stride = 1;
    x_conv.padding = 0;
    x_conv.dilation = 1;
    x_conv.use_bias = false;
    x_conv.conv.weight = store.make_from_f32(
        core::TensorShape::from_dims({conv.out_channels, feature_channels, 1}),
        storage_type,
        std::move(x_values));

    BackendConv1dWeights stats_conv;
    stats_conv.out_channels = conv.out_channels;
    stats_conv.in_channels = feature_channels * 2;
    stats_conv.kernel = 1;
    stats_conv.stride = 1;
    stats_conv.padding = 0;
    stats_conv.dilation = 1;
    stats_conv.use_bias = conv.use_bias;
    stats_conv.conv.weight = store.make_from_f32(
        core::TensorShape::from_dims({conv.out_channels, feature_channels * 2, 1}),
        storage_type,
        std::move(stats_values));
    if (conv.use_bias) {
        stats_conv.conv.bias = store.load_f32_tensor(source, *conv.bias_name, {conv.out_channels});
    }
    return {std::move(x_conv), std::move(stats_conv)};
}

modules::BatchNorm1dEvalWeights bind_batch_norm_weights(
    const BatchNorm1dWeights & bn,
    core::BackendWeightStore & store) {
    const int64_t channels = static_cast<int64_t>(bn.running_mean.size());
    std::vector<float> scale(static_cast<size_t>(channels), 0.0f);
    std::vector<float> bias(static_cast<size_t>(channels), 0.0f);
    for (int64_t i = 0; i < channels; ++i) {
        const float inv_std = 1.0f / std::sqrt(bn.running_var[static_cast<size_t>(i)] + kBatchNormEps);
        scale[static_cast<size_t>(i)] = bn.weight[static_cast<size_t>(i)] * inv_std;
        bias[static_cast<size_t>(i)] = bn.bias[static_cast<size_t>(i)] - bn.running_mean[static_cast<size_t>(i)] * scale[static_cast<size_t>(i)];
    }
    return {
        store_f32(store, core::TensorShape::from_dims({channels}), scale),
        store_f32(store, core::TensorShape::from_dims({channels}), bias),
    };
}

BackendTDNNBlockWeights make_backend_tdnn(
    core::BackendWeightStore & store,
    const assets::TensorSource & source,
    const TDNNBlockWeights & block,
    assets::TensorStorageType storage_type) {
    return {
        make_backend_conv(store, source, block.conv, storage_type),
        bind_batch_norm_weights(block.norm, store),
        static_cast<int64_t>(block.norm.running_mean.size()),
    };
}

std::shared_ptr<const EcapaBackendWeights> load_backend_weights(
    const EcapaWeights & weights,
    ggml_backend_t backend,
    core::BackendType backend_type,
    assets::TensorStorageType storage_type) {
    auto out = std::make_shared<EcapaBackendWeights>();
    out->store = std::make_shared<core::BackendWeightStore>(
        backend, backend_type, "ecapa_tdnn_spk.weights", 256ull * 1024ull * 1024ull);
    auto & store = *out->store;
    if (weights.source == nullptr) {
        throw std::runtime_error("ECAPA weights require a tensor source");
    }
    const auto & source = *weights.source;
    out->block0 = make_backend_tdnn(store, source, weights.block0, storage_type);
    out->se_blocks.reserve(weights.se_blocks.size());
    for (const auto & block : weights.se_blocks) {
        BackendSERes2NetBlockWeights dst;
        dst.tdnn1 = make_backend_tdnn(store, source, block.tdnn1, storage_type);
        dst.res2net.scale = block.res2net.scale;
        dst.res2net.width = block.res2net.width;
        dst.res2net.blocks.reserve(block.res2net.blocks.size());
        for (const auto & res2 : block.res2net.blocks) {
            dst.res2net.blocks.push_back(make_backend_tdnn(store, source, res2, storage_type));
        }
        dst.tdnn2 = make_backend_tdnn(store, source, block.tdnn2, storage_type);
        dst.se.conv1 = make_backend_conv(store, source, block.se.conv1, storage_type);
        dst.se.conv2 = make_backend_conv(store, source, block.se.conv2, storage_type);
        out->se_blocks.push_back(std::move(dst));
    }
    out->mfa = make_backend_tdnn(store, source, weights.mfa, storage_type);
    if (engine::core::uses_host_graph_plan(backend)) {
        auto [tdnn_x_conv, tdnn_stats_conv] = make_backend_split_pool_conv(
            store,
            source,
            weights.asp.tdnn.conv,
            weights.mfa.conv.out_channels,
            storage_type);
        out->asp.tdnn_x_conv = std::move(tdnn_x_conv);
        out->asp.tdnn_stats_conv = std::move(tdnn_stats_conv);
        out->asp.tdnn_norm = bind_batch_norm_weights(weights.asp.tdnn.norm, store);
        out->asp.tdnn_norm_channels = static_cast<int64_t>(weights.asp.tdnn.norm.running_mean.size());
    } else {
        out->asp.tdnn = make_backend_tdnn(store, source, weights.asp.tdnn, storage_type);
    }
    out->asp.conv = make_backend_conv(store, source, weights.asp.conv, storage_type);
    out->asp_bn = bind_batch_norm_weights(weights.asp_bn, store);
    out->asp_bn_channels = static_cast<int64_t>(weights.asp_bn.running_mean.size());
    out->fc = make_backend_conv(store, source, weights.fc, storage_type);
    out->stats_eps = store_f32(store, core::TensorShape::from_dims({1, 1, 1}), std::vector<float>{kStatsEps});
    store.upload();
    weights.source->release_storage();
    return out;
}

std::shared_ptr<const EcapaWeights> require_weights(std::shared_ptr<const EcapaWeights> weights) {
    if (weights == nullptr) {
        throw std::runtime_error("ECAPA runtime requires weights");
    }
    return weights;
}

core::TensorValue batch_norm_1d(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & x,
    const modules::BatchNorm1dEvalWeights & bn,
    int64_t channels) {
    return modules::BatchNorm1dEvalModule({channels}).build(
        ctx,
        x,
        bn);
}

core::TensorValue conv1d(
    core::ModuleBuildContext & ctx,
    core::TensorValue x,
    const BackendConv1dWeights & conv) {
    if (x.shape.dims[1] != conv.in_channels) {
        throw std::runtime_error(
            "ECAPA conv1d channel mismatch: got=" + std::to_string(x.shape.dims[1]) +
            " expected=" + std::to_string(conv.in_channels));
    }
    if (conv.padding > 0) {
        x = modules::ReflectPad1dModule({conv.padding, conv.padding}).build(ctx, x);
    }
    return modules::FastConv1dModule({
        conv.in_channels,
        conv.out_channels,
        conv.kernel,
        static_cast<int>(conv.stride),
        0,
        static_cast<int>(conv.dilation),
        conv.use_bias,
    }, modules::FastConv1dKind::MinittsFast1dIm2col).build(ctx, x, conv.conv);
}

core::TensorValue tdnn_block(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & x,
    const BackendTDNNBlockWeights & block) {
    auto y = conv1d(ctx, x, block.conv);
    y = modules::ReluModule{}.build(ctx, y);
    y = batch_norm_1d(ctx, y, block.norm, block.norm_channels);
    return y;
}

core::TensorValue concat_channels(core::ModuleBuildContext & ctx, const core::TensorValue & a, const core::TensorValue & b) {
    return modules::ConcatModule({1}).build(ctx, a, b);
}

core::TensorValue se_block(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & x,
    const BackendSEBlockWeights & se) {
    return modules::SqueezeExcite1dModule({se.conv2.out_channels, se.conv1.out_channels, true}).build(
        ctx,
        x,
        {se.conv1.conv, se.conv2.conv});
}

core::TensorValue view_channels(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & x,
    int64_t c0,
    int64_t c1) {
    return modules::SliceModule({1, c0, c1 - c0}).build(ctx, x);
}

core::TensorValue se_res2net_block(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & x,
    const BackendSERes2NetBlockWeights & block) {
    auto residual = x;
    auto y = tdnn_block(ctx, x, block.tdnn1);
    core::TensorValue merged;
    core::TensorValue prev;
    for (int64_t i = 0; i < block.res2net.scale; ++i) {
        auto chunk = view_channels(ctx, y, i * block.res2net.width, (i + 1) * block.res2net.width);
        core::TensorValue out;
        if (i == 0) {
            out = chunk;
        } else if (i == 1) {
            out = tdnn_block(ctx, chunk, block.res2net.blocks[0]);
        } else {
            auto summed = modules::ResidualAddModule{}.build(ctx, chunk, prev);
            out = tdnn_block(ctx, summed, block.res2net.blocks[static_cast<size_t>(i - 1)]);
        }
        prev = out;
        merged = merged.valid() ? concat_channels(ctx, merged, out) : out;
    }
    y = tdnn_block(ctx, merged, block.tdnn2);
    y = se_block(ctx, y, block.se);
    return modules::ResidualAddModule{}.build(ctx, y, residual);
}

core::TensorValue attentive_statistics_pool(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & x,
    const BackendAspWeights & asp,
    core::TensorValue eps) {
    auto mean = modules::ReduceMeanModule({static_cast<int>(x.shape.rank - 1)}).build(ctx, x);
    auto mean_rep = modules::RepeatModule({x.shape}).build(ctx, mean);
    auto centered = core::wrap_tensor(ggml_sub(ctx.ggml, x.tensor, mean_rep.tensor), x.shape, GGML_TYPE_F32);
    auto centered_sq = modules::MulModule{}.build(ctx, centered, centered);
    auto variance = modules::ReduceMeanModule({static_cast<int>(centered_sq.shape.rank - 1)}).build(ctx, centered_sq);
    auto eps_stats = modules::RepeatModule({variance.shape}).build(ctx, eps);
    auto std = modules::SqrtModule{}.build(ctx, modules::AddModule{}.build(ctx, variance, eps_stats));
    core::TensorValue attn;
    if (core::uses_host_graph_plan(ctx.backend_type)) {
        auto stats = concat_channels(ctx, mean, std);
        attn = conv1d(ctx, x, asp.tdnn_x_conv);
        auto stats_attn = conv1d(ctx, stats, asp.tdnn_stats_conv);
        auto stats_attn_rep = modules::RepeatModule({attn.shape}).build(ctx, stats_attn);
        attn = modules::AddModule{}.build(ctx, attn, stats_attn_rep);
        attn = modules::ReluModule{}.build(ctx, attn);
        attn = batch_norm_1d(ctx, attn, asp.tdnn_norm, asp.tdnn_norm_channels);
    } else {
        auto std_rep = modules::RepeatModule({x.shape}).build(ctx, std);
        auto gc = concat_channels(ctx, concat_channels(ctx, x, mean_rep), std_rep);
        attn = tdnn_block(ctx, gc, asp.tdnn);
    }
    attn = modules::TanhModule{}.build(ctx, attn);
    attn = conv1d(ctx, attn, asp.conv);
    auto weights = modules::SoftmaxModule{}.build(ctx, attn);
    auto weighted_x = modules::MulModule{}.build(ctx, x, weights);
    auto mean_att = modules::ReduceSumModule({static_cast<int>(weighted_x.shape.rank - 1)}).build(ctx, weighted_x);
    auto mean_att_rep = modules::RepeatModule({x.shape}).build(ctx, mean_att);
    auto diff = core::wrap_tensor(ggml_sub(ctx.ggml, x.tensor, mean_att_rep.tensor), x.shape, GGML_TYPE_F32);
    auto diff_sq = modules::MulModule{}.build(ctx, diff, diff);
    auto weighted_var = modules::MulModule{}.build(ctx, diff_sq, weights);
    auto var_att = modules::ReduceSumModule({static_cast<int>(weighted_var.shape.rank - 1)}).build(ctx, weighted_var);
    eps_stats = modules::RepeatModule({var_att.shape}).build(ctx, eps);
    auto std_att = modules::SqrtModule{}.build(ctx, modules::AddModule{}.build(ctx, var_att, eps_stats));
    return concat_channels(ctx, mean_att, std_att);
}

core::TensorValue build_ecapa_graph(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & input,
    const EcapaBackendWeights & weights) {
    auto x = tdnn_block(ctx, input, weights.block0);
    std::vector<core::TensorValue> xl;
    xl.push_back(x);
    for (size_t i = 0; i < weights.se_blocks.size(); ++i) {
        x = se_res2net_block(ctx, x, weights.se_blocks[i]);
        xl.push_back(x);
    }
    auto cat = concat_channels(ctx, xl[1], xl[2]);
    cat = concat_channels(ctx, cat, xl[3]);
    x = tdnn_block(ctx, cat, weights.mfa);
    x = attentive_statistics_pool(ctx, x, weights.asp, weights.stats_eps);
    x = batch_norm_1d(ctx, x, weights.asp_bn, weights.asp_bn_channels);
    x = conv1d(ctx, x, weights.fc);
    return x;
}

}  // namespace

class EcapaRuntime::Graph {
  public:
    Graph(
        std::shared_ptr<const EcapaWeights> weights,
        std::shared_ptr<const EcapaBackendWeights> backend_weights,
        int64_t frames,
        core::ExecutionContext & execution_context)
        : weights_(std::move(weights)),
          backend_weights_(std::move(backend_weights)),
          frames_(frames),
          backend_(execution_context.backend()),
          compute_threads_(std::max(1, execution_context.config().threads)) {
        const auto build_start = Clock::now();
        if (frames_ <= 0) {
            throw std::runtime_error("invalid ECAPA graph shape");
        }
        if (backend_ == nullptr) {
            throw std::runtime_error("ECAPA execution backend is not initialized");
        }

        ggml_init_params params{
            /*.mem_size   =*/ 256ull * 1024ull * 1024ull,
            /*.mem_buffer =*/ nullptr,
            /*.no_alloc   =*/ true,
        };
        ctx_.reset(ggml_init(params));
        if (ctx_ == nullptr) {
            throw std::runtime_error("failed to initialize backend ggml context");
        }

        core::ModuleBuildContext build_ctx{
            ctx_.get(),
            "ecapa_tdnn_spk",
            execution_context.backend_type(),
        };
        auto input = core::make_tensor(build_ctx, GGML_TYPE_F32, core::TensorShape::from_dims({1, kFeatureDim, frames_}));
        input_ = input.tensor;
        output_ = build_ecapa_graph(build_ctx, input, *backend_weights_).tensor;
        ggml_set_output(output_);
        graph_ = ggml_new_graph_custom(ctx_.get(), 4096, false);
        ggml_build_forward_expand(graph_, output_);

        buffer_ = ggml_backend_alloc_ctx_tensors(ctx_.get(), backend_);
        if (buffer_ == nullptr) {
            throw std::runtime_error("failed to allocate ECAPA backend graph");
        }
        if (engine::core::uses_host_graph_plan(backend_)) {
            const auto plan_start = Clock::now();
            plan_ = engine::core::create_backend_graph_plan_if_host(backend_, graph_);
            plan_create_ms_ = engine::debug::elapsed_ms(plan_start, Clock::now());
            if (plan_ == nullptr) {
                throw std::runtime_error("failed to create ECAPA graph plan");
            }
        }
        const auto build_end = Clock::now();
        debug::timing_log_scalar("ecapa.graph.build_ms", engine::debug::elapsed_ms(build_start, build_end));
        debug::timing_log_scalar("ecapa.graph.plan_create_ms", plan_create_ms_);
    }

    ~Graph() {
        if (plan_ != nullptr) {
            engine::core::free_backend_graph_plan(backend_, plan_);
        }
        if (buffer_ != nullptr) {
            ggml_backend_buffer_free(buffer_);
        }
    }

    bool matches(const EcapaWeights & weights, int64_t frames, ggml_backend_t backend, int threads) const {
        return weights_ && weights_.get() == &weights && frames_ == frames && backend_ == backend && compute_threads_ == std::max(1, threads);
    }

    std::vector<float> run(const std::vector<float> & features) {
        upload_input(features);
        compute();
        std::vector<float> embedding(static_cast<size_t>(kEmbeddingDim), 0.0f);
        ggml_backend_tensor_get(output_, embedding.data(), 0, embedding.size() * sizeof(float));
        return embedding;
    }

  private:
    void upload_input(const std::vector<float> & features) {
        if (features.size() != static_cast<size_t>(frames_ * kFeatureDim)) {
            throw std::runtime_error("feature tensor size mismatch");
        }
        if (channels_first_.size() != features.size()) {
            channels_first_.resize(features.size());
        }
        for (int64_t t = 0; t < frames_; ++t) {
            for (int64_t c = 0; c < kFeatureDim; ++c) {
                channels_first_[static_cast<size_t>(t + frames_ * c)] = features[static_cast<size_t>(t * kFeatureDim + c)];
            }
        }
        ggml_backend_tensor_set(input_, channels_first_.data(), 0, channels_first_.size() * sizeof(float));
    }

    void compute() {
        core::set_backend_threads(backend_, compute_threads_);
        const auto compute_start = Clock::now();
        const ggml_status status = core::compute_backend_graph(backend_, graph_, plan_);
        ggml_backend_synchronize(backend_);
        const auto compute_end = Clock::now();
        if (status != GGML_STATUS_SUCCESS) {
            throw std::runtime_error("ECAPA backend graph compute failed");
        }
        debug::timing_log_scalar("ecapa.graph.compute_ms", engine::debug::elapsed_ms(compute_start, compute_end));
    }

    std::shared_ptr<const EcapaWeights> weights_;
    std::shared_ptr<const EcapaBackendWeights> backend_weights_;
    int64_t frames_ = 0;
    std::unique_ptr<ggml_context, GgmlContextDeleter> ctx_;
    ggml_tensor * input_ = nullptr;
    ggml_tensor * output_ = nullptr;
    ggml_cgraph * graph_ = nullptr;
    ggml_backend_t backend_ = nullptr;
    int compute_threads_ = 1;
    ggml_backend_buffer_t buffer_ = nullptr;
    ggml_backend_graph_plan_t plan_ = nullptr;
    double plan_create_ms_ = 0.0;
    std::vector<float> channels_first_;
};

namespace {

float hz_to_mel(float hz) {
    return 2595.0f * std::log10(1.0f + hz / 700.0f);
}

float mel_to_hz(float mel) {
    return 700.0f * (std::pow(10.0f, mel / 2595.0f) - 1.0f);
}

const std::vector<float> & hamming_window() {
    static const std::vector<float> values = []() {
        std::vector<float> out(static_cast<size_t>(kWinLength), 0.0f);
        for (int i = 0; i < kWinLength; ++i) {
            out[static_cast<size_t>(i)] = 0.54f - 0.46f * std::cos(2.0 * kPi * static_cast<double>(i) / static_cast<double>(kWinLength));
        }
        return out;
    }();
    return values;
}

const std::vector<float> & speechbrain_fbank_matrix() {
    static const std::vector<float> values = []() {
        const float mel_min = hz_to_mel(0.0f);
        const float mel_max = hz_to_mel(static_cast<float>(kTargetSampleRate / 2));
        std::vector<float> mel_points(static_cast<size_t>(kFeatureDim + 2), 0.0f);
        for (int64_t i = 0; i < kFeatureDim + 2; ++i) {
            mel_points[static_cast<size_t>(i)] =
                mel_min + (mel_max - mel_min) * static_cast<float>(i) / static_cast<float>(kFeatureDim + 1);
        }
        std::vector<float> hz_points(static_cast<size_t>(kFeatureDim + 2), 0.0f);
        for (int64_t i = 0; i < kFeatureDim + 2; ++i) {
            hz_points[static_cast<size_t>(i)] = mel_to_hz(mel_points[static_cast<size_t>(i)]);
        }
        std::vector<float> all_freqs(static_cast<size_t>(kFreqBins), 0.0f);
        for (int64_t i = 0; i < kFreqBins; ++i) {
            all_freqs[static_cast<size_t>(i)] =
                static_cast<float>(kTargetSampleRate / 2) * static_cast<float>(i) / static_cast<float>(kFreqBins - 1);
        }
        std::vector<float> matrix(static_cast<size_t>(kFeatureDim * kFreqBins), 0.0f);
        for (int64_t mel = 0; mel < kFeatureDim; ++mel) {
            const float center = hz_points[static_cast<size_t>(mel + 1)];
            const float band = hz_points[static_cast<size_t>(mel + 1)] - hz_points[static_cast<size_t>(mel)];
            for (int64_t f = 0; f < kFreqBins; ++f) {
                const float slope = (all_freqs[static_cast<size_t>(f)] - center) / band;
                const float left = slope + 1.0f;
                const float right = -slope + 1.0f;
                matrix[static_cast<size_t>(mel * kFreqBins + f)] = std::max(0.0f, std::min(left, right));
            }
        }
        return matrix;
    }();
    return values;
}

const engine::audio::SparseMelFilterbank & speechbrain_sparse_fbank() {
    static const engine::audio::SparseMelFilterbank values = engine::audio::MelFilterbank().prepare_sparse(
        engine::audio::AudioTensor{speechbrain_fbank_matrix(), {kFeatureDim, kFreqBins}});
    return values;
}

std::vector<float> to_time_major_features(const engine::audio::AudioTensor & features) {
    if (features.shape.size() != 3 || features.shape[0] != 1) {
        throw std::runtime_error("expected single-batch audio feature tensor");
    }
    const int64_t feature_dim = features.shape[1];
    const int64_t frames = features.shape[2];
    std::vector<float> out(static_cast<size_t>(frames * feature_dim), 0.0f);
    for (int64_t frame = 0; frame < frames; ++frame) {
        for (int64_t feature = 0; feature < feature_dim; ++feature) {
            out[static_cast<size_t>(frame * feature_dim + feature)] =
                features.values[static_cast<size_t>(feature * frames + frame)];
        }
    }
    return out;
}

std::vector<float> compute_speechbrain_fbank(const std::vector<float> & waveform) {
    const auto start = Clock::now();
    if (waveform.empty()) {
        throw std::runtime_error("waveform is empty");
    }
    const engine::audio::STFTConfig stft_config{
        kNfft,
        kHopLength,
        kWinLength,
        true,
        engine::audio::STFTPadMode::Constant,
        engine::audio::STFTFamily::Default,
    };
    const auto magnitude = engine::audio::STFT().compute_magnitude(
        waveform,
        hamming_window(),
        1,
        static_cast<int64_t>(waveform.size()),
        stft_config);
    auto fbank = engine::audio::MelFilterbank().compute_custom_sparse_from_magnitude(
        magnitude.values,
        1,
        kFreqBins,
        magnitude.shape[2],
        magnitude.shape[2],
        speechbrain_sparse_fbank());
    std::vector<float> features = to_time_major_features(fbank);
    const int64_t frames = fbank.shape[2];

    float max_db = -std::numeric_limits<float>::infinity();
    for (float & value : features) {
        value = 10.0f * std::log10(std::max(value, kFbankAmin));
        max_db = std::max(max_db, value);
    }
    const float floor_db = max_db - kFbankTopDb;
    for (float & value : features) {
        value = std::max(value, floor_db);
    }

    for (int64_t mel = 0; mel < kFeatureDim; ++mel) {
        double mean = 0.0;
        for (int64_t frame = 0; frame < frames; ++frame) {
            mean += static_cast<double>(features[static_cast<size_t>(frame * kFeatureDim + mel)]);
        }
        mean /= static_cast<double>(frames);
        for (int64_t frame = 0; frame < frames; ++frame) {
            features[static_cast<size_t>(frame * kFeatureDim + mel)] -= static_cast<float>(mean);
        }
    }

    debug::timing_log_scalar("ecapa.features_ms", engine::debug::elapsed_ms(start, Clock::now()));
    return features;
}

std::vector<float> normalize_classifier_weights(const EcapaWeights & weights) {
    if (weights.classifier_weight.empty() || weights.classifier_weight.size() % static_cast<size_t>(kEmbeddingDim) != 0) {
        throw std::runtime_error("classifier weights are missing from checkpoint");
    }
    std::vector<float> normalized(weights.classifier_weight.size(), 0.0f);
    const int64_t class_count = static_cast<int64_t>(weights.classifier_weight.size() / static_cast<size_t>(kEmbeddingDim));
    for (int64_t cls = 0; cls < class_count; ++cls) {
        const float * row = weights.classifier_weight.data() + static_cast<size_t>(cls * kEmbeddingDim);
        double norm_sq = 0.0;
        for (int64_t i = 0; i < kEmbeddingDim; ++i) {
            const double w = row[static_cast<size_t>(i)];
            norm_sq += w * w;
        }
        const double inv_norm = 1.0 / std::sqrt(std::max(norm_sq, static_cast<double>(kStatsEps)));
        float * dst = normalized.data() + static_cast<size_t>(cls * kEmbeddingDim);
        for (int64_t i = 0; i < kEmbeddingDim; ++i) {
            dst[static_cast<size_t>(i)] = static_cast<float>(static_cast<double>(row[static_cast<size_t>(i)]) * inv_norm);
        }
    }
    return normalized;
}

std::vector<float> classify_embedding(
    const EcapaWeights & weights,
    const std::vector<float> & normalized_classifier_weight,
    std::vector<float> & centered,
    const std::vector<float> & embedding) {
    const auto start = Clock::now();
    if (weights.embedding_global_mean.size() != static_cast<size_t>(kEmbeddingDim)) {
        throw std::runtime_error("embedding global mean is missing from checkpoint");
    }
    if (normalized_classifier_weight.empty() || normalized_classifier_weight.size() % static_cast<size_t>(kEmbeddingDim) != 0) {
        throw std::runtime_error("normalized classifier weights are missing");
    }
    const int64_t class_count = static_cast<int64_t>(normalized_classifier_weight.size() / static_cast<size_t>(kEmbeddingDim));
    if (centered.size() != static_cast<size_t>(kEmbeddingDim)) {
        centered.resize(static_cast<size_t>(kEmbeddingDim));
    }
    float emb_norm_sq = 0.0f;
    for (int64_t i = 0; i < kEmbeddingDim; ++i) {
        centered[static_cast<size_t>(i)] = embedding[static_cast<size_t>(i)] - weights.embedding_global_mean[static_cast<size_t>(i)];
        emb_norm_sq += centered[static_cast<size_t>(i)] * centered[static_cast<size_t>(i)];
    }
    const float inv_emb_norm = 1.0f / std::sqrt(std::max(emb_norm_sq, kStatsEps));
    std::vector<float> logits(static_cast<size_t>(class_count), 0.0f);
    for (int64_t cls = 0; cls < class_count; ++cls) {
        const float * row = normalized_classifier_weight.data() + static_cast<size_t>(cls * kEmbeddingDim);
        float dot = 0.0f;
        for (int64_t i = 0; i < kEmbeddingDim; ++i) {
            dot += centered[static_cast<size_t>(i)] * row[static_cast<size_t>(i)];
        }
        logits[static_cast<size_t>(cls)] = dot * inv_emb_norm;
    }
    debug::timing_log_scalar("ecapa.classifier_ms", engine::debug::elapsed_ms(start, Clock::now()));
    return logits;
}

}  // namespace

std::vector<float> embed_runtime_audio(
    EcapaRuntime & runtime,
    const runtime::AudioBuffer & audio_buffer) {
    const auto mono = engine::audio::convert_interleaved_audio_to_mono_linear_resampled(
        audio_buffer.samples,
        audio_buffer.sample_rate,
        audio_buffer.channels,
        kTargetSampleRate);
    const auto features = compute_speechbrain_fbank(mono);
    const int64_t frames = static_cast<int64_t>(features.size() / kFeatureDim);
    return runtime.embed_features(features, frames);
}

EcapaClassifyResult classify_runtime_audio(
    EcapaRuntime & runtime,
    const EcapaWeights & weights,
    const std::vector<float> & normalized_classifier_weight,
    std::vector<float> & centered_embedding,
    const std::vector<std::string> & labels,
    const runtime::AudioBuffer & audio) {
    const auto start = Clock::now();
    const size_t class_count = normalized_classifier_weight.size() / static_cast<size_t>(kEmbeddingDim);
    if (class_count == 0) {
        throw std::runtime_error("classifier weights are missing from checkpoint");
    }
    if (labels.size() != class_count) {
        throw std::runtime_error(
            "label encoder size mismatch: expected " + std::to_string(class_count) +
            ", got " + std::to_string(labels.size()));
    }
    auto embedding = embed_runtime_audio(runtime, audio);
    auto logits = classify_embedding(weights, normalized_classifier_weight, centered_embedding, embedding);
    const auto best = std::max_element(logits.begin(), logits.end());
    const int index = static_cast<int>(std::distance(logits.begin(), best));
    if (index < 0 || index >= static_cast<int>(labels.size()) || labels[static_cast<size_t>(index)].empty()) {
        throw std::runtime_error("classifier predicted label index outside loaded label set");
    }
    EcapaClassifyResult out;
    out.label = labels[static_cast<size_t>(index)];
    out.index = index;
    out.score = *best;
    out.embedding = std::move(embedding);
    out.logits = std::move(logits);
    debug::timing_log_scalar("ecapa.classify_audio_ms", engine::debug::elapsed_ms(start, Clock::now()));
    return out;
}

EcapaRuntime::EcapaRuntime(
    std::shared_ptr<const EcapaWeights> weights,
    std::vector<std::string> labels,
    core::ExecutionContext & execution_context,
    assets::TensorStorageType weight_storage_type)
    : weights_(require_weights(std::move(weights))),
      backend_weights_(load_backend_weights(*weights_, execution_context.backend(), execution_context.backend_type(), weight_storage_type)),
      labels_(std::move(labels)),
      normalized_classifier_weight_(normalize_classifier_weights(*weights_)),
      execution_context_(&execution_context) {}

EcapaRuntime::~EcapaRuntime() = default;

EcapaRuntime::Graph & EcapaRuntime::ensure_graph(int64_t frames) {
    if (frames <= 0) {
        throw std::runtime_error("frames must be positive");
    }
    if (execution_context_ == nullptr) {
        throw std::runtime_error("ECAPA execution context is not initialized");
    }
    if (!graph_ || !graph_->matches(*weights_, frames, execution_context_->backend(), execution_context_->config().threads)) {
        graph_ = std::make_unique<Graph>(weights_, backend_weights_, frames, *execution_context_);
    }
    return *graph_;
}

std::vector<float> EcapaRuntime::embed_features(const std::vector<float> & features, int64_t frames) {
    if (frames <= 0) {
        throw std::runtime_error("frames must be positive");
    }
    if (features.size() != static_cast<size_t>(frames * kFeatureDim)) {
        throw std::runtime_error("feature tensor size mismatch");
    }
    return ensure_graph(frames).run(features);
}

std::vector<float> EcapaRuntime::embed_audio(const runtime::AudioBuffer & audio) {
    return embed_runtime_audio(*this, audio);
}

EcapaClassifyResult EcapaRuntime::classify_audio(const runtime::AudioBuffer & audio) {
    return classify_runtime_audio(*this, *weights_, normalized_classifier_weight_, centered_embedding_, labels_, audio);
}

}  // namespace engine::modules::ecapa_tdnn
