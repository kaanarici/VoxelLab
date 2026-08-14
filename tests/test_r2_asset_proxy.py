from __future__ import annotations

import io
from urllib.parse import urlparse

from asset_proxy import handle_proxy_asset_get


class Headers:
    def __init__(self, length: str | None):
        self.length = length

    def get_content_type(self):
        return "application/octet-stream"

    def get(self, name):
        return self.length if name == "Content-Length" else None


class Response:
    def __init__(self, payload: bytes, length: str | None):
        self.headers = Headers(length)
        self.body = io.BytesIO(payload)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, size=-1):
        return self.body.read(size)


class Handler:
    def __init__(self):
        self.wfile = io.BytesIO()
        self.json = None
        self.headers = []
        self.code = None

    def _json(self, code, body):
        self.json = (code, body)

    def send_response(self, code):
        self.code = code

    def send_header(self, name, value):
        self.headers.append((name, value))

    def end_headers(self):
        return None


def run_proxy(response: Response, max_bytes: int) -> Handler:
    handler = Handler()
    handle_proxy_asset_get(
        handler,
        urlparse("/api/proxy-asset?url=https%3A%2F%2Fassets.example%2Fvolume.raw.zst"),
        {},
        lambda url, _config: url,
        lambda url: url,
        lambda *_args, **_kwargs: response,
        object(),
        4,
        max_bytes=max_bytes,
    )
    return handler


def test_r2_asset_proxy_rejects_oversized_declared_body_before_streaming() -> None:
    handler = run_proxy(Response(b"0123456789", "10"), max_bytes=8)

    assert handler.json == (413, {"error": "asset exceeds proxy limit (8 bytes)"})
    assert handler.wfile.getvalue() == b""


def test_r2_asset_proxy_rejects_unbounded_body_without_content_length() -> None:
    handler = run_proxy(Response(b"0123456789", None), max_bytes=8)

    assert handler.json == (502, {"error": "asset fetch did not declare a content length"})
    assert handler.wfile.getvalue() == b""
