# audio.cpp Server

`audiocpp_server` is an HTTP adapter over the framework runtime registry. It keeps one loaded model and one offline task session per active model id, so repeated HTTP requests reuse the same framework session and model-owned graph/cache state.

## Build

```bash
cmake -S . -B build -DENGINE_ENABLE_CUDA=ON
cmake --build build --parallel --target audiocpp_server
```

Enable the backend you plan to run: `ENGINE_ENABLE_CUDA=ON` for CUDA, `ENGINE_ENABLE_VULKAN=ON` for Vulkan, or `ENGINE_ENABLE_METAL=ON` for Metal. CPU support is always available.

## Config

```bash
cat > server.json <<'JSON'
{
  "host": "127.0.0.1",
  "port": 8080,
  "backend": "cuda",
  "device": 0,
  "threads": 1,
  "lazy_load": true,
  "models": [
    {
      "id": "pocket-tts",
      "family": "pocket_tts",
      "path": "/path/to/models/pocket-tts",
      "task": "tts",
      "mode": "offline",
      "load_options": {
        "language": "english"
      },
      "session_options": {
        "language": "english"
      }
    },
    {
      "id": "qwen3-asr",
      "family": "qwen3_asr",
      "path": "/path/to/models/Qwen3-ASR-0.6B",
      "task": "asr",
      "mode": "offline"
    }
  ]
}
JSON
```

The server resolves model paths from this JSON exactly as written, so use paths that match your machine. Request-time audio paths are also user-provided paths.

Set top-level `"backend"` to `"cuda"`, `"cpu"`, `"vulkan"`, or `"metal"`. CUDA is the optimized path for audio.cpp; CPU, Vulkan, and Metal are intended for portability and testing when the binary is built with that backend, but performance and model coverage may be lower. The server prints this expectation-setting message when a non-CUDA backend is selected.

Set top-level `"lazy_load": true` to register all configured model ids at startup but defer each model's framework load and session creation until its first request. A model can override the default with `"lazy": true` or `"lazy": false`.

> [!WARNING]
> Lazy loading does not unload models after a request. Once a model is first used, the server keeps that model and session in memory for reuse until the server exits.

## Start

```bash
build/bin/audiocpp_server --config server.json
```

You can override the configured backend at startup:

```bash
build/bin/audiocpp_server --config server.json --backend vulkan
```

## Endpoints

### `GET /health`

Returns server readiness and the number of configured models.

### `GET /v1/models`

Returns OpenAI-style model entries for the configured audio.cpp model ids.

### `POST /v1/audio/speech`

OpenAI-style text-to-audio. The response is `audio/wav` by default.

```bash
curl http://127.0.0.1:8080/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -o out.wav \
  -d '{
    "model": "pocket-tts",
    "input": "audio.cpp is serving this request through the framework runtime.",
    "voice_ref": "/path/to/reference.wav",
    "max_tokens": 96,
    "seed": 1234
  }'
```

Set `"response_format": "json"` to receive base64 WAV in a JSON response.

### `POST /v1/audio/transcriptions`

JSON transcription request using a server-local audio path.

```bash
curl http://127.0.0.1:8080/v1/audio/transcriptions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen3-asr",
    "audio": "/path/to/input.wav"
  }'
```

Also accepts a `multipart/form-data` upload, matching the OpenAI Whisper API convention used by real clients (e.g. Open WebUI). The request is routed to the multipart path based on the `Content-Type` header; the JSON path above still works unchanged.

```bash
curl http://127.0.0.1:8080/v1/audio/transcriptions \
  -F model=qwen3-asr \
  -F language=en \
  -F file=@/path/to/input.wav
```

`file` and `model` are required; `language` is optional. The uploaded bytes are spooled to a temporary file for the duration of the request and removed afterward.

### `GET /v1/audio/voices?model=<id>`

Lists the cached voice ids available for a TTS model, so a client can populate a voice picker instead of guessing generic names. For families that keep voice presets under `model_root/embeddings/*.safetensors` (`pocket_tts` today), this returns those ids; for other families, or an unknown/missing `model` parameter, it returns an empty list.

```bash
curl 'http://127.0.0.1:8080/v1/audio/voices?model=pocket-tts'
```

```json
{"voices": ["alba", "cosette", "marius"]}
```

### `POST /v1/tasks/run`

Generic framework request route. The `request` object uses the same JSON fields as the `audiocpp_cli` request sequence format.

```bash
curl http://127.0.0.1:8080/v1/tasks/run \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "pocket-tts",
    "request": {
      "text": "Generic audio.cpp request.",
      "voice_ref": "/path/to/reference.wav",
      "max_tokens": 96,
      "seed": 1234
    }
  }'
```
