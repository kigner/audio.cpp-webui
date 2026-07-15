from pathlib import Path

from fastapi.testclient import TestClient

from app.config import load_config
from app.event_bus import UiEventHub
from app.ui_server import UiServer


def test_ui_routes_and_initial_websocket_snapshot() -> None:
    config = load_config("config.json")
    hub = UiEventHub()
    server = UiServer(config, hub, lambda: "idle", Path("web"))
    with TestClient(server.app) as client:
        assert client.get("/").status_code == 200
        assert client.get("/assets/styles.css").status_code == 200
        assert client.get("/health").json() == {"status": "ok", "state": "idle"}
        public = client.get("/api/config").json()
        assert public["model"] == "nemotron-asr"
        assert public["mode"] == "VAD + SSE"
        with client.websocket_connect("/ws/ui") as websocket:
            assert websocket.receive_json()["type"] == "config"
            assert websocket.receive_json() == {"type": "state", "value": "idle"}
