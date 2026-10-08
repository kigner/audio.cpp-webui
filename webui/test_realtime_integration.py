"""Same-origin routing and shared runtime ownership; no model weights needed."""
import os
import unittest
from unittest.mock import Mock, patch

import httpx
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from realtime_server import create_app


def _models():
    return [{"id": "test-tts", "supports_streaming": True,
             "stream_sample_rate": 24000}]


def _config():
    return {"tts_model": "test-tts", "tts_playback_mode": "auto"}


class IntegratedRealtimeTests(unittest.TestCase):
    def test_frontend_revalidates_documents_and_modules_including_304(self):
        with TestClient(create_app(_models, api_prefix="/api/realtime")) as client:
            for path in ("", "index.html", "main.js?v=scene-5", "ui/chat.js", "scene.css"):
                with self.subTest(path=path):
                    url = f"/realtime/{path}"
                    response = client.get(url)
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.headers["cache-control"], "no-cache")
                    cached = client.get(url, headers={"If-None-Match": response.headers["etag"]})
                    self.assertEqual(cached.status_code, 304)
                    self.assertEqual(cached.headers["cache-control"], "no-cache")
            for name in ("office-day.png", "living-day.png"):
                with self.subTest(image=name):
                    image = client.get(f"/realtime/companion/backgrounds/{name}")
                    self.assertEqual(image.status_code, 200)
                    self.assertNotIn("cache-control", image.headers)

    def test_namespaced_routes_keep_gradio_config_free_and_hide_secret(self):
        with patch.dict(os.environ, {"AUDIOCPP_LLM_API_KEY": "private-test-key"}):
            app = create_app(_models, api_prefix="/api/realtime")
        with TestClient(app) as client:
            response = client.get("/api/realtime/config")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["api_base"], "/api/realtime")
            self.assertTrue(response.json()["llm_api_key_set"])
            self.assertNotIn("private-test-key", response.text)
            self.assertEqual(client.get("/config").status_code, 404)
            self.assertEqual(client.get("/realtime/").status_code, 200)
            self.assertEqual(client.get("/realtime/workbench.css").status_code, 200)

    def test_activation_acquires_before_loading_and_releases_after_failure(self):
        events = []

        def lease(session_id, config):
            events.append(("release" if config is None else "acquire", session_id))

        def loader(model, mode):
            events.append(("load", model))
            raise RuntimeError("private-provider-detail")

        with TestClient(create_app(_models, loader, lease_callback=lease)) as client:
            response = client.post("/activate", json=_config())
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("private-provider-detail", response.text)
        self.assertEqual([event[0] for event in events], ["acquire", "load", "release"])
        self.assertEqual(events[0][1], events[2][1])

    def test_rejected_lease_never_loads_models(self):
        loader = Mock()
        lease = Mock(side_effect=RuntimeError("another session owns this model"))
        with TestClient(create_app(_models, loader, lease_callback=lease)) as client:
            response = client.post("/activate", json=_config())
        self.assertEqual(response.status_code, 503)
        loader.assert_not_called()

    def test_external_asr_does_not_start_managed_asr(self):
        asr_loader = Mock()
        with TestClient(create_app(_models, Mock(return_value="loaded"), managed_asr_loader=asr_loader)) as client:
            response = client.post("/activate", json={
                **_config(), "asr_server": "http://127.0.0.1:9999"})
        self.assertEqual(response.status_code, 200)
        asr_loader.assert_not_called()

    def test_websocket_lease_is_released_on_disconnect(self):
        events = []

        def lease(session_id, config):
            events.append((session_id, None if config is None else config["tts_model"]))

        pipeline = Mock()
        pipeline.drain_events.return_value = []
        app = create_app(_models, Mock(), api_prefix="/api/realtime", lease_callback=lease)
        with patch("realtime_server.RealtimePipeline", return_value=pipeline):
            with TestClient(app) as client:
                with client.websocket_connect("/api/realtime/v1/realtime") as ws:
                    self.assertEqual(ws.receive_json()["type"], "session.created")
                    ws.send_json({"type": "session.update", "session": {"audiocpp": _config()}})
                    self.assertEqual(ws.receive_json()["type"], "session.updated")
        self.assertEqual([event[1] for event in events], ["test-tts", None])
        self.assertEqual(events[0][0], events[1][0])
        pipeline.stop.assert_called_once()
        self.assertEqual(pipeline.configure.call_args.args[0]["tts_stream_sample_rate"], 24000)

    def test_preflight_distinguishes_installed_asr_from_running_model(self):
        request = httpx.Request("GET", "http://127.0.0.1:8081/v1/models")
        response = httpx.Response(200, request=request, json={"data": [{"id": "different-asr"}]})

        async def get(*args, **kwargs):
            return response

        app = create_app(_models, Mock(), asr_catalog_provider=lambda: [{"id": "qwen3-asr"}],
                         managed_asr_loader=Mock())
        with patch("realtime_server.httpx.AsyncClient.get", new=get):
            with TestClient(app) as client:
                result = client.post("/preflight", json=_config()).json()
        self.assertFalse(result["asr"]["ready"])
        self.assertTrue(result["asr"]["can_start"])
        self.assertTrue(result["llm"]["configured"])
        self.assertNotIn("ready", result["llm"])

    def test_websocket_rejects_foreign_origins_before_starting_pipeline(self):
        app = create_app(_models, api_prefix="/api/realtime")
        pipeline = Mock()
        pipeline.drain_events.return_value = []
        with patch("realtime_server.RealtimePipeline", return_value=pipeline) as factory:
            with TestClient(app) as client:
                for origin in ("https://foreign.example", "http://testserver:9999", "null"):
                    with self.subTest(origin=origin), self.assertRaises(WebSocketDisconnect) as rejected:
                        with client.websocket_connect("/api/realtime/v1/realtime", headers={"Origin": origin}):
                            self.fail("Cross-origin WebSocket accepted")
                    self.assertEqual(rejected.exception.code, 1008)
                factory.assert_not_called()
                with client.websocket_connect("/api/realtime/v1/realtime", headers={"Origin": "http://testserver"}) as ws:
                    self.assertEqual(ws.receive_json()["type"], "session.created")
        factory.assert_called_once()

    def test_audio_requires_lease_and_active_model_cannot_be_switched(self):
        events = []

        def lease(session_id, config):
            events.append(None if config is None else config["tts_model"])

        pipeline = Mock()
        pipeline.drain_events.return_value = []
        loader = Mock()
        app = create_app(_models, loader, lease_callback=lease)
        with patch("realtime_server.RealtimePipeline", return_value=pipeline):
            with TestClient(app) as client:
                with client.websocket_connect("/v1/realtime") as ws:
                    ws.receive_json()
                    ws.send_json({"type": "input_audio_buffer.append", "audio": "AAA="})
                    self.assertEqual(ws.receive_json()["error"]["code"], "session_not_ready")
                    pipeline.feed_audio.assert_not_called()
                    ws.send_json({"type": "session.update", "session": {"audiocpp": _config()}})
                    self.assertEqual(ws.receive_json()["type"], "session.updated")
                    ws.send_json({"type": "input_audio_buffer.append", "audio": "AAA="})
                    # The subsequent response acts as a barrier for the queued audio.
                    ws.send_json({"type": "session.update", "session": {"audiocpp": {
                        "tts_model": "different-tts", "tts_playback_mode": "offline"}}})
                    self.assertEqual(ws.receive_json()["error"]["code"], "tts_activation")
                    self.assertEqual(events, ["test-tts"])
                    pipeline.feed_audio.assert_called_once_with(b"\x00\x00")
                    loader.assert_called_once_with("test-tts", "streaming")
        self.assertEqual(events, ["test-tts", None])


if __name__ == "__main__":
    unittest.main()
