#pragma once

#include <cstdint>
#include <vector>

namespace engine::audio {

enum class AudioChunkPadMode {
    Zero,
    Reflect,
};

enum class AudioChunkTailAlignment {
    Start,
    Center,
};

enum class AudioChunkCounterMode {
    SharedAcrossLanes,
    PerLane,
};

struct AudioChunkSpec {
    int64_t chunk_samples = 0;
    int64_t hop_samples = 0;
    AudioChunkPadMode pad_mode = AudioChunkPadMode::Zero;
    AudioChunkTailAlignment tail_alignment = AudioChunkTailAlignment::Start;
    int64_t reflect_min_valid_samples = 0;
};

struct AudioChunkSpan {
    int64_t index = 0;
    int64_t output_start_sample = 0;
    int64_t valid_samples = 0;
    int64_t copy_start_sample = 0;
    int64_t valid_start_in_chunk = 0;
};

std::vector<AudioChunkSpan> plan_audio_chunks(int64_t input_samples, const AudioChunkSpec & spec);

std::vector<float> make_triangular_overlap_window(int64_t chunk_samples);
std::vector<float> make_linear_fade_window(int64_t chunk_samples, int64_t fade_samples);

void copy_interleaved_chunk_to_planar(
    std::vector<float> & output_planar,
    const std::vector<float> & input_interleaved,
    int64_t channels,
    int64_t input_frames,
    const AudioChunkSpan & span,
    const AudioChunkSpec & spec);

void copy_planar_chunk(
    std::vector<float> & output_planar,
    const std::vector<float> & input_planar,
    int64_t lanes,
    int64_t input_frames,
    const AudioChunkSpan & span,
    const AudioChunkSpec & spec);

void overlap_add_planar_chunk(
    std::vector<float> & output_planar,
    std::vector<float> & weights,
    const std::vector<float> & chunk_planar,
    int64_t lanes,
    int64_t output_frames,
    const AudioChunkSpan & span,
    const std::vector<float> & window,
    AudioChunkCounterMode counter_mode);

void normalize_overlap_added_planar(
    std::vector<float> & output_planar,
    const std::vector<float> & weights,
    int64_t lanes,
    int64_t output_frames,
    AudioChunkCounterMode counter_mode);

}  // namespace engine::audio
