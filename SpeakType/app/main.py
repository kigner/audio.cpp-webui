from __future__ import annotations

import argparse
import logging
import sys
import threading
import uuid
from dataclasses import replace
from logging.handlers import RotatingFileHandler
from pathlib import Path

from app.config import load_config
from app.controller import SessionController
from app.event_bus import UiEventHub
from app.overlay import OverlayWindow
from app.ui_server import UiServer


ROOT = Path(__file__).resolve().parents[1]


def configure_logging() -> None:
    log_dir = ROOT / "logs"
    log_dir.mkdir(exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    handler = RotatingFileHandler(
        log_dir / "app.log",
        maxBytes=2_000_000,
        backupCount=3,
        encoding="utf-8",
    )
    handler.setFormatter(fmt)
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)
    root_logger.addHandler(handler)
    # Mirror logs to the console for direct run.py launches. Under pythonw,
    # sys.stderr is None, so skip to avoid handler errors.
    if sys.stderr is not None:
        console = logging.StreamHandler()
        console.setFormatter(fmt)
        root_logger.addHandler(console)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="SpeakType local ASR dictation demo")
    parser.add_argument("--config", type=Path, default=ROOT / "config.json")
    parser.add_argument("--mock", action="store_true", help="use the local mock ASR adapter")
    parser.add_argument("--stop-file", type=Path, help="workbench-owned shutdown signal")
    return parser.parse_args()


def main() -> int:
    configure_logging()
    args = parse_args()
    config = load_config(args.config)
    if args.mock:
        config = replace(config, demo=replace(config.demo, mock=True))

    event_hub = UiEventHub()
    controller = SessionController(config, event_hub)
    ui_server = UiServer(config, event_hub, lambda: controller.state, ROOT / "web")
    # Bust the document cache too: an old cached HTML page cannot see new asset URLs.
    overlay = OverlayWindow(config.ui, f"http://{config.ui.host}:{config.ui.port}/?launch={uuid.uuid4().hex}")
    logging.getLogger(__name__).info("SpeakType source=%s web=%s", ROOT, ui_server.web_root)
    stopped = threading.Event()

    try:
        ui_server.start()
        controller.start()
        overlay.create()
        def ready():
            ui_server.ready = True
            event_hub.publish({"type": "notice", "value": "ready", "message": "READY"})
            if args.stop_file:
                def watch_stop():
                    while not stopped.wait(0.2):
                        if args.stop_file.exists():
                            overlay.close()
                            return
                threading.Thread(target=watch_stop, daemon=True, name="workbench-stop").start()

        overlay.run(ready)
        return 0
    except Exception:
        logging.getLogger(__name__).exception("application stopped after an unrecoverable error")
        return 1
    finally:
        stopped.set()
        controller.shutdown()
        ui_server.stop()

