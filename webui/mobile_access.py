"""Opt-in LAN HTTPS host for the call-only mobile page.

The workbench remains on loopback. This host shares its model lease, but exposes
neither workbench routes nor editable realtime configuration.
"""
from __future__ import annotations

import asyncio
import copy
from datetime import datetime, timedelta, timezone
import io
import ipaddress
import json
import math
import os
from pathlib import Path
import secrets
import socket
import threading
import time

from fastapi import Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.routing import APIWebSocketRoute
from starlette.datastructures import Headers
from starlette.requests import HTTPConnection
import uvicorn

ROOT = Path(__file__).resolve().parent
COOKIE = "aixora_mobile"
PREFIX = "/api/workbench/mobile"
CHARACTER_IDS = {"companion", "baijie", "lily", "office", "living", "system"}


def public_character(value):
    """Only appearance preferences cross to the phone, never voice paths or keys."""
    value = value if isinstance(value, dict) else {}
    ident = value.get("id", "companion")
    if not isinstance(ident, str) or ident not in CHARACTER_IDS:
        ident = "companion"
    animation = {"mouth": True, "blink": True, "breath": True, "head": True,
                 "shoulders": True, "listening": True, "strength": 1, "delayMs": 90}
    supplied = value.get("animation", {})
    if isinstance(supplied, dict):
        for key in ("mouth", "blink", "breath", "head", "shoulders", "listening"):
            if isinstance(supplied.get(key), bool):
                animation[key] = supplied[key]
        for key, lower, upper in (("strength", .25, 1.5), ("delayMs", 0, 180)):
            number = supplied.get(key)
            if isinstance(number, (int, float)) and not isinstance(number, bool) and math.isfinite(number):
                animation[key] = min(upper, max(lower, number))
    return {"id": ident, "name": str(value.get("name") or "语音助手")[:40], "animation": animation}


def lan_addresses():
    candidates = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("192.0.2.1", 9))  # Route selection only; sends no packet.
            candidates.append(probe.getsockname()[0])
    except OSError:
        pass
    try:
        candidates.extend(item[4][0] for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET))
    except OSError:
        pass
    return list(dict.fromkeys(value for value in candidates
                             if ipaddress.ip_address(value).is_private
                             and not ipaddress.ip_address(value).is_loopback
                             and not ipaddress.ip_address(value).is_link_local))


def ensure_certificate(directory: Path, addresses):
    # Imported on demand so a missing optional dependency cannot break startup
    # when mobile access is off (including older portable environments).
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    directory.mkdir(parents=True, exist_ok=True)
    cert_path, key_path = directory / "cert.pem", directory / "key.pem"
    ips = {ipaddress.ip_address(value) for value in ["127.0.0.1", *addresses]}
    now = datetime.now(timezone.utc)
    try:
        existing = x509.load_pem_x509_certificate(cert_path.read_bytes())
        private_key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
        sans = existing.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        if (ips.issubset(set(sans.get_values_for_type(x509.IPAddress)))
                and existing.not_valid_after_utc > now + timedelta(days=7)
                and existing.public_key().public_numbers() == private_key.public_key().public_numbers()):
            return cert_path, key_path
    except (OSError, ValueError, x509.ExtensionNotFound):
        pass
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Aixora Audio Local")])
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=365))
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ip) for ip in sorted(ips, key=str)]), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False,
                                        key_encipherment=True, data_encipherment=False,
                                        key_agreement=False, key_cert_sign=False, crl_sign=False,
                                        encipher_only=None, decipher_only=None), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .sign(key, hashes.SHA256()))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                          serialization.NoEncryption()))
    try:
        key_path.chmod(0o600)
    except OSError:
        pass
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return cert_path, key_path


