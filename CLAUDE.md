# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`audio.cpp` is a C++17 audio-model inference framework built on vendored `ggml`. One static
library (`engine_runtime`) holds the framework plus every model integration; two executables
(`audiocpp_cli`, `audiocpp_server`) sit on top. README.md is the authoritative user-facing
reference (model list, CLI flags, perf, quantization). This file covers build/test commands and
the internal architecture that spans multiple files.

## Build

CMake (>= 3.20), C11 / C++17, static libs only. Default build type for single-config generators
is `RelWithDebInfo`. Configure is CPU-only unless an accelerator backend is enabled explicitly.

Windows (this is the primary dev platform — MSVC `cl.exe`, Ninja; the VS IDE is not used):

```powershell
.\scripts\build_windows.ps1                                        # build/windows-cuda-release, audiocpp_cli
.\scripts\build_windows.ps1 -Preset windows-cpu-release -Target audiocpp_cli
.\scripts\build_windows.ps1 -Target audiocpp_server -Jobs 16
.\scripts\build_windows.ps1 -ConfigureOnly
```

Linux (GCC 13+):

```bash
cmake -S . -B build [-DENGINE_ENABLE_CUDA=ON | -DENGINE_ENABLE_VULKAN=ON]
cmake --build build --parallel --target audiocpp_cli --target audiocpp_server
# or: scripts/build_linux.sh --backend cuda|vulkan|cpu --target audiocpp_cli --target audiocpp_server
```

Key CMake options (all `OFF` by default unless noted): `ENGINE_ENABLE_CUDA`,
`ENGINE_ENABLE_VULKAN`, `ENGINE_ENABLE_METAL` (ON on Apple), `ENGINE_ENABLE_LLAMAFILE` (ON),
`ENGINE_ENABLE_CUDA_GRAPHS` (ON), `ENGINE_ENABLE_OPENMP` (ON), `ENGINE_BUILD_TESTS`,
`ENGINE_BUILD_WARMBENCH`, `ENGINE_BUILD_EXAMPLES`. CUDA presets auto-detect the local GPU arch
from `nvidia-smi`; backend selection is independent of build type.

Binaries land in `<build-dir>/bin/`.

## Tests

Three distinct layers — pick the one matching what you changed.

- **Unit tests (C++/ctest)** — fast, no model downloads. Configure with `-DENGINE_BUILD_TESTS=ON`,
  build, then:
  ```bash
  ctest --test-dir build --output-on-failure          # all
  ctest --test-dir build -R rnnoise_utility_test       # one test
  ```
  Tests cover tokenizers, audio DSP, denoise/enhance utilities, `torch_random`, diffusion math,
  encoder modules. `model_perf` and `miocodec_wavlm_parity` are always built (not gated).

- **CLI path tests** — drive the built `audiocpp_cli` over a catalog of real offline request cases
  and check output artifacts. Needs installed models under `models/`.
  ```bash
  python3 tools/audiocpp_cli/run_audiocpp_cli_path_tests.py --list
  python3 tools/audiocpp_cli/run_audiocpp_cli_path_tests.py --family pocket_tts --backend cuda
  python3 tools/audiocpp_cli/run_audiocpp_cli_path_tests.py --only <case_id>
  ```

- **Parity / perf harness** — `tests/warmbench.py` runs long-lived multi-request sessions and
  compares against Python reference paths (slow to set up; each family needs its own Python deps).
  Per-family C++ entrypoints live in `tests/<family>/` and build only with `-DENGINE_BUILD_WARMBENCH=ON`.
  ```bash
  python3 tests/warmbench.py --family qwen3_tts --backend cuda --mode offline
  ```

Get models with `python3 tools/model_manager.py {list|info <id>|install <id>}` (downloads/converts
into the `models/` layout the framework expects).

## Architecture

### Layered design (namespaces map to directories)

- **`engine::core`** (`src/framework/core`, `include/engine/framework/core`) — the ggml boundary.
  `ExecutionContext` owns a `ggml_backend_t` for a `BackendConfig`; `TensorValue`/`TensorShape`/
  `ModuleBuildContext` are the graph-building primitives; `backend.h` has tensor read/write helpers
  and host vs. device graph-plan logic.
- **`engine::runtime`** (`src/framework/runtime`) — model lifecycle and session execution. This is
  the spine (see registry chain below). `RuntimeSessionBase` gives a session its execution context,
  `ArtifactStore`, `RuntimeCache`, `RuntimeWorkspace`, and `GraphExecutor`. `GraphExecutor` allocates
  (via `ggml_gallocr`) and runs graphs, caching the allocated graph across runs. Also: `kv_cache`,
  `graph_optimizer`, `host_ops`, capacity adapters (`GraphCapacityController` for fixed/tiered/grow
  graph sizing across variable-length requests).
