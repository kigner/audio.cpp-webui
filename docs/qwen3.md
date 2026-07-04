# Qwen3 Models

This page covers Qwen3 TTS, Qwen3 ASR, and Qwen3 forced alignment. These are separate model packages with different inputs: Base TTS clones from audio, VoiceDesign uses an instruction, CustomVoice uses packaged speakers, ASR transcribes audio, and the aligner requires an exact transcript.

## Qwen3 TTS Base

Qwen3 TTS Base is the voice-clone TTS path. It needs reference audio and can use the reference transcript when available.

| Field | Value |
|---|---|
| Family | `qwen3_tts` |
| Model directory | `models/Qwen3-TTS-12Hz-1.7B-Base` |
| Task | `tts` |
| Modes | `offline` |
| Voice input | Reference WAV through `--voice-ref` |
| Transcript | Optional `--reference-text` |

```bash
audiocpp_cli --task tts --family qwen3_tts --model models/Qwen3-TTS-12Hz-1.7B-Base --backend cuda --text "Hello from Qwen3 TTS." --voice-ref assets/resources/b.wav --reference-text "Some call me nature. Others call me Mother Nature. I've been here for over 4.5 billion years. 22,500 times longer than you." --out out.wav
```

| Option | Values | Default | Meaning |
|---|---|---:|---|
| `--text` | text | required | Text to synthesize. |
| `--voice-ref` | WAV path | required | Voice clone reference audio. |
| `--reference-text` | text | empty string | Transcript for reference audio. |
| `--language` | language code | empty string | Text language hint. |
| `--text-chunk-size` | integer chars | `8192` | Long-form text chunk size. |
| `--max-tokens` | integer | `8192` | Maximum generated speech tokens per chunk. |

## Qwen3 TTS VoiceDesign

Qwen3 VoiceDesign creates a voice from an instruction. It does not require a speaker reference WAV.

| Field | Value |
|---|---|
| Family | `qwen3_tts` |
| Model directory | `models/Qwen3-TTS-12Hz-1.7B-VoiceDesign` |
| Task | `vdes` |
| Modes | `offline` |
| Voice input | Instruction text through `--instruct` |
| Reference audio | Not required |

```bash
audiocpp_cli --task vdes --family qwen3_tts --model models/Qwen3-TTS-12Hz-1.7B-VoiceDesign --backend cuda --text "Hello from a designed voice." --instruct "A warm adult narrator" --out out.wav
```

| Option | Values | Default | Meaning |
|---|---|---:|---|
| `--text` | text | required | Text to synthesize. |
| `--instruct` | text | required | Voice design instruction. |
| `--language` | language code | empty string | Text language hint. |
| `--text-chunk-size` | integer chars | `8192` | Long-form text chunk size. |
| `--max-tokens` | integer | `8192` | Maximum generated speech tokens per chunk. |

## Qwen3 TTS CustomVoice

Qwen3 CustomVoice uses speaker ids packaged with the model. The CLI passes the speaker name with `--speaker`; examples use `Vivian` and `Ryan`.

| Field | Value |
|---|---|
| Family | `qwen3_tts` |
| Model directory | `models/Qwen3-TTS-12Hz-1.7B-CustomVoice` |
| Task | `tts` |
| Modes | `offline` |
| Voice input | Built-in speaker id through `--speaker` |
| Style control | Optional instruction through `--instruct` |
| External voice WAV | Not used by this path |

```bash
audiocpp_cli --task tts --family qwen3_tts --model models/Qwen3-TTS-12Hz-1.7B-CustomVoice --backend cuda --text "Hello from a custom voice." --speaker Vivian --instruct "Very happy." --out out.wav
```

| Option | Values | Default | Meaning |
|---|---|---:|---|
| `--text` | text | required | Text to synthesize. |
| `--speaker` | packaged speaker name | required | Built-in speaker id, such as `Vivian` or `Ryan`. |
| `--instruct` | text | empty string | Style or emotion instruction. |
| `--language` | language code | empty string | Text language hint. |
| `--text-chunk-size` | integer chars | `8192` | Long-form text chunk size. |
| `--max-tokens` | integer | `8192` | Maximum generated speech tokens per chunk. |

