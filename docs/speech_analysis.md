# Speech Analysis

This page covers ASR, VAD, and diarization models that do not have a dedicated page. Qwen3 ASR is documented in [qwen3.md](qwen3.md).

Common CLI shape:

```bash
audiocpp_cli --task <task> --family <family> --model <model-dir> --backend cuda --audio <audio.wav> ...
```

## Citrinet ASR

Citrinet is an offline CTC ASR model. It produces transcription text from speech audio.

| Field | Value |
|---|---|
| Family | `citrinet_asr` |
| Model directory | `models/citrinet` |
| Task | `asr` |
| Modes | `offline` |
| Output | Transcription text |
| Streaming | Not exposed |

```bash
audiocpp_cli --task asr --family citrinet_asr --model models/citrinet --backend cuda --audio speech_16k.wav
```

| Option | Values | Default | Meaning |
|---|---|---:|---|
| `--audio` | WAV path | required | Speech input. Use 16 kHz WAV for the example path. |
| `--backend` | `cpu`, `cuda`, `vulkan`, `metal`, `best` | `cpu` | Compute backend. |

## Parakeet TDT

Parakeet TDT is an ASR model with offline and streaming paths. The integration exposes the greedy TDT decoder and optional word/timestamp JSON output.

| Field | Value |
|---|---|
| Family | `parakeet_tdt` |
| Model directory | `models/parakeet-tdt-0.6b-v3` |
| Task | `asr` |
| Modes | `offline`, `streaming` |
| Output | Transcription text; optional words/timestamps through `--words-out` |
| Decoder | `greedy_duration_loop` |

Offline:

```bash
audiocpp_cli --task asr --family parakeet_tdt --model models/parakeet-tdt-0.6b-v3 --backend cuda --audio speech_16k.wav --words-out words.json
```

Streaming:

```bash
audiocpp_cli --task asr --family parakeet_tdt --model models/parakeet-tdt-0.6b-v3 --backend cuda --mode streaming --audio speech_16k.wav --chunk-size 16000
```

| Option | Values | Default | Meaning |
|---|---|---:|---|
| `--audio` | WAV path | required | Speech input. |
| `--mode` | `offline`, `streaming` | `offline` | Full-context or streaming session. |
| `--words-out` | JSON path | not set | Write word/token timestamps when produced. |
| `--chunk-size` | samples | `512` | CLI streaming input chunk size. |
| `--session-option encoder_variant=<value>` | `full_context`, model-specific variants | `full_context` | Encoder path. |
| `--session-option decoder_algorithm=<value>` | `greedy_duration_loop` | `greedy_duration_loop` | TDT decoder algorithm. |
| `--session-option buffered_chunk_secs=<float>` | seconds | `2.0` | Offline buffered chunk duration. |
| `--session-option chunk_secs=<float>` | seconds | `2.0` | Streaming chunk duration. |
| `--session-option left_context_secs=<float>` | seconds | `10.0` | Streaming left context. |
| `--session-option right_context_secs=<float>` | seconds | `2.0` | Streaming right context. |

## Silero VAD

Silero VAD is bundled as a small framework asset and detects speech segments. It supports offline and streaming modes.

| Field | Value |
|---|---|
| Family | `silero_vad` |
| Model directory | `assets/framework/models/silero_vad` |
| Task | `vad` |
| Modes | `offline`, `streaming` |
| Output | Speech segment JSON through `--segments-out`; offline VAD chunk windows through `--vad-chunks-out` |
| Sample rates | 16 kHz path is used by the examples; 512-sample streaming chunks are required by the model path |

Offline:

```bash
audiocpp_cli --task vad --family silero_vad --model assets/framework/models/silero_vad --backend cuda --audio speech_16k.wav --segments-out segments.json
```

Offline VAD chunk planning:

```bash
audiocpp_cli \
  --task vad \
  --family silero_vad \
  --model assets/framework/models/silero_vad \
  --backend cuda \
  --audio speech_16k.wav \
  --segments-out segments.json \
  --vad-chunks-out vad_chunks.json \
  --vad-chunk-max-seconds 45 \
  --vad-chunk-merge-gap-seconds 0.5 \
  --vad-chunk-padding-seconds 0.25
```

