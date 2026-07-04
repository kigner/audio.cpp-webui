#pragma once

#include "engine/framework/runtime/session.h"

namespace engine::models::ace_step {

constexpr int kAceStepAudioSampleRate = 48000;
constexpr int kAceStepAudioChannels = 2;

runtime::AudioBuffer ace_step_normalize_audio_to_stereo_48k(const runtime::AudioBuffer & audio);

}  // namespace engine::models::ace_step