- **`engine::modules`** (`src/framework/modules`) — reusable NN blocks. Each exposes
  `build(ModuleBuildContext&, input, weights) -> TensorValue` and emits a ggml subgraph (e.g.
  `LinearModule`, attention/transformer blocks, conv/conformer, vocoders BigVGAN/HiFT, encoders
  CAMPPlus/WavLM/Hubert/Whisper, ECAPA-TDNN/TitaNet speaker, `optimizations/` fast variants).
- **`engine::audio`** (`src/framework/audio`) — DSP: FFT/STFT/ISTFT (optional CUDA ISTFT via the
  `.cu` source, guarded by `ENGINE_HAS_CUDA_ISTFT`), resampling, wav read/write, denoise (rnnoise,
  deepfilternet2, zipenhancer), enhancement, conversion, plus the public `utility_api`.
- Supporting framework dirs: `tokenizers` (sentencepiece, HF JSON, llama BPE), `codecs`, `sampling`
  (`torch_random` reproduces PyTorch RNG for parity; diffusion math, noise), `decoders` (TDT),
  `text` (chunking), `io` (config/json/yaml/safetensors/binary/filesystem), `debug` (trace, profiler).

### Model registry chain (how a request reaches a model)

```
make_default_registry()  -> ModelRegistry holding IVoiceModelLoader per family
  loader.can_load/inspect/load(ModelLoadRequest)  -> ILoadedVoiceModel
    model.create_task_session(TaskSpec, SessionOptions)  -> IVoiceTaskSession
      IOfflineVoiceTaskSession::run(TaskRequest) -> TaskResult     (offline — the supported path)
      IStreamingVoiceTaskSession::process_audio_chunk/finalize     (streaming — surface exists,
                                                                     not generally supported yet)
```

Interfaces are in `include/engine/framework/runtime/{registry,model,session}.h`. Tasks/inputs/
outputs are the enums and structs in `session.h` (`VoiceTaskKind`, `TaskRequest`, `TaskResult`,
`VoiceCondition`, etc.). The CLI builds a `TaskRequest`, calls `prepare()` then `run()`, and emits
results; the server keeps one loaded model + one offline session per configured id and reuses them.

### Models (`src/models/<family>`, headers in `include/engine/models/<family>`)

Each family follows the same file layout: `loader.cpp` (declares the family, discovers configs/
weights, builds the loaded model), `session.cpp` (the task session implementation), `assets.cpp`
(asset/weight discovery), plus model-specific component files. Released families are listed in
README.md; the authoritative enabled set is the `available_loaders` list in
`src/framework/runtime/registry.cpp`. Commented-out entries there (kokoro, moss, parakeet, etc.)
are integration-stage models not yet wired into this release tree.

**To add/enable a model:** create `src/models/<family>/` + `include/engine/models/<family>/`,
implement the loader+session against the runtime interfaces, add every `.cpp` to the
`engine_runtime` target in `CMakeLists.txt`, and register `make_<family>_loader()` in the
`available_loaders` vector in `registry.cpp`.

### App layer (`app/`)

- `app/cli` (namespace `minitts::cli`) — `audiocpp_cli` entrypoint, arg parsing, request building,
  batch. `app/cli/main.cpp` is the dispatch: parse args → load model → create session → run.
- `app/workflow` (namespace `minitts::app`) — experimental JSON pipelines (chunk/merge multi-step
  audio workflows); `audiocpp_cli --pipeline <json>`.
- `app/server` — `audiocpp_server`, a CUDA-only HTTP adapter over the registry (`/health`,
  `/v1/models`, `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/tasks/run`).

Note: app-layer code uses the legacy `minitts::*` namespace while framework/model code is `engine::*`.

### Vendored externals (`external/`, built from source)

`ggml` (compute + backends), `sentencepiece`, `cJSON`, `libyaml`, `llama_tokenizer`. Upstream
tests/examples are force-disabled from the top-level `CMakeLists.txt`. `tools/omtd` is a separate
llama.cpp-oriented output-media library, independent of the `engine_runtime` build.

## Conventions & gotchas

- This repo has a **CodeGraph** index (`.codegraph/`) — prefer `codegraph_*` MCP tools for
  structural questions (callers, impact, definitions) over grep; see the global instructions.
- Per the global RTK convention, prefix shell commands with `rtk` (e.g. `rtk git status`,
  `rtk cargo`/build wrappers) for token-reduced output; it passes through unchanged when no filter exists.
- Backend/model coverage is **model-dependent**; not every model runs on every backend.
- Quantization (`--session-option <family>.weight_type=...`) is model- and route-specific, not a
  safe global default — see the README quantization section before relying on it.
- GGUF model loading is not supported yet; `Build_xcframework.sh`/Apple Metal packaging is stale.
