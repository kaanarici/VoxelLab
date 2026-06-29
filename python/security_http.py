from __future__ import annotations

import json
import os
import secrets
import threading
import time
from urllib.parse import urlparse


LOCAL_API_TOKEN = (os.environ.get("VIEWER_LOCAL_API_TOKEN") or "").strip() or secrets.token_urlsafe(24)
MAX_JSON_BODY_BYTES = 1024 * 1024
MAX_API_JSON_BODY_BYTES = 64 * 1024
LOCAL_ORIGIN_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}
RATE_LIMITS = {
    "/api/analyze": (5, 60.0),
    "/api/ask": (20, 60.0),
    "/api/microscopy/convert": (10, 60.0),
}
PRIVATE_LOCAL_API_PATHS = {
    "/api/local-token",
    "/api/cloud-settings",
    "/api/proxy-asset",
    "/api/analyze/status",
    "/api/consult",
    "/api/microscopy/convert",
}
PRIVATE_LOCAL_API_TOKEN_PATHS = {
    "/api/proxy-asset",
    "/api/cloud-settings",
    "/api/analyze/status",
    "/api/consult",
    "/api/microscopy/convert",
}
RATE_LIMIT_BUCKETS: dict[str, dict[str, float]] = {}
RATE_LIMIT_LOCK = threading.Lock()


class BodyTooLargeError(ValueError):
    pass


class InvalidJsonBodyError(ValueError):
    pass


def localhost_origin(origin: str) -> str:
    try:
        parsed = urlparse(origin)
    except Exception:
        return ""
    if parsed.scheme not in {"http", "https"}:
        return ""
    return origin if parsed.hostname in LOCAL_ORIGIN_HOSTS else ""


def is_same_origin(origin: str, host: str) -> bool:
    try:
        parsed = urlparse(origin)
    except Exception:
        return False
    return bool(host) and parsed.scheme in {"http", "https"} and parsed.netloc == host


def content_security_policy() -> str:
    return "; ".join([
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "script-src 'self' https://cdn.jsdelivr.net",
        "worker-src 'self' blob: https://cdn.jsdelivr.net",
        "style-src 'self'",
        "img-src 'self' data: blob: https:",
        "connect-src 'self' https:",
        "font-src 'self' data:",
    ])


def local_nostore_static_path(path: str) -> bool:
    return path in {"/", "/index.html", "/sw.js"} or path.endswith((".js", ".mjs", ".css", ".html"))


def consume_rate_limit(path: str, client_key: str) -> tuple[bool, int]:
    capacity, window_seconds = RATE_LIMITS[path]
    refill_per_second = capacity / window_seconds
    now = time.monotonic()
    key = f"{path}:{client_key}"
    with RATE_LIMIT_LOCK:
        bucket = RATE_LIMIT_BUCKETS.get(key, {"tokens": float(capacity), "updated": now})
        tokens = min(float(capacity), bucket["tokens"] + (now - bucket["updated"]) * refill_per_second)
        if tokens < 1:
            RATE_LIMIT_BUCKETS[key] = {"tokens": tokens, "updated": now}
            retry_after = max(1, int((1 - tokens) / refill_per_second) + 1)
            return False, retry_after
        RATE_LIMIT_BUCKETS[key] = {"tokens": tokens - 1, "updated": now}
        return True, 0


def has_local_api_token(headers, local_api_token: str) -> bool:
    token = headers.get("X-VoxelLab-Local-Token") or ""
    return bool(token) and secrets.compare_digest(token, local_api_token)


def read_json_body(handler, max_bytes: int = MAX_JSON_BODY_BYTES):
    try:
        length = int(handler.headers.get("Content-Length") or 0)
    except ValueError:
        length = 0
    if length <= 0:
        return {}
    if length > max_bytes:
        raise BodyTooLargeError("body too large")
    raw = handler.rfile.read(length)
    try:
        return json.loads(raw.decode() or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise InvalidJsonBodyError("invalid JSON body") from exc


def private_api_origin_guard(headers, path: str) -> tuple[int, dict] | None:
    if path not in PRIVATE_LOCAL_API_PATHS:
        return None
    origin = headers.get("Origin") or ""
    host = headers.get("Host") or ""
    if path == "/api/local-token":
        if not origin:
            return 403, {"error": f"{path} requires a same-origin browser context"}
        if is_same_origin(origin, host):
            return None
        return 403, {"error": f"{path} is same-origin only"}
    if not origin:
        sec_fetch_site = (headers.get("Sec-Fetch-Site") or "").strip().lower()
        if sec_fetch_site in {"same-origin", "none"}:
            return None
        return 403, {"error": f"{path} requires a same-origin browser context"}
    if is_same_origin(origin, host):
        return None
    return 403, {"error": f"{path} is same-origin only"}
