"""Request doubles for the local viewer HTTP handler."""

from __future__ import annotations

import io

import serve

from tests.helpers.python.streams import RecordingWriter

def make_handler(
    path: str,
    headers: dict[str, str] | None = None,
    body: bytes = b"",
) -> tuple[serve.Handler, dict]:
    """Build an unbound handler whose JSON replies land in the returned dict."""
    captured: dict = {}
    handler = object.__new__(serve.Handler)
    handler.path = path
    handler.headers = headers or {}
    handler.rfile = io.BytesIO(body)
    handler.wfile = io.BytesIO()
    handler._json = lambda code, body: captured.update({"code": code, "body": body})
    return handler, captured

def token_headers(body: bytes = b"", **extra: str) -> dict[str, str]:
    """Headers carrying only the local API token."""
    headers = {"X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN, **extra}
    if body:
        headers["Content-Length"] = str(len(body))
    return headers

def browser_headers(body: bytes = b"", **extra: str) -> dict[str, str]:
    """Headers for a same-origin browser request carrying the local API token."""
    return token_headers(body, **{"Sec-Fetch-Site": "same-origin", **extra})

def capture_stream_response(handler: serve.Handler, captured: dict) -> RecordingWriter:
    """Record status line, headers, and streamed body for a non-JSON reply."""
    captured.setdefault("headers", [])
    handler.send_response = lambda code: captured.update({"code": code})
    handler.send_header = lambda name, value: captured["headers"].append((name, value))
    handler.end_headers = lambda: captured.update({"ended": True})
    writer = RecordingWriter()
    handler.wfile = writer
    return writer
