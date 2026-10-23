"""LAN HTTPS, call configuration isolation and shared model ownership."""
import base64
import json
from pathlib import Path
import socket
import ssl
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from cryptography import x509
from fastapi.testclient import TestClient
from fastapi import FastAPI
from fastapi.responses import JSONResponse
import httpx
from starlette.websockets import WebSocketDisconnect

from mobile_access import MobileAccess, ensure_certificate, COOKIE, install_mobile_routes
from realtime_pipeline import PipelineError
from workbench_server import Workbench


class MobileAccessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        backend = SimpleNamespace(OUTPUT_DIR=self.temp.name,
                                  realtime_tts_models=lambda: [{"id":"test-tts", "supports_streaming":False}],
                                  load_realtime_tts_model=Mock())
        self.work = Workbench(backend)
        self.work.asr = SimpleNamespace(can_manage=True, load=Mock())
        self.manager = MobileAccess(self.work, directory=Path(self.temp.name)/"mobile", port=0)
        self.addCleanup(self.manager.stop)
        self.manager.addresses = ["192.168.1.7"]
        self.config = {"config": {"tts_model":"test-tts", "tts_server_source":"managed",
                                  "tts_playback_mode":"offline", "asr_model":"test-asr",
                                  "asr_server":"http://127.0.0.1:8081", "llm_model":"test-llm",
                                  "llm_api_key":"server-only-secret", "instructions":"computer instructions"},
                       "character":{"name":"小暖"}, "noise_gate":-48}
        self.manager.save_config(self.config)

    def client(self):
        client = TestClient(self.manager.create_app(), base_url="https://192.168.1.7")
        client.get(f"/?token={self.manager.token}")
        return client

    def test_pairing_cookie_and_only_call_assets_are_public(self):
        with TestClient(self.manager.create_app(), base_url="https://192.168.1.7") as client:
            self.assertEqual(client.get("/").status_code, 403)
            self.assertEqual(client.get("/?token=wrong").status_code, 403)
            entry = client.get(f"/?token={self.manager.token}", follow_redirects=False)
            self.assertEqual(entry.status_code, 303)
            self.assertEqual(entry.headers["location"], "/")
            self.assertIn("HttpOnly", entry.headers["set-cookie"])
            self.assertIn("Secure", entry.headers["set-cookie"])
            self.assertEqual(client.get("/").status_code, 200)
            for path in ("/config", "/activate", "/preflight", "/openapi.json", "/docs",
                         "/api/workbench/health", "/api/workbench/mobile", "/realtime/",
                         "/assets/../configs/mobile_access/settings.json", "/assets/main.js"):
                with self.subTest(path=path):
                    self.assertEqual(client.get(path).status_code, 404)
            for path in ("call.js", "call.css", "ws/s2s-ws-client.js", "ws/codec.js", "ws/orb-visualizer.js",
                         "worklets/mic-capture.js", "worklets/audio-playback.js"):
                self.assertEqual(client.get(f"/assets/{path}").status_code, 200)
            info = client.get("/info")
            self.assertEqual(info.json()["character"]["name"], "小暖")
            self.assertNotIn("server-only-secret", info.text)
            self.assertNotIn("instructions", info.text)
            self.assertEqual(client.get("/info", headers={"Origin":"https://foreign.example"}).status_code, 403)
            self.assertEqual(client.get("/info", headers={"Host":"foreign.example"}).status_code, 403)
        self.assertNotIn("server-only-secret", json.dumps(self.manager.status()))

    def test_config_is_fixed_for_call_and_models_are_leased(self):
        pipeline = Mock()
        pipeline.drain_events.return_value = []
        with patch("realtime_server.RealtimePipeline", return_value=pipeline), self.client() as client:
            with client.websocket_connect("wss://192.168.1.7/v1/realtime", headers={"Origin":"https://192.168.1.7"}) as ws:
                self.assertEqual(ws.receive_json()["type"], "session.created")
                ws.send_json({"type":"session.update", "session":{"instructions":"attacker", "audiocpp":{
                    "tts_model":"attacker", "llm_api_key":"attacker", "llm_base_url":"http://foreign.example"}}})
                self.assertEqual(ws.receive_json()["type"], "session.updated")
                configured = pipeline.configure.call_args.args[0]
                self.assertEqual(configured["tts_model"], "test-tts")
                self.assertEqual(configured["llm_api_key"], "server-only-secret")
                self.assertEqual(configured["instructions"], "computer instructions")
                self.work.b.load_realtime_tts_model.assert_called_once_with("test-tts", "offline")
                self.work.asr.load.assert_called_once_with("test-asr")
                self.assertEqual(len(self.work.leases), 1)
                with self.assertRaises(RuntimeError):
                    self.work.lease("desktop", {"tts_model":"test-tts"})
                self.config["config"]["instructions"] = "next call instructions"
                self.manager.save_config(self.config)
                ws.send_json({"type":"user.text", "text":"phone must not send text"})
                ws.send_json({"type":"input_audio_buffer.append", "audio":base64.b64encode(b"\0\0").decode()})
                ws.send_json({"type":"session.update", "session":{"audiocpp":{"tts_model":"attacker"}}})
                self.assertEqual(ws.receive_json()["type"], "session.updated")
                pipeline.configure.assert_called_once()
                pipeline.feed_text.assert_not_called()
                pipeline.feed_audio.assert_called_once_with(b"\0\0")
            # TestClient sends a disconnect before the worker-thread lease
            # release necessarily finishes; wait for that observable cleanup.
            deadline = time.monotonic() + 2
            while self.work.leases and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertFalse(self.work.leases)
            with client.websocket_connect("wss://192.168.1.7/v1/realtime", headers={"Origin":"https://192.168.1.7"}) as ws:
                ws.receive_json()
                ws.send_json({"type":"session.update"})
                self.assertEqual(ws.receive_json()["type"], "session.updated")
                self.assertEqual(pipeline.configure.call_args.args[0]["instructions"], "next call instructions")
        self.assertFalse(self.work.leases)

    def test_ws_rejects_missing_pairing_and_foreign_or_missing_origin(self):
        with patch("realtime_server.RealtimePipeline") as factory, self.client() as client:
            for headers in ({}, {"Origin":"https://foreign.example"}, {"Origin":"null"}):
                with self.assertRaises(WebSocketDisconnect):
                    with client.websocket_connect("wss://192.168.1.7/v1/realtime", headers=headers):
                        self.fail("unauthorized websocket")
            client.cookies.clear()
            with self.assertRaises(WebSocketDisconnect):
                with client.websocket_connect("wss://192.168.1.7/v1/realtime", headers={"Origin":"https://192.168.1.7"}):
                    self.fail("unpaired websocket")
            factory.assert_not_called()

    def test_failed_activation_releases_lease(self):
        pipeline = Mock()
        pipeline.drain_events.return_value = []
        self.work.asr.load.side_effect = RuntimeError("private path or key")
        with patch("realtime_server.RealtimePipeline", return_value=pipeline), self.client() as client:
            with client.websocket_connect("wss://192.168.1.7/v1/realtime", headers={"Origin":"https://192.168.1.7"}) as ws:
                ws.receive_json()
                ws.send_json({"type":"session.update"})
                error = ws.receive_json()
                self.assertEqual(error["type"], "error")
                self.assertNotIn("private path", json.dumps(error))
                self.assertFalse(self.work.leases)
                self.work.b.load_realtime_tts_model.assert_not_called()

    def test_certificate_reused_and_renewed_for_changed_ip(self):
        first, _ = ensure_certificate(self.manager.directory, ["192.168.1.7"])
        original = first.read_bytes()
        cert = x509.load_pem_x509_certificate(original)
        self.assertIn("192.168.1.7", str(cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value))
        ensure_certificate(self.manager.directory, ["192.168.1.7"])
        self.assertEqual(first.read_bytes(), original)
        ensure_certificate(self.manager.directory, ["192.168.1.8"])
        self.assertNotEqual(first.read_bytes(), original)

    def test_pipeline_errors_do_not_expose_backend_details(self):
        pipeline = Mock()
        events = []
        def drain():
            batch = list(events)
            events.clear()
            return batch
        pipeline.drain_events.side_effect = drain
        with patch("realtime_server.RealtimePipeline", return_value=pipeline), self.client() as client:
            with client.websocket_connect("wss://192.168.1.7/v1/realtime", headers={"Origin":"https://192.168.1.7"}) as ws:
                ws.receive_json()
                ws.send_json({"type":"session.update"})
                ws.receive_json()
                events.append(PipelineError(stage="llm", code="llm_http", message="server-only-secret in request URL"))
                response = ws.receive_json()
                self.assertEqual(response["type"], "error")
                self.assertNotIn("server-only-secret", json.dumps(response))

    def test_character_preferences_are_saved_without_voice_or_server_details(self):
        self.config["character"] = {"id":"lily", "name":"Lily", "referenceAudio":"private-voice.wav",
                                    "llm_api_key":"server-only-secret", "animation":{
                                        "blink":False, "mouth":True, "strength":999, "delayMs":-1,
                                        "head":"false", "private":"secret"}}
        self.manager.save_config(self.config)
        info = self.manager.public_info()
        self.assertEqual(info["character"]["id"], "lily")
        animation = info["character"]["animation"]
        self.assertEqual(animation["strength"], 1.5)
        self.assertEqual(animation["delayMs"], 0)
        self.assertFalse(animation["blink"])
        self.assertTrue(animation["head"])
        self.assertNotIn("private", json.dumps(info))
        self.assertNotIn("server-only-secret", json.dumps(info))
        self.manager.data["character"] = {"name":"旧版配置"}
        self.assertEqual(self.manager.public_info()["character"]["id"], "companion")

    def test_home_screen_launch_can_pair_without_safari_cookies(self):
        with self.client() as client:
            manifest = client.get("/manifest.webmanifest").json()
            self.assertEqual(manifest["display"], "standalone")
            self.assertEqual(client.get(manifest["icons"][0]["src"]).status_code, 200)
            client.cookies.clear()
            self.assertEqual(client.get("/manifest.webmanifest").status_code, 403)
            self.assertEqual(client.get(manifest["start_url"]).status_code, 200)
            self.assertEqual(client.get("/info").status_code, 200)

    def test_desktop_save_enable_qr_and_disable_routes(self):
        app = FastAPI()
        @app.exception_handler(ValueError)
        async def bad_request(_, error):
            return JSONResponse({"detail":str(error)}, status_code=400)
        manager = install_mobile_routes(app, self.work, directory=Path(self.temp.name)/"routes")
        manager.port = 0
        self.addCleanup(manager.stop)
        with TestClient(app) as client, patch("mobile_access.lan_addresses", return_value=["192.168.1.7"]):
            self.assertFalse(client.get("/api/workbench/mobile").json()["configured"])
            self.assertEqual(client.post("/api/workbench/mobile", json={"enabled":True}).status_code, 400)
            saved = client.post("/api/workbench/mobile/config", json=self.config)
            self.assertEqual(saved.status_code, 200)
            self.assertNotIn("server-only-secret", saved.text)
            self.assertTrue(client.post("/api/workbench/mobile", json={"enabled":True}).json()["running"])
            qr = client.get("/api/workbench/mobile/qr?address=192.168.1.7")
            self.assertEqual(qr.status_code, 200)
            self.assertTrue(qr.content.startswith(b"\x89PNG\r\n"))
            self.assertEqual(client.get("/api/workbench/mobile/qr?address=foreign.example").status_code, 400)
            self.assertFalse(client.post("/api/workbench/mobile", json={"enabled":False}).json()["running"])
            self.assertEqual(client.get("/api/workbench/mobile/qr?address=192.168.1.7").status_code, 400)

    def test_listener_enable_disable_and_saved_settings(self):
        self.assertFalse(self.manager.status()["enabled"])
        with patch("mobile_access.lan_addresses", return_value=["192.168.1.7"]):
            result = self.manager.set_enabled(True)
            self.assertTrue(result["running"])
            with httpx.Client(verify=False, trust_env=False) as client:
                response = client.get(f"https://127.0.0.1:{self.manager.port}/?token={self.manager.token}", follow_redirects=True)
                self.assertEqual(response.status_code, 200)
            same_thread = self.manager.thread
            self.manager.set_enabled(True)
            self.assertIs(self.manager.thread, same_thread)
        from websockets.sync.client import connect
        from websockets.exceptions import ConnectionClosed
        pipeline = Mock()
        pipeline.drain_events.return_value = []
        with patch("realtime_server.RealtimePipeline", return_value=pipeline):
            origin = f"https://127.0.0.1:{self.manager.port}"
            with connect(origin.replace("https:", "wss:") + "/v1/realtime",
                         ssl=ssl._create_unverified_context(), origin=origin,
                         additional_headers={"Cookie":f"{COOKIE}={self.manager.token}"}) as ws:
                ws.recv()
                ws.send(json.dumps({"type":"session.update"}))
                self.assertEqual(json.loads(ws.recv())["type"], "session.updated")
                self.assertTrue(self.work.leases)
                self.manager.set_enabled(False)
                with self.assertRaises(ConnectionClosed):
                    ws.recv()
        self.assertFalse(self.work.leases)
        with socket.socket() as probe:
            probe.settimeout(.5)
            self.assertNotEqual(probe.connect_ex(("127.0.0.1", self.manager.port)), 0)
        restored = MobileAccess(self.work, directory=self.manager.directory)
        self.assertFalse(restored.status()["enabled"])
        self.assertEqual(restored.snapshot()["llm_api_key"], "server-only-secret")

    def test_stop_during_model_loading_keeps_lease_until_loader_finishes(self):
        from websockets.sync.client import connect
        entered, finish = threading.Event(), threading.Event()
        self.addCleanup(finish.set)
        self.work.b.load_realtime_tts_model.side_effect = lambda *_: (entered.set(), finish.wait(5))
        pipeline = Mock()
        pipeline.drain_events.return_value = []
        with patch("mobile_access.lan_addresses", return_value=["192.168.1.7"]), patch("realtime_server.RealtimePipeline", return_value=pipeline):
            self.manager.start()
            origin = f"https://127.0.0.1:{self.manager.port}"
            with connect(origin.replace("https:", "wss:") + "/v1/realtime", ssl=ssl._create_unverified_context(),
                         origin=origin, additional_headers={"Cookie":f"{COOKIE}={self.manager.token}"}) as ws:
                ws.recv()
                ws.send(json.dumps({"type":"session.update"}))
                self.assertTrue(entered.wait(2))
                with self.assertRaises(ValueError):
                    self.manager.stop(timeout=.05)
                self.assertFalse(self.manager.status()["running"])
                self.assertTrue(self.work.leases)
                finish.set()
                self.manager.stop()
            self.assertFalse(self.work.leases)


if __name__ == "__main__":
    unittest.main()
