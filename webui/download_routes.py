"""Bounded Hugging Face route selection for the downstream model manager.

Routes change transport only: the repository, revision and file stay the same.
No proxy ports are scanned, and Hugging Face credentials never go to a mirror.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

OFFICIAL = "https://huggingface.co"
MIRROR = "https://hf-mirror.com"
PROBE_BYTES = 64 * 1024
PROBE_TIMEOUT = 3.0


def _route_event(phase: str, route=""):
    print("AUDIOCPP_DOWNLOAD_ROUTE " + json.dumps({"phase": phase, "route": route}), flush=True)


def _official(url: str) -> bool:
    parsed = urlsplit(url)
    return (parsed.scheme == "https" and parsed.hostname == "huggingface.co"
            and parsed.port in (None, 443) and not parsed.username)


def _safe_headers(url: str, headers: dict) -> dict:
    return {key: value for key, value in headers.items()
            if key.lower() not in ("authorization", "proxy-authorization", "cookie")
            or (key.lower() == "authorization" and _official(url))}


def _identity(headers) -> dict:
    commit = str(headers.get("X-Repo-Commit", ""))
    etag = str(headers.get("X-Linked-Etag") or headers.get("ETag", "")).strip('"')
    result = {}
    if re.fullmatch(r"[0-9a-fA-F]{40}", commit):
        result["commit"] = commit.lower()
    if re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", etag):
        result["etag"] = etag.lower()
    size = headers.get("X-Linked-Size")
    match = re.fullmatch(r"bytes \d+-\d+/(\d+)", headers.get("Content-Range", ""))
    if match:
        size = match.group(1)
    if size and str(size).isdigit():
        result["size"] = int(size)
    return result


def same_identity(left: dict, right: dict) -> bool:
    if not left or not right:
        return False
    if any(left[key] != right[key] for key in ("commit", "etag", "size")
           if key in left and key in right):
        return False
    return any(left.get(key) and left.get(key) == right.get(key)
               for key in ("commit", "etag"))


def _conflicting_identity(left: dict, right: dict) -> bool:
    return any(left[key] != right[key] for key in ("commit", "etag", "size")
               if key in left and key in right)


class SafeRedirectHandler(HTTPRedirectHandler):
    max_redirections = 3

    def __init__(self, deadline=None):
        self.deadline = deadline
        self.identity = {}

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(newurl).scheme != "https":
            raise URLError("download redirect must use HTTPS")
        if self.deadline and time.monotonic() >= self.deadline:
            raise TimeoutError("route probe timed out")
        self.identity.update(_identity(headers))
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None:
            for key in list(redirected.headers):
                if key not in _safe_headers(newurl, redirected.headers):
                    redirected.remove_header(key)
        return redirected


@dataclass(frozen=True)
class Route:
    endpoint: str
    proxy: str = ""

    @property
    def label(self):
        return ("HF official" if self.endpoint == OFFICIAL else "HF mirror") + (
            " via detected proxy" if self.proxy else " direct")

    def url(self, source: str, commit="") -> str:
        parsed = urlsplit(source)
        path = parsed.path
        if commit:
            path = re.sub(r"(/resolve/)[^/]+/", lambda m: m[1] + commit + "/", path, count=1)
        return self.endpoint + path

    def open(self, request: Request, timeout: float, deadline=None):
        redirect = SafeRedirectHandler(deadline)
        proxies = {"http": self.proxy, "https": self.proxy} if self.proxy else {}
        opener = build_opener(ProxyHandler(proxies), redirect)
        response = opener.open(request, timeout=timeout)
        identity = dict(redirect.identity)
        # CDN response ETags can describe multipart transfers, so prefer Hub metadata.
        for key, value in _identity(response.headers).items():
            identity.setdefault(key, value)
        if response.getcode() == 200 and "size" not in identity:
            length = response.headers.get("Content-Length", "")
            if str(length).isdigit():
                identity["size"] = int(length)
        response.download_identity = identity
        return response


def candidate_routes() -> list[Route]:
    """Read configured proxies only; urllib's registry reader covers Windows settings."""
    proxies = urllib.request.getproxies_environment()
    registry_reader = getattr(urllib.request, "getproxies_registry", None)
    system = registry_reader() if registry_reader else {}
    detected = []
    for settings in (proxies, system):
        value = settings.get("https") or settings.get("http") or settings.get("all")
        if value:
            value = value if "://" in value else "http://" + value
            if urlsplit(value).scheme in ("http", "https") and value not in detected:
                detected.append(value)
    mode = os.environ.get("AUDIOCPP_DOWNLOAD_ROUTE", "auto").strip().lower()
    endpoint = os.environ.get("HF_ENDPOINT", "").strip().rstrip("/")
    if mode not in ("auto", "official", "mirror"):
        raise ValueError("AUDIOCPP_DOWNLOAD_ROUTE must be auto, official or mirror")
    if endpoint and endpoint not in (OFFICIAL, MIRROR):
        raise ValueError("HF_ENDPOINT must be https://huggingface.co or https://hf-mirror.com")
    endpoints = [OFFICIAL, MIRROR] if mode == "auto" else [OFFICIAL if mode == "official" else MIRROR]
    if endpoint:
        endpoints = [endpoint]
    return [Route(base, proxy) for base in endpoints for proxy in ["", *detected]]


