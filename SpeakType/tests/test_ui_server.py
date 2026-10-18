from pathlib import Path
from dataclasses import replace
import os

from fastapi.testclient import TestClient

from app.config import load_config
from app.event_bus import UiEventHub
from app.ui_server import UiServer


def test_ui_routes_and_initial_websocket_snapshot() -> None:
    config = load_config("config.json")
    config = replace(config, ui=replace(config.ui, language="en"))
    hub = UiEventHub()
    server = UiServer(config, hub, lambda: "idle", Path("web"))
    with TestClient(server.app) as client:
        index = client.get("/")
        assert index.status_code == 200
        assert index.headers["cache-control"] == "no-cache"
        script = client.get("/assets/app.js?v=2")
        assert script.headers["cache-control"] == "no-cache"
        cached = client.get("/assets/app.js?v=2", headers={"If-None-Match": script.headers["etag"]})
        assert cached.status_code == 304
        assert cached.headers["cache-control"] == "no-cache"
        assert 'id="close-button"' in index.text
        assert client.get("/assets/styles.css").status_code == 200
        assert "pywebview.api.close" in client.get("/assets/app.js").text
        assert client.get("/health").json() == {"status": "ok", "state": "idle",
                                               "application": "SpeakType", "pid": os.getpid(), "ready": False}
        server.ready = True
        assert client.get("/health").json()["ready"] is True
        public = client.get("/api/config").json()
        assert public["model"] == "nemotron-asr"
        assert public["mode"] == "VAD + SSE"
        assert public["ui_language"] == "en"
        assert client.get("/studio-copy/i18n.js").status_code == 200
        assert client.get("/studio-copy/locales/en.json").json()["正在听写"] == "Dictating"
        with client.websocket_connect("/ws/ui") as websocket:
            assert websocket.receive_json()["type"] == "config"
            assert websocket.receive_json() == {"type": "state", "value": "idle"}