## Qwen3 TTS Sampling

These sampling controls are shared by the Qwen3 TTS Base, VoiceDesign, and CustomVoice paths.

| Option | Values | Default | Meaning |
|---|---|---:|---|
| `--do-sample` | `true`, `false` | `true` | Enable sampling. |
| `--temperature` | float | `0.9` | Main talker temperature. |
| `--top-k` | integer | `50` | Main talker top-k. |
| `--top-p` | float | `1.0` | Main talker top-p. |
| `--repetition-penalty` | float | `1.05` | Main talker repetition penalty. |
| `--request-option subtalker_do_sample=true|false` | bool | `true` | Subtalker sampling. |
| `--request-option subtalker_temperature=<float>` | float | `0.9` | Subtalker temperature. |
| `--request-option subtalker_top_k=<n>` | integer | `50` | Subtalker top-k. |
| `--request-option subtalker_top_p=<float>` | float | `1.0` | Subtalker top-p. |
| `--seed` | integer | random if omitted | Sampling seed. |

## Qwen3 ASR

Qwen3 ASR transcribes speech audio and can write word/timestamp JSON.

| Field | Value |
|---|---|
| Family | `qwen3_asr` |
| Model directory | `models/Qwen3-ASR-0.6B` |
| Task | `asr` |
| Modes | `offline` |
| Input | Speech WAV through `--audio` |
| Output | Text plus optional word JSON through `--words-out` |

```bash
audiocpp_cli --task asr --family qwen3_asr --model models/Qwen3-ASR-0.6B --backend cuda --audio speech_16k.wav --text "" --words-out words.json
```

| Option | Values | Default | Meaning |
|---|---|---:|---|
| `--audio` | WAV path | required | Speech audio; use 16 kHz WAV for the examples. |
| `--text` | text | empty string | Context prompt. |
| `--language` | language code | empty string | Recognition language hint. |
| `--max-tokens` | integer | `512` | Maximum decode tokens. |
| `--words-out` | JSON path | not set | Word timestamp output. |

## Qwen3 Forced Aligner

The forced aligner maps an exact transcript onto speech audio. It is not an ASR route: the transcript is required input.

| Field | Value |
|---|---|
| Family | `qwen3_forced_aligner` |
| Model directory | `models/Qwen3-ForcedAligner-0.6B` |
| Task | `align` |
| Modes | `offline` |
| Input | Speech WAV plus exact transcript |
| Output | Word timestamp JSON through `--words-out` |

```bash
audiocpp_cli --task align --family qwen3_forced_aligner --model models/Qwen3-ForcedAligner-0.6B --backend cuda --audio speech_16k.wav --text "The exact transcript." --language en --words-out words.json
```

| Option | Values | Default | Meaning |
|---|---|---:|---|
| `--audio` | WAV path | required | Speech audio; use 16 kHz WAV for the examples. |
| `--text` | exact transcript | required | Transcript to align. |
| `--language` | language code | required | Transcript language. |
| `--words-out` | JSON path | not set | Word timestamp output. |

## Weight Options

| Option | Values | Default | Meaning |
|---|---|---:|---|
| `--session-option qwen3_tts.mem_saver=true|false` | bool | `false` | Release the TTS talker cached-step graph after each request to reduce post-request resident VRAM. Later requests rebuild that graph; voice prompt, prefill, code predictor, and speech decoder caches stay reusable. |
| `--session-option qwen3_tts.weight_type=<type>` | `native`, `f32`, `f16`, `bf16`, `q8_0` | `native` | TTS graph weight type. |
| `--session-option qwen3_asr.weight_type=<type>` | `native`, `f32`, `f16`, `bf16`, `q8_0` | `native` | ASR thinker weight type. |
| `--session-option qwen3_forced_aligner.weight_type=<type>` | `native`, `f32`, `f16`, `bf16`, `q8_0` | `native` | Aligner thinker weight type. |