def _probe(route: Route, source: str, headers: dict):
    start = time.monotonic()
    request = Request(route.url(source), headers={
        **_safe_headers(route.url(source), headers), "Range": f"bytes=0-{PROBE_BYTES - 1}"})
    with route.open(request, PROBE_TIMEOUT, start + PROBE_TIMEOUT) as response:
        # Even servers ignoring Range cannot make us consume a whole model.
        consumed = 0
        read = getattr(response, "read1", response.read)
        while consumed < PROBE_BYTES and time.monotonic() - start < PROBE_TIMEOUT:
            chunk = read(min(16 * 1024, PROBE_BYTES - consumed))
            if not chunk:
                break
            consumed += len(chunk)
        if not consumed:
            raise URLError("empty route probe")
        elapsed = max(time.monotonic() - start, 0.001)
        if elapsed > PROBE_TIMEOUT:
            raise TimeoutError("route probe timed out")
        return elapsed / consumed, response.download_identity


class DownloadRoutes:
    def __init__(self, source: str, headers: dict):
        self.source = source
        self.routes = candidate_routes()
        self.index = 0
        self.identity = {}
        automatic = os.environ.get("AUDIOCPP_DOWNLOAD_AUTO", "1").lower() not in ("0", "false", "off")
        if automatic:
            _route_event("probing")
            pool = ThreadPoolExecutor(max_workers=len(self.routes), thread_name_prefix="download-route")
            futures = {pool.submit(_probe, route, source, headers): route for route in self.routes}
            done, pending = wait(futures, timeout=PROBE_TIMEOUT + 0.5)
            for future in pending:
                future.cancel()
            pool.shutdown(wait=False, cancel_futures=True)
            results, auth_error = [], None
            for future in done:
                route = futures[future]
                try:
                    score, identity = future.result()
                    results.append((score, route, identity))
                except HTTPError as error:
                    if error.code in (401, 403) and route.endpoint == OFFICIAL:
                        auth_error = error
                except (URLError, TimeoutError, HTTPException, OSError):
                    pass
            if auth_error and not any(row[1].endpoint == OFFICIAL for row in results):
                raise auth_error
            if results:
                results.sort(key=lambda row: row[0])
                # Prefer official identity evidence, regardless of its transfer speed.
                canonical = next((row[2] for row in results if row[1].endpoint == OFFICIAL), results[0][2])
                verified = [row for row in results if row[2] == canonical or same_identity(canonical, row[2])]
                self.routes = [row[1] for row in verified]
                self.identity = canonical
        _route_event("selected", self.routes[0].label)

    def open(self, request: Request, timeout: float):
        route = self.routes[self.index]
        url = route.url(self.source, self.identity.get("commit", ""))
        headers = _safe_headers(url, dict(request.header_items()))
        previous = getattr(request, "download_identity", {})
        if any(key.lower() == "range" for key in headers) and not same_identity(previous, self.identity):
            headers = {key: value for key, value in headers.items() if key.lower() != "range"}
            _route_event("restart", route.label)
        response = route.open(Request(url, headers=headers, method=request.get_method()), timeout)
        current = response.download_identity
        if _conflicting_identity(self.identity, current):
            response.close()
            raise URLError("remote file identity changed during download")
        self.identity = {**self.identity, **current}
        response.download_identity = self.identity
        return response

    def failed(self):
        if len(self.routes) > 1:
            self.index = (self.index + 1) % len(self.routes)
            _route_event("fallback", self.routes[self.index].label)


_routes: dict[str, DownloadRoutes] = {}


def urlopen(request: Request, timeout=60):
    source = request.full_url
    if source not in _routes:
        _routes[source] = DownloadRoutes(source, dict(request.header_items()))
    return _routes[source].open(request, timeout)


def route_failed(source: str):
    if source in _routes:
        _routes[source].failed()


def route_label(source: str) -> str:
    plan = _routes.get(source)
    return plan.routes[plan.index].label if plan else ""


def _state_path(output: Path) -> Path:
    return output.with_name(output.name + ".download.json")


def bind_resume_identity(request: Request, output: Path):
    try:
        value = json.loads(_state_path(output).read_text(encoding="utf-8"))
        request.download_identity = value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        request.download_identity = {}


def save_resume_identity(response, output: Path):
    identity = getattr(response, "download_identity", None)
    if identity:
        _state_path(output).write_text(json.dumps(identity), encoding="utf-8")


def clear_resume_identity(output: Path):
    _state_path(output).unlink(missing_ok=True)
