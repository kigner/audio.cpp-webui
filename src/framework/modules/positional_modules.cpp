#include "engine/framework/modules/positional_modules.h"

#include <stdexcept>
#include <string>

namespace engine::modules {
namespace {

void require_positive(int64_t value, const char * name) {
    if (value <= 0) {
        throw std::runtime_error(std::string(name) + " must be positive");
    }
}

}  // namespace

RoPEModule::RoPEModule(RoPEConfig config) : config_(config) {
    require_positive(config_.dimensions, "RoPEConfig.dimensions");
}

core::TensorValue RoPEModule::build(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & input,
    const core::TensorValue & positions,
    const core::TensorValue * frequency_factors) const {
    if (ctx.ggml == nullptr) {
        throw std::runtime_error("ModuleBuildContext.ggml is null");
    }
    core::validate_rank_between(input, 2, core::kMaxTensorRank, "input");
    core::validate_shape(positions, core::TensorShape::from_dims({input.shape.dims[1]}), "positions");
    if (positions.type != GGML_TYPE_I32) {
        throw std::runtime_error("RoPE positions must be GGML_TYPE_I32");
    }
    if (config_.dimensions > input.shape.last_dim()) {
        throw std::runtime_error("RoPE dimensions exceed input last dimension");
    }
    if (frequency_factors != nullptr) {
        core::validate_shape(
            *frequency_factors,
            core::TensorShape::from_dims({config_.dimensions / 2}),
            "RoPE frequency factors");
    }
    return core::wrap_tensor(
        ggml_rope_ext(
            ctx.ggml,
            input.tensor,
            positions.tensor,
            frequency_factors != nullptr ? frequency_factors->tensor : nullptr,
            static_cast<int>(config_.dimensions),
            config_.mode,
            0,
            config_.theta,
            config_.freq_scale,
            config_.ext_factor,
            config_.attn_factor,
            config_.beta_fast,
            config_.beta_slow),
        input.shape,
        input.type);
}

}  // namespace engine::modules
