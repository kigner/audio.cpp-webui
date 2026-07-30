#pragma once

#include "engine/framework/core/module.h"
#include "engine/framework/modules/activation_modules.h"

#include <optional>

namespace engine::modules {

struct FeedForwardConfig {
    int64_t hidden_size = 0;
    int64_t intermediate_size = 0;
    bool use_bias = true;
    GeluApproximation gelu_approximation = GeluApproximation::ExactErf;
};

struct FeedForwardWeights {
    core::TensorValue fc1_weight;
    std::optional<core::TensorValue> fc1_bias;
    core::TensorValue fc2_weight;
    std::optional<core::TensorValue> fc2_bias;
};

class FeedForwardModule {
public:
    explicit FeedForwardModule(FeedForwardConfig config);

    const FeedForwardConfig & config() const noexcept;
    const core::ModuleSchema & schema() const noexcept;

    core::TensorValue build(
        core::ModuleBuildContext & ctx,
        const core::TensorValue & input,
        const FeedForwardWeights & weights) const;

    static const core::ModuleSchema & static_schema() noexcept;

private:
    FeedForwardConfig config_;
};

class FeedForwardGeluModule {
public:
    explicit FeedForwardGeluModule(FeedForwardConfig config);

    const FeedForwardConfig & config() const noexcept;
    const core::ModuleSchema & schema() const noexcept;

    core::TensorValue build(
        core::ModuleBuildContext & ctx,
        const core::TensorValue & input,
        const FeedForwardWeights & weights) const;

    static const core::ModuleSchema & static_schema() noexcept;

private:
    FeedForwardConfig config_;
};

}  // namespace engine::modules
