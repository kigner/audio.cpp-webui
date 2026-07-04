#include "audio_preprocess.h"

#include "engine/framework/audio/resampling.h"

#include <algorithm>
#include <cstdint>
#include <stdexcept>
#include <vector>

namespace engine::models::ace_step {

runtime::AudioBuffer ace_step_normalize_audio_to_stereo_48k(const runtime::AudioBuffer & audio) {
    if (audio.sample_rate <= 0) {
        throw std::runtime_error("ACE-Step source audio sample rate must be positive");
    }
    if (audio.channels <= 0) {
        throw std::runtime_error("ACE-Step source audio channel count must be positive");
    }
    if (audio.samples.empty()) {
        throw std::runtime_error("ACE-Step source audio is empty");
    }
    if (audio.samples.size() % static_cast<size_t>(audio.channels) != 0) {
        throw std::runtime_error("ACE-Step source audio has invalid channel layout");
    }

    const int64_t frames = static_cast<int64_t>(audio.samples.size() / static_cast<size_t>(audio.channels));
    std::vector<float> left(static_cast<size_t>(frames), 0.0F);
    std::vector<float> right(static_cast<size_t>(frames), 0.0F);
    if (audio.channels == 1) {
        for (int64_t frame = 0; frame < frames; ++frame) {
            const float value = audio.samples[static_cast<size_t>(frame)];
            left[static_cast<size_t>(frame)] = value;
            right[static_cast<size_t>(frame)] = value;
        }
    } else {
        for (int64_t frame = 0; frame < frames; ++frame) {
            const size_t base = static_cast<size_t>(frame * audio.channels);
            left[static_cast<size_t>(frame)] = audio.samples[base];
            right[static_cast<size_t>(frame)] = audio.samples[base + 1];
        }
    }
    if (audio.sample_rate != kAceStepAudioSampleRate) {
        left = engine::audio::resample_mono_torchaudio_sinc_hann(
            left,
            audio.sample_rate,
            kAceStepAudioSampleRate);
        right = engine::audio::resample_mono_torchaudio_sinc_hann(
            right,
            audio.sample_rate,
            kAceStepAudioSampleRate);
    }

    runtime::AudioBuffer out;
    out.sample_rate = kAceStepAudioSampleRate;
    out.channels = kAceStepAudioChannels;
    out.samples.resize(left.size() * 2, 0.0F);
    for (size_t i = 0; i < left.size(); ++i) {
        out.samples[i * 2] = std::clamp(left[i], -1.0F, 1.0F);
        out.samples[i * 2 + 1] = std::clamp(right[i], -1.0F, 1.0F);
    }
    return out;
}

}  // namespace engine::models::ace_step
