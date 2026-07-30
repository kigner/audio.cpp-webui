#include "attention_internal.h"

namespace engine::modules {

using namespace attention::internal;

FeedForwardModule::FeedForwardModule(FeedForwardConfig config) : config_(config) {
    validate_hidden_positive(config_.hidden_size, "FeedForwardConfig.hidden_size");
    validate_hidden_positive(config_.intermediate_size, "FeedForwardConfig.intermediate_size");
}

const FeedForwardConfig & FeedForwardModule::config() const noexcept {
    return config_;
}

const core::ModuleSchema & FeedForwardModule::schema() const noexcept {
    return static_schema();
}

core::TensorValue FeedForwardModule::build(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & input,
    const FeedForwardWeights & weights) const {
    core::validate_rank_between(input, 1, core::kMaxTensorRank, "input");
    core::validate_last_dim(input, config_.hidden_size, "input");
    return build_feed_forward_impl(ctx, input, config_, require_feed_forward_weights(weights, config_.use_bias));
}

const core::ModuleSchema & FeedForwardModule::static_schema() noexcept {
    return kFeedForwardSchema;
}

FeedForwardGeluModule::FeedForwardGeluModule(FeedForwardConfig config) : config_(config) {
    config_.gelu_approximation = GeluApproximation::Tanh;
    validate_hidden_positive(config_.hidden_size, "FeedForwardGeluConfig.hidden_size");
    validate_hidden_positive(config_.intermediate_size, "FeedForwardGeluConfig.intermediate_size");
}

const FeedForwardConfig & FeedForwardGeluModule::config() const noexcept {
    return config_;
}

const core::ModuleSchema & FeedForwardGeluModule::schema() const noexcept {
    return static_schema();
}

core::TensorValue FeedForwardGeluModule::build(
    core::ModuleBuildContext & ctx,
    const core::TensorValue & input,
    const FeedForwardWeights & weights) const {
    core::validate_rank_between(input, 1, core::kMaxTensorRank, "input");
    core::validate_last_dim(input, config_.hidden_size, "input");
    return build_feed_forward_impl(ctx, input, config_, require_feed_forward_weights(weights, config_.use_bias));
}

const core::ModuleSchema & FeedForwardGeluModule::static_schema() noexcept {
    return kFeedForwardGeluSchema;
}

}  // namespace engine::modules
