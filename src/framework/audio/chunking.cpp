#include "engine/framework/audio/chunking.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <string>

namespace engine::audio {
namespace {

void require_positive(int64_t value, const char * name) {
    if (value <= 0) {
        throw std::runtime_error(std::string("Audio chunker requires positive ") + name);
    }
}

int64_t reflect_index(int64_t index, int64_t length) {
    require_positive(length, "reflect length");
    if (length == 1) {
        return 0;
    }
    while (index < 0 || index >= length) {
        if (index < 0) {
            index = -index;
        } else {
            index = 2 * length - index - 2;
        }
    }
    return index;
}

bool should_reflect_pad(const AudioChunkSpan & span, const AudioChunkSpec & spec) {
    return spec.pad_mode == AudioChunkPadMode::Reflect &&
        (spec.reflect_min_valid_samples <= 0 ||
         span.valid_samples >= spec.reflect_min_valid_samples);
}

size_t planar_index(int64_t lane, int64_t frame, int64_t frames) {
    return static_cast<size_t>(lane * frames + frame);
}

size_t weight_index(AudioChunkCounterMode mode, int64_t lane, int64_t frame, int64_t output_frames) {
    return mode == AudioChunkCounterMode::SharedAcrossLanes
        ? static_cast<size_t>(frame)
        : planar_index(lane, frame, output_frames);
}

void validate_copy_shape(
    const std::vector<float> & input,
    int64_t lanes,
    int64_t input_frames,
    const std::vector<float> & output,
    const AudioChunkSpec & spec) {
    require_positive(lanes, "lanes");
    require_positive(input_frames, "input frames");
    require_positive(spec.chunk_samples, "chunk samples");
    if (static_cast<int64_t>(input.size()) != lanes * input_frames) {
        throw std::runtime_error("Audio chunker input size mismatch");
    }
    if (static_cast<int64_t>(output.size()) != lanes * spec.chunk_samples) {
        throw std::runtime_error("Audio chunker output size mismatch");
    }
}

}  // namespace

std::vector<AudioChunkSpan> plan_audio_chunks(int64_t input_samples, const AudioChunkSpec & spec) {
    require_positive(input_samples, "input samples");
    require_positive(spec.chunk_samples, "chunk samples");
    require_positive(spec.hop_samples, "hop samples");
    if (spec.hop_samples > spec.chunk_samples) {
        throw std::runtime_error("Audio chunker hop_samples must be <= chunk_samples");
    }

    std::vector<AudioChunkSpan> spans;
    int64_t start = 0;
    int64_t index = 0;
    while (start < input_samples) {
        const int64_t valid = std::min(spec.chunk_samples, input_samples - start);
        AudioChunkSpan span;
        span.index = index++;
        span.output_start_sample = start;
        span.valid_samples = valid;
        span.copy_start_sample = start;
        if (valid < spec.chunk_samples &&
            spec.tail_alignment == AudioChunkTailAlignment::Center) {
            span.copy_start_sample -= (spec.chunk_samples - valid) / 2;
        }
        span.valid_start_in_chunk = start - span.copy_start_sample;
        if (span.valid_start_in_chunk < 0 ||
            span.valid_start_in_chunk + span.valid_samples > spec.chunk_samples) {
            throw std::runtime_error("Audio chunker planned invalid chunk span");
        }
        spans.push_back(span);
        start += spec.hop_samples;
    }
    return spans;
}

std::vector<float> make_triangular_overlap_window(int64_t chunk_samples) {
    require_positive(chunk_samples, "chunk samples");
    std::vector<float> window(static_cast<size_t>(chunk_samples), 1.0F);
    const int64_t rising = chunk_samples / 2;
    const int64_t falling = chunk_samples - rising;
    for (int64_t i = 0; i < rising; ++i) {
        window[static_cast<size_t>(i)] = static_cast<float>(i + 1);
    }
    for (int64_t i = 0; i < falling; ++i) {
        window[static_cast<size_t>(rising + i)] = static_cast<float>(falling - i);
    }
    const float max_value = *std::max_element(window.begin(), window.end());
    for (float & value : window) {
        value /= max_value;
    }
    return window;
}

std::vector<float> make_linear_fade_window(int64_t chunk_samples, int64_t fade_samples) {
    require_positive(chunk_samples, "chunk samples");
    if (fade_samples < 0 || fade_samples * 2 > chunk_samples) {
        throw std::runtime_error("Audio chunker fade_samples is invalid");
    }
    std::vector<float> window(static_cast<size_t>(chunk_samples), 1.0F);
    if (fade_samples <= 0) {
        return window;
    }
    for (int64_t i = 0; i < fade_samples; ++i) {
        const float alpha = fade_samples == 1
            ? 1.0F
            : static_cast<float>(i) / static_cast<float>(fade_samples - 1);
        window[static_cast<size_t>(i)] = alpha;
        window[static_cast<size_t>(chunk_samples - fade_samples + i)] = 1.0F - alpha;
    }
    return window;
}

void copy_interleaved_chunk_to_planar(
    std::vector<float> & output_planar,
    const std::vector<float> & input_interleaved,
    int64_t channels,
    int64_t input_frames,
    const AudioChunkSpan & span,
    const AudioChunkSpec & spec) {
    validate_copy_shape(input_interleaved, channels, input_frames, output_planar, spec);
    std::fill(output_planar.begin(), output_planar.end(), 0.0F);
    const bool reflect = should_reflect_pad(span, spec);
#ifdef _OPENMP
    #pragma omp parallel for if(channels >= 2)
#endif
    for (int64_t ch = 0; ch < channels; ++ch) {
        float * dst = output_planar.data() + static_cast<size_t>(ch * spec.chunk_samples);
        for (int64_t i = 0; i < spec.chunk_samples; ++i) {
            int64_t src_frame = span.copy_start_sample + i;
            if (src_frame < 0 || src_frame >= input_frames) {
                if (!reflect) {
                    continue;
                }
                src_frame = reflect_index(src_frame, input_frames);
            }
            dst[i] = input_interleaved[static_cast<size_t>(src_frame * channels + ch)];
        }
    }
}

void copy_planar_chunk(
    std::vector<float> & output_planar,
    const std::vector<float> & input_planar,
    int64_t lanes,
    int64_t input_frames,
    const AudioChunkSpan & span,
    const AudioChunkSpec & spec) {
    validate_copy_shape(input_planar, lanes, input_frames, output_planar, spec);
    std::fill(output_planar.begin(), output_planar.end(), 0.0F);
    const bool reflect = should_reflect_pad(span, spec);
#ifdef _OPENMP
    #pragma omp parallel for if(lanes >= 2)
#endif
    for (int64_t lane = 0; lane < lanes; ++lane) {
        float * dst = output_planar.data() + static_cast<size_t>(lane * spec.chunk_samples);
        const float * src = input_planar.data() + static_cast<size_t>(lane * input_frames);
        for (int64_t i = 0; i < spec.chunk_samples; ++i) {
            int64_t src_frame = span.copy_start_sample + i;
            if (src_frame < 0 || src_frame >= input_frames) {
                if (!reflect) {
                    continue;
                }
                src_frame = reflect_index(src_frame, input_frames);
            }
            dst[i] = src[src_frame];
        }
    }
}

void overlap_add_planar_chunk(
    std::vector<float> & output_planar,
    std::vector<float> & weights,
    const std::vector<float> & chunk_planar,
    int64_t lanes,
    int64_t output_frames,
    const AudioChunkSpan & span,
    const std::vector<float> & window,
    AudioChunkCounterMode counter_mode) {
    require_positive(lanes, "lanes");
    require_positive(output_frames, "output frames");
    const int64_t chunk_samples = static_cast<int64_t>(window.size());
    require_positive(chunk_samples, "window samples");
    if (static_cast<int64_t>(chunk_planar.size()) != lanes * chunk_samples ||
        static_cast<int64_t>(output_planar.size()) != lanes * output_frames) {
        throw std::runtime_error("Audio chunker overlap-add size mismatch");
    }
    const int64_t expected_weights = counter_mode == AudioChunkCounterMode::SharedAcrossLanes
        ? output_frames
        : lanes * output_frames;
    if (static_cast<int64_t>(weights.size()) != expected_weights) {
        throw std::runtime_error("Audio chunker overlap-add weight size mismatch");
    }
    if (span.valid_start_in_chunk < 0 ||
        span.valid_start_in_chunk + span.valid_samples > chunk_samples ||
        span.output_start_sample < 0 ||
        span.output_start_sample + span.valid_samples > output_frames) {
        throw std::runtime_error("Audio chunker overlap-add span mismatch");
    }

#ifdef _OPENMP
    #pragma omp parallel for if(lanes >= 2)
#endif
    for (int64_t lane = 0; lane < lanes; ++lane) {
        for (int64_t i = 0; i < span.valid_samples; ++i) {
            const int64_t chunk_frame = span.valid_start_in_chunk + i;
            const int64_t output_frame = span.output_start_sample + i;
            const float gain = window[static_cast<size_t>(chunk_frame)];
            output_planar[planar_index(lane, output_frame, output_frames)] +=
                chunk_planar[planar_index(lane, chunk_frame, chunk_samples)] * gain;
            if (counter_mode == AudioChunkCounterMode::PerLane || lane == 0) {
                weights[weight_index(counter_mode, lane, output_frame, output_frames)] += gain;
            }
        }
    }
}

void normalize_overlap_added_planar(
    std::vector<float> & output_planar,
    const std::vector<float> & weights,
    int64_t lanes,
    int64_t output_frames,
    AudioChunkCounterMode counter_mode) {
    require_positive(lanes, "lanes");
    require_positive(output_frames, "output frames");
    if (static_cast<int64_t>(output_planar.size()) != lanes * output_frames) {
        throw std::runtime_error("Audio chunker normalize output size mismatch");
    }
    const int64_t expected_weights = counter_mode == AudioChunkCounterMode::SharedAcrossLanes
        ? output_frames
        : lanes * output_frames;
    if (static_cast<int64_t>(weights.size()) != expected_weights) {
        throw std::runtime_error("Audio chunker normalize weight size mismatch");
    }
#ifdef _OPENMP
    #pragma omp parallel for if(lanes >= 2)
#endif
    for (int64_t lane = 0; lane < lanes; ++lane) {
        for (int64_t frame = 0; frame < output_frames; ++frame) {
            const float denom = weights[weight_index(counter_mode, lane, frame, output_frames)] > 1.0e-8F
                ? weights[weight_index(counter_mode, lane, frame, output_frames)]
                : 1.0F;
            output_planar[planar_index(lane, frame, output_frames)] /= denom;
        }
    }
}

}  // namespace engine::audio
