#pragma once

#include "engine/models/ace_step/assets.h"

#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace engine::models::ace_step {

struct AceStepFsqQuantizerTable {
    std::vector<int64_t> levels;
    std::vector<int64_t> basis;
};

inline std::vector<float> ace_step_bidirectional_sliding_mask_values(
    int64_t tokens,
    int64_t sliding_window,
    std::string_view error_prefix) {
    if (tokens <= 0) {
        throw std::runtime_error(std::string(error_prefix) + " sliding mask requires positive token count");
    }
    std::vector<float> values(static_cast<size_t>(tokens * tokens), 0.0F);
    const float neg_inf = -std::numeric_limits<float>::infinity();
    for (int64_t q = 0; q < tokens; ++q) {
        for (int64_t k = 0; k < tokens; ++k) {
            if (std::llabs(q - k) > sliding_window) {
                values[static_cast<size_t>(q * tokens + k)] = neg_inf;
            }
        }
    }
    return values;
}

inline AceStepFsqQuantizerTable ace_step_build_fsq_quantizer_table(
    const AceStepDiffusionConfig & config,
    std::string_view error_prefix) {
    if (config.fsq_input_num_quantizers != 1) {
        throw std::runtime_error(
            std::string(error_prefix) + " currently supports only fsq_input_num_quantizers=1");
    }
    if (config.fsq_input_levels.empty()) {
        throw std::runtime_error(std::string(error_prefix) + " requires fsq_input_levels");
    }
    AceStepFsqQuantizerTable table;
    table.levels = config.fsq_input_levels;
    table.basis.resize(table.levels.size(), 1);
    for (size_t i = 1; i < table.levels.size(); ++i) {
        table.basis[i] = table.basis[i - 1] * table.levels[i - 1];
    }
    return table;
}

inline int64_t ace_step_diffusion_attention_head_dim(
    const AceStepDiffusionConfig & config,
    std::string_view error_prefix) {
    if (config.num_attention_heads <= 0 || config.num_key_value_heads <= 0 || config.head_dim <= 0) {
        throw std::runtime_error(std::string(error_prefix) + " attention config is invalid");
    }
    if (config.num_attention_heads % config.num_key_value_heads != 0) {
        throw std::runtime_error(
            std::string(error_prefix) + " num_attention_heads must be divisible by num_key_value_heads");
    }
    return config.head_dim;
}

}  // namespace engine::models::ace_step
