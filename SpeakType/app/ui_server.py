from __future__ import annotations

import asyncio
import socket
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import AppConfig
from app.event_bus import UiEventHub


class UiServer:
    def __init__(
        self,
        config: AppConfig,
        event_hub: UiEventHub,
        state_provider: Callable[[], str],
        web_root: Path,
    ) -> None:
        self.config = config
        self.event_hub = event_hub
        self.state_provider = state_provider
        self.web_root = web_root
        self.app = self._create_app()
        self._server: uvicorn.Server | None = None
        self._thread: threading.Thread | None = None

    def _public_config(self) -> dict[str, Any]:
        if self.config.demo.mock:
            mode = "MOCK"
        elif self.config.asr.transport == "streaming":
            mode = "VAD + SSE"
        else:
            mode = "SEGMENT MODE"
        return {
            "model": self.config.asr.model,
            "mode": mode,
            "toggle_hotkey": self.config.hotkeys.toggle_recording,
            "cancel_hotkey": self.config.hotkeys.cancel_current,
        }

    def _create_app(self) -> FastAPI:
        app = FastAPI(title="SpeakType UI", docs_url=None, redoc_url=None)
        app.mount("/assets", StaticFiles(directory=self.web_root), name="assets")

        @app.get("/")
        async def index() -> FileResponse:
            return FileResponse(self.web_root / "index.html")

        @app.get("/api/config")
        async def public_config() -> JSONResponse:
            return JSONResponse(self._public_config())

        @app.get("/health")
        async def health() -> JSONResponse:
            return JSONResponse({"status": "ok", "state": self.state_provider()})

        @app.websocket("/ws/ui")
        async def ui_websocket(websocket: WebSocket) -> None:
            await websocket.accept()
            subscriber_id, queue, snapshot = self.event_hub.subscribe()
            try:
                await websocket.send_json({"type": "config", **self._public_config()})
                for event in snapshot:
                    await websocket.send_json(event)
                while True:
                    await websocket.send_json(await queue.get())
            except (WebSocketDisconnect, RuntimeError):
                pass
            finally:
                self.event_hub.unsubscribe(subscriber_id)

        return app

    def start(self) -> None:
        uvicorn_config = uvicorn.Config(
            self.app,
            host=self.config.ui.host,
            port=self.config.ui.port,
            log_level="warning",
            access_log=False,
        )
        self._server = uvicorn.Server(uvicorn_config)
        self._thread = threading.Thread(target=self._server.run, name="ui-server", daemon=True)
        self._thread.start()
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            try:
                with socket.create_connection((self.config.ui.host, self.config.ui.port), timeout=0.2):
                    return
            except OSError:
                time.sleep(0.05)
        raise RuntimeError(f"UI server did not start on {self.config.ui.host}:{self.config.ui.port}")

    def stop(self) -> None:
        if self._server is not None:
            self._server.should_exit = True
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None
