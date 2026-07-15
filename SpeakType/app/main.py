from __future__ import annotations

import argparse
import logging
import sys
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
    # Mirror logs to the console when one exists (run_speaktype.bat / run.py). Under
    # pythonw (run_speaktype.pyw) sys.stderr is None, so skip to avoid handler errors.
    if sys.stderr is not None:
        console = logging.StreamHandler()
        console.setFormatter(fmt)
        root_logger.addHandler(console)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="SpeakType local ASR dictation demo")
    parser.add_argument("--config", type=Path, default=ROOT / "config.json")
    parser.add_argument("--mock", action="store_true", help="use the local mock ASR adapter")
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
    overlay = OverlayWindow(config.ui, f"http://{config.ui.host}:{config.ui.port}")

    try:
        ui_server.start()
        controller.start()
        overlay.create()
        overlay.run(lambda: event_hub.publish({"type": "notice", "value": "ready", "message": "READY"}))
        return 0
    except Exception:
        logging.getLogger(__name__).exception("application stopped after an unrecoverable error")
        return 1
    finally:
        controller.shutdown()
        ui_server.stop()

