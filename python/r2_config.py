from __future__ import annotations

import re
from urllib.parse import urlparse

R2_ENDPOINT_HOST_RE = re.compile(
    r"^[a-z0-9]+(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$"
)
R2_BUCKET_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$")

def https_origin(value: object) -> str:
    try:
        parsed = urlparse(str(value or "").strip())
        port = parsed.port
    except (TypeError, ValueError):
        return ""
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or port not in {None, 443}
    ):
        return ""
    return f"https://{parsed.hostname.lower()}"

def normalize_r2_endpoint(value: object) -> str:
    raw = str(value or "").strip()
    origin = https_origin(raw)
    if not origin:
        return ""
    parsed = urlparse(raw)
    if parsed.path not in {"", "/"}:
        return ""
    if not R2_ENDPOINT_HOST_RE.fullmatch(parsed.hostname.lower()):
        return ""
    return origin

def normalize_r2_bucket(value: object) -> str:
    bucket = str(value or "").strip()
    return bucket if R2_BUCKET_RE.fullmatch(bucket) else ""

def validate_r2_bucket_pair(upload_bucket: object, results_bucket: object) -> tuple[str, str]:
    upload = normalize_r2_bucket(upload_bucket)
    results = normalize_r2_bucket(results_bucket)
    if not upload or not results:
        raise ValueError("R2_UPLOAD_BUCKET and R2_RESULTS_BUCKET must be valid bucket names")
    if upload == results:
        raise ValueError("R2 upload and results buckets must be different")
    return upload, results

def normalize_public_r2_url(value: object) -> str:
    raw = str(value or "").strip()
    origin = https_origin(raw)
    if not origin:
        return ""
    parsed = urlparse(raw)
    if R2_ENDPOINT_HOST_RE.fullmatch(parsed.hostname.lower()):
        return ""
    path = parsed.path.rstrip("/")
    return f"{origin}{path}"

def upload_origins(endpoint: object, configured: object = None) -> list[str]:
    values = configured if isinstance(configured, (list, tuple, set)) else str(configured or "").split(",")
    origins: list[str] = []
    endpoint_origin = normalize_r2_endpoint(endpoint)
    if endpoint_origin:
        origins.append(endpoint_origin)
    for value in values:
        origin = https_origin(value)
        if origin and origin not in origins:
            origins.append(origin)
    return origins
