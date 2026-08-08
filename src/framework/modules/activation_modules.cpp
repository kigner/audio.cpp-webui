#include "engine/framework/modules/activation_modules.h"

#include <stdexcept>

namespace engine::modules {

namespace {

const core::ModulePortSpec kActivationInputs[] = {
    {"input", core::PortKind::Activation, false},
};

const core::ModulePortSpec kActivationOutputs[] = {
    {"output", core::PortKind::Activation, false},
};

const core::ModuleSchema kReluSchema = {
    "ReLU",
    "nn.activation",
    kActivationInputs,
    1,
    kActivationOutputs,
    1,
    "Applies rectified linear activation elementwise.",
};

const core::ModuleSchema kSigmoidSchema = {
    "Sigmoid",
    "nn.activation",
    kActivationInputs,
    1,
    kActivationOutputs,
    1,
    "Applies sigmoid activation elementwise.",
};

const core::ModuleSchema kTanhSchema = {
    "Tanh",
    "nn.activation",
    kActivationInputs,
    1,
    kActivationOutputs,
    1,
    "Applies tanh activation elementwise.",
};

const core::ModuleSchema kSqrtSchema = {
    "Sqrt",
    "nn.activation",
    kActivationInputs,
    1,
    kActivationOutputs,
    1,
    "Applies square root elementwise.",
};

const core::ModuleSchema kGeluSchema = {
    "GELU",
    "nn.activation",
    kActivationInputs,
    1,
    kActivationOutputs,
    1,
    "Applies GELU activation elementwise.",
};

const core::ModuleSchema kSiluSchema = {
    "SiLU",
    "nn.activation",
    kActivationInputs,
    1,
    kActivationOutputs,
    1,
    "Applies SiLU activation elementwise.",
};

const core::ModuleSchema kSwooshLSchema = {
    "SwooshL",
    "nn.activation",
    kActivationInputs,
    1,
    kActivationOutputs,
    1,
    "Applies Zipformer SwooshL activation elementwise.",
};

const core::ModuleSchema kSwooshRSchema = {
    "SwooshR",
    "nn.activation",
    kActivationInputs,
    1,
    kActivationOutputs,
    1,
    "Applies Zipformer SwooshR activation elementwise.",
};

const core::ModuleSchema kEluSchema = {
    "ELU",
    "nn.activation",
    kActivationInputs,
    1,
    kActivationOutputs,
    1,
    "Applies ELU activation elementwise.",
};

const core::ModuleSchema kSoftmaxSchema = {
    "Softmax",
    "nn.activation",
    kActivationInputs,
    1,
    kActivationOutputs,
    1,
    "Applies softmax over the last physical dimension.",
};

const core::ModuleSchema kGLUSchema = {
    "GLU",
    "nn.activation",
    kActivationInputs,
    1,
    kActivationOutputs,
    1,
    "Splits the last dimension in half and applies sigmoid gating.",
};

const core::ModulePortSpec kSnakeInputs[] = {
    {"input", core::PortKind::Activation, false},
    {"alpha", core::PortKind::Parameter, false},
};

const core::ModuleSchema kSnake1dSchema = {
    "Snake1d",
    "nn.activation",
    kSnakeInputs,
    2,
    kActivationOutputs,
    1,
    "Applies Snake activation over channel-time tensors using per-channel alpha.",
};

template <typename Fn>
core::TensorValue build_unary(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & input,
    Fn fn) {
    if (ctx.ggml == nullptr) {
        throw std::runtime_error("ModuleBuildContext.ggml is null");
    }
    core::validate_rank_between(input, 1, core::kMaxTensorRank, "input");
    const auto contiguous = core::ensure_backend_addressable_layout(ctx, input);
    return core::wrap_tensor(fn(ctx.ggml, contiguous.tensor), input.shape, GGML_TYPE_F32);
}

core::TensorShape make_snake_alpha_shape(const core::TensorShape & input, int64_t hidden_size) {
    core::TensorShape shape = {};
    shape.rank = input.rank;
    for (size_t i = 0; i < shape.rank; ++i) {
        shape.dims[i] = 1;
    }
    shape.dims[shape.rank - 2] = hidden_size;
    return shape;
}

core::TensorValue ensure_f32(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & value) {
    if (value.type == GGML_TYPE_F32) {
        return value;
    }
    return core::wrap_tensor(ggml_cast(ctx.ggml, value.tensor, GGML_TYPE_F32), value.shape, GGML_TYPE_F32);
}

bool same_shape(const core::TensorShape & lhs, const core::TensorShape & rhs) {
    if (lhs.rank != rhs.rank) {
        return false;
    }
    for (size_t i = 0; i < lhs.rank; ++i) {
        if (lhs.dims[i] != rhs.dims[i]) {
            return false;
        }
    }
    return true;
}

core::TensorValue build_swoosh(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & input,
    float offset,
    float constant) {
    if (ctx.ggml == nullptr) {
        throw std::runtime_error("ModuleBuildContext.ggml is null");
    }
    core::validate_rank_between(input, 1, core::kMaxTensorRank, "input");
    const auto contiguous = core::ensure_backend_addressable_layout(ctx, input);
    auto shifted = core::wrap_tensor(
        ggml_scale_bias(ctx.ggml, contiguous.tensor, 1.0F, -offset),
        input.shape,
        GGML_TYPE_F32);
    auto activated = core::wrap_tensor(ggml_softplus(ctx.ggml, shifted.tensor), input.shape, GGML_TYPE_F32);
    auto residual = core::wrap_tensor(ggml_scale(ctx.ggml, contiguous.tensor, -0.08F), input.shape, GGML_TYPE_F32);
    auto summed = core::wrap_tensor(ggml_add(ctx.ggml, activated.tensor, residual.tensor), input.shape, GGML_TYPE_F32);
    return core::wrap_tensor(ggml_scale_bias(ctx.ggml, summed.tensor, 1.0F, constant), input.shape, GGML_TYPE_F32);
}

}  // namespace

const core::ModuleSchema & ReluModule::schema() const noexcept {
    return static_schema();
}

core::TensorValue ReluModule::build(core::ModuleBuildContext & ctx, const core::TensorValue & input) const {
    return build_unary(ctx, input, ggml_relu);
}

const core::ModuleSchema & ReluModule::static_schema() noexcept {
    return kReluSchema;
}

const core::ModuleSchema & SigmoidModule::schema() const noexcept {
    return static_schema();
}

core::TensorValue SigmoidModule::build(core::ModuleBuildContext & ctx, const core::TensorValue & input) const {
    return build_unary(ctx, input, ggml_sigmoid);
}

const core::ModuleSchema & SigmoidModule::static_schema() noexcept {
    return kSigmoidSchema;
}

const core::ModuleSchema & TanhModule::schema() const noexcept {
    return static_schema();
}

core::TensorValue TanhModule::build(core::ModuleBuildContext & ctx, const core::TensorValue & input) const {
    return build_unary(ctx, input, ggml_tanh);
}

const core::ModuleSchema & TanhModule::static_schema() noexcept {
    return kTanhSchema;
}

const core::ModuleSchema & SqrtModule::schema() const noexcept {
    return static_schema();
}

core::TensorValue SqrtModule::build(core::ModuleBuildContext & ctx, const core::TensorValue & input) const {
    return build_unary(ctx, input, ggml_sqrt);
}

const core::ModuleSchema & SqrtModule::static_schema() noexcept {
    return kSqrtSchema;
}

GeluModule::GeluModule(GeluConfig config) : config_(config) {
}

const GeluConfig & GeluModule::config() const noexcept {
    return config_;
}

const core::ModuleSchema & GeluModule::schema() const noexcept {
    return static_schema();
}

core::TensorValue GeluModule::build(core::ModuleBuildContext & ctx, const core::TensorValue & input) const {
    switch (config_.approximation) {
        case GeluApproximation::ExactErf:
            return build_unary(ctx, input, ggml_gelu_erf);
        case GeluApproximation::Tanh:
            return build_unary(ctx, input, ggml_gelu);
        case GeluApproximation::Quick:
            return build_unary(ctx, input, ggml_gelu_quick);
        default:
            throw std::runtime_error("Unsupported GELU approximation mode");
    }
}

const core::ModuleSchema & GeluModule::static_schema() noexcept {
    return kGeluSchema;
}

const core::ModuleSchema & SiluModule::schema() const noexcept {
    return static_schema();
}

core::TensorValue SiluModule::build(core::ModuleBuildContext & ctx, const core::TensorValue & input) const {
    return build_unary(ctx, input, ggml_silu);
}

const core::ModuleSchema & SiluModule::static_schema() noexcept {
    return kSiluSchema;
}

const core::ModuleSchema & SwooshLModule::schema() const noexcept {
    return static_schema();
}

core::TensorValue SwooshLModule::build(core::ModuleBuildContext & ctx, const core::TensorValue & input) const {
    return build_swoosh(ctx, input, 4.0F, -0.035F);
}

const core::ModuleSchema & SwooshLModule::static_schema() noexcept {
    return kSwooshLSchema;
}

const core::ModuleSchema & SwooshRModule::schema() const noexcept {
    return static_schema();
}

core::TensorValue SwooshRModule::build(core::ModuleBuildContext & ctx, const core::TensorValue & input) const {
    return build_swoosh(ctx, input, 1.0F, -0.313261687F);
}

const core::ModuleSchema & SwooshRModule::static_schema() noexcept {
    return kSwooshRSchema;
}

const core::ModuleSchema & EluModule::schema() const noexcept {
    return static_schema();
}

core::TensorValue EluModule::build(core::ModuleBuildContext & ctx, const core::TensorValue & input) const {
    return build_unary(ctx, input, ggml_elu);
}

const core::ModuleSchema & EluModule::static_schema() noexcept {
    return kEluSchema;
}

const core::ModuleSchema & SoftmaxModule::schema() const noexcept {
    return static_schema();
}

core::TensorValue SoftmaxModule::build(core::ModuleBuildContext & ctx, const core::TensorValue & input) const {
    return build_unary(ctx, input, ggml_soft_max);
}

const core::ModuleSchema & SoftmaxModule::static_schema() noexcept {
    return kSoftmaxSchema;
}

const core::ModuleSchema & GLUModule::schema() const noexcept {
    return static_schema();
}

core::TensorValue GLUModule::build(core::ModuleBuildContext & ctx, const core::TensorValue & input) const {
    if (ctx.ggml == nullptr) {
        throw std::runtime_error("ModuleBuildContext.ggml is null");
    }
    core::validate_rank_between(input, 1, core::kMaxTensorRank, "input");
    if (input.shape.last_dim() % 2 != 0) {
        throw std::runtime_error("GLU input last dimension must be even");
    }

    const auto contiguous = core::ensure_backend_addressable_layout(ctx, input);
    const auto flat = core::reshape_tensor(
        ctx,
        contiguous,
        core::TensorShape::from_dims({contiguous.shape.num_elements() / contiguous.shape.last_dim(), contiguous.shape.last_dim()}));
    const int64_t hidden = flat.shape.last_dim() / 2;
    auto lhs = core::wrap_tensor(
        ggml_view_2d(ctx.ggml, flat.tensor, hidden, flat.shape.dims[0], flat.tensor->nb[1], 0),
        core::TensorShape::from_dims({flat.shape.dims[0], hidden}),
        GGML_TYPE_F32);
    auto rhs = core::wrap_tensor(
        ggml_view_2d(ctx.ggml, flat.tensor, hidden, flat.shape.dims[0], flat.tensor->nb[1], hidden * sizeof(float)),
        core::TensorShape::from_dims({flat.shape.dims[0], hidden}),
        GGML_TYPE_F32);
    rhs = core::wrap_tensor(ggml_sigmoid(ctx.ggml, rhs.tensor), rhs.shape, GGML_TYPE_F32);
    auto output = core::wrap_tensor(ggml_mul(ctx.ggml, lhs.tensor, rhs.tensor), lhs.shape, GGML_TYPE_F32);

    auto output_shape = input.shape;
    output_shape.dims[output_shape.rank - 1] = hidden;
    return core::reshape_tensor(ctx, output, output_shape);
}

const core::ModuleSchema & GLUModule::static_schema() noexcept {
    return kGLUSchema;
}

Snake1dModule::Snake1dModule(Snake1dConfig config) : config_(config) {
    if (config_.hidden_size <= 0) {
        throw std::runtime_error("Snake1dConfig.hidden_size must be positive");
    }
}

const Snake1dConfig & Snake1dModule::config() const noexcept {
    return config_;
}

const core::ModuleSchema & Snake1dModule::schema() const noexcept {
    return static_schema();
}

core::TensorValue Snake1dModule::build(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & input,
    const Snake1dWeights & weights) const {
    if (ctx.ggml == nullptr) {
        throw std::runtime_error("ModuleBuildContext.ggml is null");
    }
    core::validate_rank_between(input, 2, core::kMaxTensorRank, "input");
    if (input.shape.dims[input.shape.rank - 2] != config_.hidden_size) {
        throw std::runtime_error("Snake1d input hidden dimension mismatch");
    }

    const auto contiguous = core::ensure_backend_addressable_layout(ctx, input);
    const auto input_f32 = ensure_f32(ctx, contiguous);
    core::TensorValue alpha_broadcast = {};
    if (same_shape(weights.alpha.shape, input.shape)) {
        alpha_broadcast = ensure_f32(ctx, weights.alpha);
    } else {
        core::validate_shape(weights.alpha, core::TensorShape::from_dims({config_.hidden_size}), "alpha");
        const auto alpha_shape = make_snake_alpha_shape(input.shape, config_.hidden_size);
        alpha_broadcast = core::reshape_tensor(ctx, ensure_f32(ctx, weights.alpha), alpha_shape);
    }
    const auto ax = core::wrap_tensor(ggml_mul(ctx.ggml, input_f32.tensor, alpha_broadcast.tensor), input_f32.shape, GGML_TYPE_F32);
    const auto s = core::wrap_tensor(ggml_sin(ctx.ggml, ax.tensor), input_f32.shape, GGML_TYPE_F32);
    const auto s2 = core::wrap_tensor(ggml_mul(ctx.ggml, s.tensor, s.tensor), input_f32.shape, GGML_TYPE_F32);
    const auto frac = core::wrap_tensor(ggml_div(ctx.ggml, s2.tensor, alpha_broadcast.tensor), input_f32.shape, GGML_TYPE_F32);
    return core::wrap_tensor(ggml_add(ctx.ggml, input_f32.tensor, frac.tensor), input_f32.shape, GGML_TYPE_F32);
}

const core::ModuleSchema & Snake1dModule::static_schema() noexcept {
    return kSnake1dSchema;
}

}  // namespace engine::modules
