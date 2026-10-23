#pragma once

#include "engine/framework/runtime/session.h"
#include "engine/framework/modules/speech_encoders/qwen3_audio_encoder_runtime.h"

#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace engine::models::qwen3_asr {

struct Qwen3ASRGenerationOptions {
    int64_t max_new_tokens = 512;
    bool return_timestamps = false;
    bool clamp_timestamps_to_audio = false;
};

struct Qwen3ASRRequest {
    runtime::AudioBuffer audio;
    std::string context;
    std::string language;
    Qwen3ASRGenerationOptions generation;
};

struct Qwen3ASRResult {
    std::string text;
    std::string language;
    std::vector<runtime::WordTimestamp> word_timestamps;
};

struct Qwen3ASRPrompt {
    std::vector<int32_t> input_ids;
    std::vector<int32_t> audio_token_positions;
    std::vector<int32_t> attention_mask;
};

using Qwen3ASRAudioFeatures = modules::Qwen3AudioFeatures;
using Qwen3ASRAudioEmbeddings = modules::Qwen3AudioEmbeddings;

struct Qwen3ASRGeneratedTokens {
    std::vector<int32_t> token_ids;
};

// Offline aligner/chunk results use the model rate until the final result is returned.
inline void qwen3_asr_rescale_word_timestamps(
    std::vector<runtime::WordTimestamp> & words, int source_rate, int target_rate) {
    if (source_rate <= 0 || target_rate <= 0) {
        throw std::runtime_error("Qwen3 ASR timestamp conversion requires positive sample rates");
    }
    if (source_rate == target_rate) {
        return;
    }
    const auto rescale = [source_rate, target_rate](int64_t sample) {
        const int64_t whole = sample / source_rate;
        const int64_t remainder = sample % source_rate;
        const int64_t maximum = std::numeric_limits<int64_t>::max();
        const int64_t minimum = std::numeric_limits<int64_t>::min();
        if (whole > maximum / target_rate || whole < minimum / target_rate) {
            throw std::runtime_error("Qwen3 ASR timestamp conversion overflow");
        }
        const int64_t base = whole * target_rate;
        const int64_t magnitude = remainder < 0 ? -remainder : remainder;
        const int64_t rounded = (magnitude * target_rate + source_rate / 2) / source_rate;
        const int64_t fraction = remainder < 0 ? -rounded : rounded;
        if ((fraction > 0 && base > maximum - fraction) ||
            (fraction < 0 && base < minimum - fraction)) {
            throw std::runtime_error("Qwen3 ASR timestamp conversion overflow");
        }
        return base + fraction;
    };
    for (auto & word : words) {
        word.span = {rescale(word.span.start_sample), rescale(word.span.end_sample)};
    }
}

inline int64_t qwen3_asr_floor_div(int64_t numerator, int64_t denominator) {
    int64_t quotient = numerator / denominator;
    const int64_t remainder = numerator % denominator;
    if (remainder != 0 && ((remainder < 0) != (denominator < 0))) {
        --quotient;
    }
    return quotient;
}

inline int64_t qwen3_asr_audio_encoder_token_count(int64_t input_frames) {
    if (input_frames <= 0) {
        throw std::runtime_error("Qwen3 ASR requires positive feature frame count");
    }
    const int64_t input_lengths_leave = input_frames % 100;
    const int64_t feat_lengths = qwen3_asr_floor_div(input_lengths_leave - 1, 2) + 1;
    return qwen3_asr_floor_div(qwen3_asr_floor_div(feat_lengths - 1, 2) + 1 - 1, 2) + 1 +
        (input_frames / 100) * 13;
}

}  // namespace engine::models::qwen3_asr