Streaming:

```bash
audiocpp_cli --task vad --family silero_vad --model assets/framework/models/silero_vad --backend cuda --mode streaming --audio speech_16k.wav --chunk-size 512 --segments-out segments.json
```

| Option | Values | Default | Meaning |
|---|---|---:|---|
| `--audio` | WAV path | required | Input audio. |
| `--mode` | `offline`, `streaming` | `offline` | Full-file or streaming VAD. |
| `--segments-out` | JSON path | not set | Write speech segments. |
| `--vad-chunks-out` | JSON path | not set | Write offline VAD-based chunk windows. |
| `--vad-chunk-max-seconds` | seconds | `45` | Maximum VAD chunk length. |
| `--vad-chunk-merge-gap-seconds` | seconds | `0.5` | Merge padded speech spans separated by this gap or less. |
| `--vad-chunk-padding-seconds` | seconds | `0.25` | Pad each speech segment before chunk planning. |
| `--chunk-size` | samples | `512` | Streaming chunk size; Silero streaming requires 512 samples. |
| `--request-option threshold=<float>` | float | `0.5` | Speech probability threshold. |
| `--request-option neg_threshold=<float>` | float | `threshold - 0.15`, clamped to at least `0.01` | Negative threshold used by the state machine when not set directly. |
| `--request-option min_speech_duration_ms=<n>` | integer ms | `250` | Minimum speech duration. |
| `--request-option min_silence_duration_ms=<n>` | integer ms | `100` | Minimum silence duration. |
| `--request-option speech_pad_ms=<n>` | integer ms | `30` | Padding around speech segments. |
| `--request-option max_speech_duration_s=<float>` | seconds | `1000000000` | Maximum speech segment length. |

## MarbleNet VAD

MarbleNet VAD is an offline speech activity detector.

| Field | Value |
|---|---|
| Family | `marblenet_vad` |
| Model directory | `models/marblenet_vad` |
| Task | `vad` |
| Modes | `offline` |
| Output | Speech segment JSON through `--segments-out` |
| Streaming | Not exposed |

```bash
audiocpp_cli --task vad --family marblenet_vad --model models/marblenet_vad --backend cuda --audio speech_16k.wav --segments-out segments.json
```

| Option | Values | Default | Meaning |
|---|---|---:|---|
| `--audio` | WAV path | required | Input audio. |
| `--segments-out` | JSON path | not set | Write speech segments. |
| `--request-option threshold=<float>` | float | `0.5` | Speech probability threshold. |

## Sortformer Diarization

Sortformer diarization identifies speaker turns. The packaged model path is the 4-speaker variant.

| Field | Value |
|---|---|
| Family | `sortformer_diar` |
| Model directory | `models/diar_sortformer_4spk-v1` |
| Task | `diar` |
| Modes | `offline` |
| Output | Speaker turn JSON through `--turns-out` |
| Speakers | Up to the speaker count supported by the model package; the default model is 4-speaker |

```bash
audiocpp_cli --task diar --family sortformer_diar --model models/diar_sortformer_4spk-v1 --backend cuda --audio meeting_16k.wav --turns-out turns.json
```

| Option | Values | Default | Meaning |
|---|---|---:|---|
| `--audio` | WAV path | required | Meeting or conversation audio. |
| `--turns-out` | JSON path | not set | Write speaker turns. |
| `--session-option speaker_threshold=<float>` | float | `0.5` | Speaker activation threshold. |
| `--session-option speaker_min_frames=<n>` | integer | `0` | Minimum speaker segment frames. |
| `--session-option speaker_pad_frames=<n>` | integer | `0` | Padding around speaker turns. |
| `--session-option session_len_sec=<float>` | seconds | `20.0` | Diarization graph window length. |

For backend weight-type controls, use `audiocpp_cli --inspect --model <model-dir> --family <family>`.
