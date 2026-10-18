"""Loopback-only update-feed fixture; never serves a real bundle or key."""
import functools
import http.server
import json
import pathlib
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        with (pathlib.Path(self.directory) / "requests.log").open("a", encoding="utf-8") as log:
            log.write(self.path + "\n")
        super().do_GET()


if __name__ == "__main__":
    root, ready = map(pathlib.Path, sys.argv[1:])
    with http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(Handler, directory=str(root))
    ) as server:
        ready.write_text(json.dumps({"port": server.server_port}), encoding="utf-8")
        server.serve_forever()
