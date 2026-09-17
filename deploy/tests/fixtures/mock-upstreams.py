#!/usr/bin/env python3
"""Fixture HTTP/WebSocket upstreams for Caddy routing tests."""

from __future__ import annotations

import base64
import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def _handler(upstream: str):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args) -> None:
            return

        def _json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _websocket(self) -> None:
            key = self.headers.get("Sec-WebSocket-Key", "")
            accept = base64.b64encode(
                hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
            ).decode("ascii")
            self.send_response(101, "Switching Protocols")
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            if self.headers.get("Upgrade", "").lower() == "websocket":
                self._websocket()
                return
            if upstream == "dashboard" and self.path.startswith("/api/"):
                if self.path in ("/api/health", "/api/live"):
                    self._json(
                        200,
                        {
                            "upstream": upstream,
                            "path": self.path,
                            "ok": True,
                        },
                    )
                    return
                self._json(
                    404,
                    {"upstream": upstream, "path": self.path, "error": "missing"},
                )
                return
            if upstream == "miner" and self.path.startswith("/api/v1/"):
                self._json(200, {"upstream": upstream, "path": self.path})
                return
            if upstream == "faucet" and self.path in ("/request", "/health"):
                self._json(200, {"upstream": upstream, "path": self.path})
                return
            if upstream == "validator":
                self._json(200, {"upstream": upstream, "path": self.path})
                return
            self._json(
                404, {"upstream": upstream, "path": self.path, "error": "missing"}
            )

        def do_POST(self) -> None:  # noqa: N802
            self.do_GET()

        def do_HEAD(self) -> None:  # noqa: N802
            self.do_GET()

    Handler.__name__ = f"{upstream.title()}Handler"
    return Handler


def _serve(port: int, upstream: str) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer(("0.0.0.0", port), _handler(upstream))
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


def main() -> None:
    servers = [
        _serve(9944, "validator"),
        _serve(8086, "miner"),
        _serve(8087, "faucet"),
        _serve(3001, "dashboard"),
    ]
    print("mock-upstreams-ready", flush=True)
    threading.Event().wait()
    for server in servers:
        server.shutdown()


if __name__ == "__main__":
    main()
