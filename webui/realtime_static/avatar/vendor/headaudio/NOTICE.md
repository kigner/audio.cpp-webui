HeadAudio audio-driven viseme detector
====================================

Source: https://github.com/met4citizen/HeadAudio
Pinned commit: d3af5f9ff86ab6b2b1913d411a4e1922ec101953
Copyright (c) 2025 Mika Suominen. MIT; see LICENSE.

The modules and dist/model-en-mixed.bin are copied from that commit.
All transitive local imports are included. No third-party runtime dependency
is required by these modules.

Local change in modules/headaudio.mjs:
- Accept valid integer viseme IDs including 0 (viseme_aa), instead of the
  upstream truthiness check which drops that vowel. Other upstream behavior
  is retained.

The binary contains MFCC/Gaussian-prototype lip shapes trained using English
voices. It is a small CPU classifier, not a TTS or video-generation model.
Chinese perceptual accuracy must be evaluated with actual local TTS playback.
