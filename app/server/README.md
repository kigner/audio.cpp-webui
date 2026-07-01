# audio.cpp Server

`audiocpp_server` is a CUDA-only HTTP adapter over the framework runtime registry. It keeps one loaded model and one offline task session per active model id, so repeated HTTP requests reuse the same framework session and model-owned graph/cache state.

## Build

```bash
cmake -S . -B build -DENGINE_ENABLE_CUDA=ON
cmake --build build --parallel --target audiocpp_server
```

## Config

```bash
cat > server.json <<'JSON'
{
  "host": "127.0.0.1",
  "port": 8080,
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

Set top-level `"lazy_load": true` to register all configured model ids at startup but defer each model's framework load and session creation until its first request. A model can override the default with `"lazy": true` or `"lazy": false`.

> [!WARNING]
> Lazy loading does not unload models after a request. Once a model is first used, the server keeps that model and session in memory for reuse until the server exits.

## Start

```bash
build/bin/audiocpp_server --config server.json
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