class MobileGuard:
    """Authenticate HTTP and WebSocket without buffering streamed audio."""
    def __init__(self, app, manager):
        self.app, self.manager = app, manager

    async def __call__(self, scope, receive, send):
        if scope["type"] not in {"http", "websocket"}:
            return await self.app(scope, receive, send)
        connection = HTTPConnection(scope)
        origin = Headers(scope=scope).get("origin")
        expected = f"https://{connection.url.netloc}"
        host_ok = connection.url.hostname in {*self.manager.addresses, "127.0.0.1", "localhost"}
        origin_ok = (origin == expected if scope["type"] == "websocket" else not origin or origin == expected)
        supplied = connection.cookies.get(COOKIE, "")
        authenticated = secrets.compare_digest(supplied, self.manager.token)
        entry = scope["type"] == "http" and scope["path"] == "/" and connection.query_params.get("token")
        if host_ok and origin_ok and (authenticated or entry):
            return await self.app(scope, receive, send)
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
        else:
            await HTMLResponse("请在电脑的“手机访问”中重新扫描二维码。", status_code=403)(scope, receive, send)


class MobileAccess:
    def __init__(self, work, directory=None, port=None):
        self.work = work
        self.directory = Path(directory) if directory else ROOT / "configs" / "mobile_access"
        self.port = int(port if port is not None else os.environ.get("AUDIOCPP_MOBILE_PORT", "7861"))
        self.lock = threading.RLock()
        self.data = {"enabled": False, "token": secrets.token_urlsafe(32)}
        self.error = ""
        self.server = self.thread = None
        self.addresses = []
        try:
            saved = json.loads((self.directory / "settings.json").read_text(encoding="utf-8"))
            if isinstance(saved, dict) and isinstance(saved.get("token"), str) and len(saved["token"]) >= 32:
                self.data.update(saved)
        except (OSError, ValueError):
            pass
        self.token = self.data["token"]

    def _persist(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        path = self.directory / "settings.json"
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")
        try:
            temp.chmod(0o600)
        except OSError:
            pass
        temp.replace(path)

    def save_config(self, body):
        try:
            from .realtime_server import _OVERRIDABLE_KEYS, _config_from_session
        except ImportError:
            from realtime_server import _OVERRIDABLE_KEYS, _config_from_session
        if not isinstance(body, dict) or not isinstance(body.get("config"), dict):
            raise ValueError("请先在电脑上设置实时语音。")
        config = {k: v for k, v in body["config"].items() if k in _OVERRIDABLE_KEYS}
        for key, value in config.items():
            if key == "tts_options":
                if not isinstance(value, dict) or len(json.dumps(value)) > 16000:
                    raise ValueError("语音参数不正确。")
            elif not isinstance(value, str) or len(value) > 32000:
                raise ValueError("语音配置不正确。")
        if not all(config.get(key, "").strip() for key in ("tts_model", "asr_model", "llm_model")):
            raise ValueError("请先选好语音合成、识别和对话模型。")
        config = _config_from_session({"audiocpp": config})
        character = public_character(body.get("character"))
        gate = body.get("noise_gate", -45)
        if not isinstance(gate, (float, int)) or not -100 <= gate <= 0:
            raise ValueError("麦克风灵敏度不正确。")
        with self.lock:
            self.data["config"] = config
            self.data["character"] = character
            self.data["noise_gate"] = gate
            self._persist()
        return self.status()

    def snapshot(self):
        with self.lock:
            if not self.data.get("config"):
                raise ValueError("请先在电脑上保存语音配置。")
            return copy.deepcopy(self.data["config"])

    def public_info(self):
        with self.lock:
            return {"character": public_character(self.data.get("character")),
                    "noise_gate": self.data.get("noise_gate", -45),
                    "playback_mode": self.data.get("config", {}).get("tts_playback_mode", "auto")}

    def status(self):
        with self.lock:
            running = bool(self.server and self.server.started and not self.server.should_exit
                           and self.thread and self.thread.is_alive())
            cfg = self.data.get("config", {})
            return {"enabled": bool(self.data.get("enabled")), "running": running,
                    "configured": bool(cfg), "error": self.error, "port": self.port,
                    "addresses": self.addresses if running else [],
                    "urls": [f"https://{ip}:{self.port}/?token={self.token}" for ip in self.addresses] if running else [],
                    "character": self.data.get("character", {}).get("name", ""),
                    "models": {k: cfg.get(k, "") for k in ("asr_model", "llm_model", "tts_model")}}

    def create_app(self):
        try:
            from .realtime_server import create_app
        except ImportError:
            from realtime_server import create_app
        app = create_app(model_catalog_provider=self.work.b.realtime_tts_models,
                         managed_tts_loader=self.work.b.load_realtime_tts_model,
                         lease_callback=self.work.lease,
                         managed_asr_loader=self.work.asr.load if self.work.asr and self.work.asr.can_manage else None,
                         fixed_config_provider=self.snapshot, serve_static=False)
        # Deliberately publish only the shared audio transport, not its editable
        # /config, /activate, /preflight or OpenAPI endpoints.
        app.router.routes[:] = [route for route in app.router.routes if isinstance(route, APIWebSocketRoute)]
        app.add_middleware(MobileGuard, manager=self)

        @app.middleware("http")
        async def response_headers(request, call_next):
            response = await call_next(request)
            response.headers.update({"Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
                                     "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
                                     "Permissions-Policy": "microphone=(self), camera=()"})
            return response

        @app.get("/")
        async def index(request: Request):
            token = request.query_params.get("token")
            if token is not None:
                if not secrets.compare_digest(token, self.token):
                    return HTMLResponse("二维码已失效，请在电脑上重新扫码。", status_code=403)
                response = RedirectResponse("/", status_code=303)
                # Lax also permits the redirect after opening a QR link from
                # another app; WebSocket Origin is checked separately.
                response.set_cookie(COOKIE, self.token, secure=True, httponly=True, samesite="lax")
                return response
            return FileResponse(ROOT / "mobile_static" / "index.html")

        @app.get("/info")
        async def info():
            return self.public_info()

        @app.get("/manifest.webmanifest")
        async def manifest():
            # Home-screen apps can have a different cookie jar from Safari.
            # Reuse the same pairing link on launch; the page immediately cleans it.
            return JSONResponse({"name": "Aixora Audio", "short_name": "Aixora",
                                 "id": "/", "start_url": f"/?token={self.token}", "scope": "/",
                                 "display": "standalone", "background_color": "#151310",
                                 "theme_color": "#151310",
                                 "icons": [{"src": "/assets/icon.png", "sizes": "1254x1254", "type": "image/png"}]},
                                media_type="application/manifest+json")

        files = {"call.js": ROOT / "mobile_static" / "call.js", "call.css": ROOT / "mobile_static" / "call.css",
                 "icon.png": ROOT / "workbench_static" / "aixora-audio-logo.png"}
        for relative in ("ws/s2s-ws-client.js", "ws/codec.js", "ws/orb-visualizer.js",
                         "worklets/mic-capture.js", "worklets/audio-playback.js",
                         "companion/live.js", "companion/character.js", "companion/profile.js",
                         "companion/live.css", "avatar/audio-bridge.js"):
            files[relative] = ROOT / "realtime_static" / relative
        for folder in ("", "baijie/", "lily/"):
            for name in ("character.json", "character.png", "face-atlas.png", "face-registration.json"):
                relative = f"companion/assets/{folder}{name}"
                files[relative] = ROOT / "realtime_static" / relative
        for name in ("bedroom-private", "baijie-living-room", "lily-living-room", "office-day", "living-day"):
            relative = f"companion/backgrounds/{name}.png"
            files[relative] = ROOT / "realtime_static" / relative
        for name in ("headaudio", "headworklet", "parameters", "training", "processor", "ringbuffer",
                     "mfcc", "vadgate", "classifier"):
            relative = f"avatar/vendor/headaudio/modules/{name}.mjs"
            files[relative] = ROOT / "realtime_static" / relative
        relative = "avatar/vendor/headaudio/dist/model-en-mixed.bin"
        files[relative] = ROOT / "realtime_static" / relative

        @app.get("/assets/{name:path}")
        async def asset(name: str):
            if name not in files:
                return Response(status_code=404)
            return FileResponse(files[name])
        return app

    def start(self):
        with self.lock:
            if self.server and self.thread and self.thread.is_alive():
                if self.server.should_exit:
                    raise ValueError("上一次通话正在结束，请稍后再开启手机访问。")
                return
            self.snapshot()
            self.addresses = lan_addresses()
            if not self.addresses:
                raise ValueError("没有找到局域网地址，请先连接 Wi-Fi 或有线网络。")
            try:
                import qrcode  # Check both optional dependencies before showing the QR section.
                cert, key = ensure_certificate(self.directory, self.addresses)
            except ImportError as exc:
                raise ValueError("请先更新 WebUI 依赖，再开启手机访问。") from exc
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                listener.bind(("0.0.0.0", self.port))
                listener.listen(128)
                self.port = listener.getsockname()[1]
                server = uvicorn.Server(uvicorn.Config(self.create_app(), log_level="warning", access_log=False,
                                        ssl_certfile=str(cert), ssl_keyfile=str(key), proxy_headers=False,
                                        # A model loader already running in a worker thread must
                                        # finish before its lease can be released.
                                        timeout_graceful_shutdown=None, ws_max_size=256 * 1024))
                self.server = server
                self.thread = threading.Thread(target=lambda: server.run(sockets=[listener]),
                                               daemon=True, name="mobile-access")
                self.thread.start()
                deadline = time.monotonic() + 8
                while not server.started and self.thread.is_alive() and time.monotonic() < deadline:
                    time.sleep(0.025)
                if not server.started:
                    server.should_exit = True
                    raise ValueError("手机访问服务启动失败，请稍后重试。")
                self.error = ""
            except OSError as exc:
                listener.close()
                raise ValueError(f"手机访问端口 {self.port} 无法使用，请关闭占用该端口的程序。") from exc
            except Exception:
                listener.close()
                raise

    def stop(self, timeout=12):
        # Do not hold the config lock while joining: a finishing WS may need it.
        server, thread = self.server, self.thread
        if server:
            server.should_exit = True
        if thread:
            thread.join(timeout=timeout)
            if thread.is_alive():
                raise ValueError("通话正在结束，请稍后重试关闭手机访问。")
        self.server = self.thread = None

    def set_enabled(self, enabled):
        if not isinstance(enabled, bool):
            raise ValueError("开关值不正确。")
        if enabled:
            self.start()
        else:
            with self.lock:
                self.data["enabled"] = False
                self._persist()
            self.stop()
        with self.lock:
            self.data["enabled"] = enabled
            self._persist()
        return self.status()

    def resume(self):
        if self.data.get("enabled"):
            try:
                self.start()
            except Exception as exc:
                self.error = str(exc)


def install_mobile_routes(app, work, directory=None):
    manager = MobileAccess(work, directory=directory)
    # Serialize changes without blocking the desktop event loop.
    mutation_lock = asyncio.Lock()
    app.state.mobile_access = manager

    @app.get(PREFIX)
    async def status():
        return manager.status()

    @app.post(PREFIX)
    async def enable(request: Request):
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError("开关值不正确。")
        async with mutation_lock:
            return await asyncio.to_thread(manager.set_enabled, body.get("enabled"))

    @app.post(f"{PREFIX}/config")
    async def save(request: Request):
        body = await request.json()
        async with mutation_lock:
            return await asyncio.to_thread(manager.save_config, body)

    @app.get(f"{PREFIX}/qr")
    async def qr(address: str = ""):
        state = manager.status()
        if not state["running"] or address not in state["addresses"]:
            return JSONResponse({"detail": "请先开启手机访问。"}, status_code=400)
        import qrcode
        buffer = io.BytesIO()
        qrcode.make(state["urls"][state["addresses"].index(address)]).save(buffer, format="PNG")
        return Response(buffer.getvalue(), media_type="image/png")
    return manager
