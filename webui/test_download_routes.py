"""Network-free checks for route selection, credentials and resumable downloads."""
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import Request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import download_routes as routes
import model_manager_webui as manager

COMMIT = "a" * 40
OTHER_COMMIT = "b" * 40
SOURCE = "https://huggingface.co/audio-cpp/demo/resolve/main/model.gguf"
IDENTITY = {"commit": COMMIT, "etag": "c" * 64, "size": 10}


class Response(io.BytesIO):
    def __init__(self, data=b"0123456789", identity=None, status=200, headers=None):
        super().__init__(data)
        self.download_identity = dict(IDENTITY if identity is None else identity)
        self.status = status
        self.headers = headers or {"Content-Length": str(len(data))}

    def getcode(self):
        return self.status


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(os.environ, {}, clear=True))
        self.enterContext(patch.object(routes.urllib.request, "getproxies_environment", return_value={}))
        self.enterContext(patch.object(routes.urllib.request, "getproxies_registry", return_value={}, create=True))
        routes._routes.clear()
        self.addCleanup(routes._routes.clear)
        # Every test must explicitly provide its network behavior.
        self.enterContext(patch.object(routes, "build_opener", side_effect=AssertionError("unexpected network")))
        self.enterContext(patch.object(manager, "huggingface_token", return_value=None))

    def test_detects_environment_and_windows_proxy_without_port_scanning(self):
        with patch.object(routes.urllib.request, "getproxies_environment", return_value={"https": "http://env:1234"}), \
                patch.object(routes.urllib.request, "getproxies_registry", return_value={"http": "system:5678"}):
            candidates = routes.candidate_routes()
        self.assertEqual(len(candidates), 6)
        self.assertEqual({route.proxy for route in candidates}, {"", "http://env:1234", "http://system:5678"})

    def test_endpoint_and_route_overrides_accept_only_known_https_sources(self):
        with patch.dict(os.environ, {"AUDIOCPP_DOWNLOAD_ROUTE": "mirror"}):
            self.assertEqual(routes.candidate_routes(), [routes.Route(routes.MIRROR)])
        with patch.dict(os.environ, {"HF_ENDPOINT": "https://attacker.test"}):
            with self.assertRaises(ValueError):
                routes.candidate_routes()

    def test_probe_never_reads_more_than_budget_even_when_range_is_ignored(self):
        captured = []
        response = Response(b"x" * (routes.PROBE_BYTES * 3))
        original_read = response.read1
        def read(size):
            value = original_read(size)
            captured.append(len(value))
            return value
        response.read1 = read
        with patch.object(routes.Route, "open", return_value=response) as opened:
            routes._probe(routes.Route(routes.MIRROR), SOURCE, {"Authorization": "Bearer private"})
        request = opened.call_args.args[0]
        self.assertEqual(sum(captured), routes.PROBE_BYTES)
        self.assertEqual(request.get_header("Range"), f"bytes=0-{routes.PROBE_BYTES - 1}")
        self.assertIsNone(request.get_header("Authorization"))

    def test_selects_fastest_matching_file_and_pins_revision(self):
        def probe(route, *_args):
            return (1 if route.endpoint == routes.MIRROR else 2), IDENTITY
        with patch.object(routes, "_probe", side_effect=probe):
            plan = routes.DownloadRoutes(SOURCE, {})
        self.assertEqual(plan.routes[0].endpoint, routes.MIRROR)
        request = Request(SOURCE, headers={"Authorization": "Bearer private"})
        with patch.object(routes.Route, "open", return_value=Response()) as opened:
            plan.open(request, 3)
        selected = opened.call_args.args[0]
        self.assertIn(f"/resolve/{COMMIT}/model.gguf", selected.full_url)
        self.assertIsNone(selected.get_header("Authorization"))

    def test_rejects_fast_mirror_with_different_commit(self):
        def probe(route, *_args):
            identity = IDENTITY if route.endpoint == routes.OFFICIAL else {**IDENTITY, "commit": OTHER_COMMIT}
            return (1 if route.endpoint == routes.MIRROR else 2), identity
        with patch.object(routes, "_probe", side_effect=probe):
            plan = routes.DownloadRoutes(SOURCE, {})
        self.assertEqual(plan.routes, [routes.Route(routes.OFFICIAL)])

    def test_official_auth_error_is_not_bypassed_via_public_mirror(self):
        def probe(route, *_args):
            if route.endpoint == routes.OFFICIAL:
                raise HTTPError(SOURCE, 401, "unauthorized", {}, None)
            return 1, IDENTITY
        with patch.object(routes, "_probe", side_effect=probe):
            with self.assertRaises(HTTPError) as caught:
                routes.DownloadRoutes(SOURCE, {})
        self.assertEqual(caught.exception.code, 401)

    def test_network_probe_failure_uses_healthy_alternative(self):
        def probe(route, *_args):
            if route.endpoint == routes.OFFICIAL:
                raise URLError("offline")
            return 1, IDENTITY
        with patch.object(routes, "_probe", side_effect=probe):
            plan = routes.DownloadRoutes(SOURCE, {})
        self.assertEqual(plan.routes[0].endpoint, routes.MIRROR)

    def test_redirect_strips_token_on_cdn_mirror_or_other_host(self):
        for destination in ("https://cdn-lfs.huggingface.co/file", "https://hf-mirror.com/file", "https://attacker.test/file"):
            request = Request(SOURCE, headers={"Authorization": "Bearer private", "Cookie": "secret"})
            result = routes.SafeRedirectHandler().redirect_request(request, None, 302, "", {}, destination)
            self.assertIsNone(result.get_header("Authorization"))
            self.assertIsNone(result.get_header("Cookie"))
        trusted = routes.SafeRedirectHandler().redirect_request(
            Request(SOURCE, headers={"Authorization": "Bearer private"}), None, 302, "", {},
            "https://huggingface.co/api/resolve-cache/file")
        self.assertEqual(trusted.get_header("Authorization"), "Bearer private")
        with self.assertRaises(URLError):
            routes.SafeRedirectHandler().redirect_request(Request(SOURCE), None, 302, "", {}, "http://huggingface.co/file")

    def test_unknown_partial_identity_restarts_instead_of_mixing_bytes(self):
        with patch.dict(os.environ, {"AUDIOCPP_DOWNLOAD_AUTO": "0"}):
            plan = routes.DownloadRoutes(SOURCE, {})
        plan.identity = IDENTITY
        with patch.object(routes.Route, "open", return_value=Response()) as opened:
            plan.open(Request(SOURCE, headers={"Range": "bytes=4-"}), 3)
        self.assertIsNone(opened.call_args.args[0].get_header("Range"))

    def test_known_partial_identity_keeps_range_across_route_fallback(self):
        with patch.object(routes, "_probe", return_value=(1, IDENTITY)):
            plan = routes.DownloadRoutes(SOURCE, {})
        before = plan.routes[plan.index]
        plan.failed()
        self.assertNotEqual(plan.routes[plan.index], before)
        request = Request(SOURCE, headers={"Range": "bytes=4-"})
        request.download_identity = IDENTITY
        with patch.object(routes.Route, "open", return_value=Response()) as opened:
            plan.open(request, 3)
        self.assertEqual(opened.call_args.args[0].get_header("Range"), "bytes=4-")

    def test_manager_retries_network_failure_and_resumes_verified_bytes(self):
        package = manager.PackageRecord("demo", "demo", "Demo", "demo", "gguf", "q8", ("model.gguf",), "",
                                        {"kind": "huggingface_snapshot", "repo": "audio-cpp/demo"}, True)
        observed = []
        def opened(request, timeout):
            observed.append(request.get_header("Range"))
            if len(observed) == 1:
                return Response(b"0123", headers={"Content-Length": "10"})
            self.assertEqual(request.download_identity, IDENTITY)
            return Response(b"456789", status=206, headers={"Content-Length": "6", "Content-Range": "bytes 4-9/10"})
        with tempfile.TemporaryDirectory() as directory, patch.object(manager, "urlopen", side_effect=opened), \
                patch.object(manager, "DOWNLOAD_RETRY_DELAY_SECONDS", 0), patch.object(manager, "route_failed") as failed:
            output = Path(directory) / "model.gguf"
            manager.download_file(package, "model.gguf", output)
            self.assertEqual(output.read_bytes(), b"0123456789")
            self.assertEqual(observed, [None, "bytes=4-"])
            failed.assert_called_once()

    def test_pause_before_commit_preserves_previous_install_and_staging(self):
        package = manager.PackageRecord("demo", "demo", "Demo", "demo", "gguf", "q8", ("model.gguf",), "",
                                        {"kind": "huggingface_snapshot", "repo": "audio-cpp/demo"}, True)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "demo"
            target.mkdir()
            (target / "old.gguf").write_bytes(b"old")
            control = root / "control.json"
            def download(_package, _remote, output):
                output.write_bytes(b"new")
                control.write_text(json.dumps({"action": "pause"}), encoding="utf-8")
            args = SimpleNamespace(models_root=directory, overwrite=True, check=False, dry_run=False, control_file=control)
            with patch.object(manager, "download_file", side_effect=download):
                with self.assertRaises(manager.DownloadInterrupted):
                    manager.install_package(package, args)
            staging, _lock = manager.package_staging_paths(package, root)
            self.assertEqual((target / "old.gguf").read_bytes(), b"old")
            self.assertEqual((staging / "model.gguf").read_bytes(), b"new")
            self.assertIsNone(manager._control_file)

    def test_cancel_during_commit_does_not_interrupt_directory_replacement(self):
        package = manager.PackageRecord("demo", "demo", "Demo", "demo", "gguf", "q8", ("model.gguf",), "",
                                        {"kind": "huggingface_snapshot", "repo": "audio-cpp/demo"}, True)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "demo").mkdir()
            (root / "demo" / "old.gguf").write_bytes(b"old")
            control = root / "control.json"
            original_remove = manager.shutil.rmtree
            def remove(path):
                original_remove(path)
                control.write_text(json.dumps({"action": "cancel"}), encoding="utf-8")
            def download(_package, _remote, output):
                output.write_bytes(b"new")
                routes.save_resume_identity(Response(), output)
            args = SimpleNamespace(models_root=directory, overwrite=True, check=False, dry_run=False, control_file=control)
            with patch.object(manager, "download_file", side_effect=download), patch.object(manager.shutil, "rmtree", side_effect=remove):
                manager.install_package(package, args)
            self.assertEqual((root / "demo" / "model.gguf").read_bytes(), b"new")
            self.assertFalse((root / "demo" / "model.gguf.download.json").exists())

    def test_control_request_returns_exit_75_without_downloading(self):
        for action in ("pause", "cancel"):
            with self.subTest(action=action), tempfile.TemporaryDirectory() as directory:
                control = Path(directory) / "control.json"
                control.write_text(json.dumps({"action": action}), encoding="utf-8")
                with patch.object(sys, "argv", ["manager", "install", "voxcpm2_q8_0", "--models-root", directory,
                                               "--control-file", str(control)]), patch.object(manager, "urlopen") as opened:
                    self.assertEqual(manager.main(), 75)
                    opened.assert_not_called()


if __name__ == "__main__":
    unittest.main()
