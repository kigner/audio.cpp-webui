#include "engine/models/stable_audio/sampler.h"

#include "engine/framework/sampling/torch_random.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <stdexcept>
#include <string>

namespace engine::models::stable_audio {
namespace {

constexpr float kDefaultLogSnrAnchor = -6.2F;
constexpr float kDefaultLogSnrEnd = 2.0F;
constexpr float kDefaultLogSnrRate = 0.0F;
constexpr int64_t kDefaultLogSnrAnchorLength = 2000;
constexpr float kPi = 3.14159265358979323846F;

int64_t round_up_to_multiple(int64_t value, int64_t multiple) {
    if (multiple <= 0) {
        throw std::runtime_error("Stable Audio alignment multiple must be positive");
    }
    return ((value + multiple - 1) / multiple) * multiple;
}

int64_t ceil_div_i64(int64_t value, int64_t divisor) {
    if (divisor <= 0) {
        throw std::runtime_error("Stable Audio divisor must be positive");
    }
    return (value + divisor - 1) / divisor;
}

int64_t adapted_audio_sample_size(const StableAudioConfig & config, const StableAudioRequest & request) {
    float max_seconds = 0.0F;
    for (const float seconds : request.durations_seconds) {
        max_seconds = std::max(max_seconds, seconds);
    }
    if (max_seconds <= 0.0F) {
        return config.sample_size;
    }
    int64_t target = static_cast<int64_t>((max_seconds + request.duration_padding_seconds) * static_cast<float>(config.sample_rate));
    target = round_up_to_multiple(target, config.downsampling_ratio);
    const int64_t latent_align = config.pretransform_encoder_chunk_size / config.pretransform_encoder_stride;
    target = round_up_to_multiple(target, config.downsampling_ratio * latent_align);
    return std::min(target, config.sample_size);
}

std::vector<float> make_padding_mask(const StableAudioConfig & config, const StableAudioRequest & request, int64_t latent_size) {
    std::vector<float> mask(static_cast<size_t>(request.batch_size * latent_size), 0.0F);
    for (int64_t b = 0; b < request.batch_size; ++b) {
        const float seconds = request.durations_seconds[static_cast<size_t>(b)];
        const int64_t audio_samples = static_cast<int64_t>(seconds * static_cast<float>(config.sample_rate));
        const int64_t raw_effective = ceil_div_i64(audio_samples, config.downsampling_ratio);
        const int64_t headroom = static_cast<int64_t>(
            request.duration_padding_seconds * static_cast<float>(config.sample_rate) /
            static_cast<float>(config.downsampling_ratio));
        const int64_t valid = std::min<int64_t>(latent_size, raw_effective + headroom);
        for (int64_t t = 0; t < valid; ++t) {
            mask[static_cast<size_t>(b * latent_size + t)] = 1.0F;
        }
    }
    return mask;
}

float shifted_full_timestep(const StableAudioConfig & config, float t, int64_t seq_len) {
    if (t <= 0.0F) {
        return 0.0F;
    }
    if (t >= 1.0F) {
        return 1.0F;
    }
    const float clamped = static_cast<float>(std::min<int64_t>(
        std::max<int64_t>(seq_len, config.distribution_shift_min_length),
        config.distribution_shift_max_length));
    const float min_length = static_cast<float>(config.distribution_shift_min_length);
    const float max_length = static_cast<float>(config.distribution_shift_max_length);
    const float ratio = (clamped - min_length) / (max_length - min_length);
    const float mu = -(
        config.distribution_shift_base_shift +
        (config.distribution_shift_max_shift - config.distribution_shift_base_shift) * ratio);
    const float exp_mu = std::exp(mu);
    const float odds = 1.0F / (1.0F - t) - 1.0F;
    float out = 1.0F - exp_mu / (exp_mu + odds);
    if (config.distribution_shift_use_sine) {
        out = std::sin(out * 0.5F * kPi);
    }
    return out;
}

float shifted_logsnr_timestep(float t, int64_t seq_len) {
    const int64_t clamped_seq_len = std::max<int64_t>(seq_len, 1);
    const float log2_ratio = std::log2(static_cast<float>(clamped_seq_len) / static_cast<float>(kDefaultLogSnrAnchorLength));
    const float logsnr_start = kDefaultLogSnrAnchor - kDefaultLogSnrRate * log2_ratio;
    const float logsnr = kDefaultLogSnrEnd - t * (kDefaultLogSnrEnd - logsnr_start);
    const float out = 1.0F / (1.0F + std::exp(logsnr));
    if (t <= 0.0F) {
        return 0.0F;
    }
    if (t >= 1.0F) {
        return 1.0F;
    }
    return out;
}

float shift_timestep(const StableAudioConfig & config, float t, int64_t effective_seq_len) {
    if (config.distribution_shift_type == "full") {
        return shifted_full_timestep(config, t, effective_seq_len);
    }
    if (config.distribution_shift_type == "logsnr") {
        return shifted_logsnr_timestep(t, effective_seq_len);
    }
    if (config.distribution_shift_type == "none") {
        return t;
    }
    throw std::runtime_error(std::string("Stable Audio unsupported distribution_shift_options.type: ") + config.distribution_shift_type);
}

std::vector<int64_t> make_effective_lengths(
    const StableAudioConfig & config,
    const StableAudioRequest & request) {
    std::vector<int64_t> lengths(static_cast<size_t>(request.batch_size), 0);
    for (int64_t b = 0; b < request.batch_size; ++b) {
        const float seconds = request.durations_seconds[static_cast<size_t>(b)];
        const int64_t audio_samples = static_cast<int64_t>(seconds * static_cast<float>(config.sample_rate));
        lengths[static_cast<size_t>(b)] = ceil_div_i64(audio_samples, config.downsampling_ratio);
    }
    return lengths;
}

std::vector<float> make_schedule(
    const StableAudioConfig & config,
    const StableAudioRequest & request,
    const std::vector<int64_t> & effective_lengths) {
    if (request.num_inference_steps <= 0) {
        throw std::runtime_error("Stable Audio sampling steps must be positive");
    }
    if (effective_lengths.size() != static_cast<size_t>(request.batch_size)) {
        throw std::runtime_error("Stable Audio schedule effective length count mismatch");
    }
    const int64_t points = static_cast<int64_t>(request.num_inference_steps) + 1;
    std::vector<float> schedule(static_cast<size_t>(request.batch_size * points), 0.0F);
    const float sigma_max = request.init_audio.has_value() ? request.init_noise_level : 1.0F;
    for (int64_t b = 0; b < request.batch_size; ++b) {
        for (int64_t i = 0; i < points; ++i) {
            const float linear = sigma_max * (1.0F - static_cast<float>(i) / static_cast<float>(points - 1));
            schedule[static_cast<size_t>(b * points + i)] =
                shift_timestep(config, linear, effective_lengths[static_cast<size_t>(b)]);
        }
        schedule[static_cast<size_t>(b * points)] = sigma_max;
        schedule[static_cast<size_t>(b * points + points - 1)] = 0.0F;
    }
    return schedule;
}

}  // namespace

StableAudioSamplingState prepare_stable_audio_sampling_state(
    const StableAudioConfig & config,
    const StableAudioRequest & request,
    const engine::sampling::TorchCudaSamplingPolicy & rng_policy) {
    if (config.downsampling_ratio <= 0 || config.io_channels <= 0) {
        throw std::runtime_error("Stable Audio sampling config is invalid");
    }
    if (request.batch_size <= 0) {
        throw std::runtime_error("Stable Audio sampling request batch must be positive");
    }
    StableAudioSamplingState out;
    out.audio_sample_size = adapted_audio_sample_size(config, request);
    out.latent_sample_size = out.audio_sample_size / config.downsampling_ratio;
    out.batch = request.batch_size;
    out.channels = config.io_channels;
    out.schedule_points = static_cast<int64_t>(request.num_inference_steps) + 1;
    out.schedule = make_schedule(config, request, make_effective_lengths(config, request));
    out.padding_mask = make_padding_mask(config, request, out.latent_sample_size);
    out.local_add_conditioning.assign(
        static_cast<size_t>(out.batch * out.latent_sample_size * config.local_add_cond_dim),
        0.0F);
    out.noise = engine::sampling::generate_torch_cuda_tensor_iterator_randn(
        static_cast<size_t>(out.batch * out.channels * out.latent_sample_size),
        request.seed,
        0,
        rng_policy,
        engine::sampling::TorchRandnPrecision::Float32);
    return out;
}

}  // namespace engine::models::stable_audio
