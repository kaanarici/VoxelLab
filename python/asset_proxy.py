from __future__ import annotations

import ipaddress
import json
import socket
import ssl
from pathlib import Path
from urllib import request as urlrequest
from urllib.parse import parse_qs, urlparse


try:
    import certifi
except Exception:
    certifi = None


def https_origin(value: str | None) -> str:
    try:
        parsed = urlparse(str(value or "").strip())
    except Exception:
        return ""
    if parsed.scheme == "https" and parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}"
    return ""


def manifest_proxy_origins(manifest_path: Path) -> set[str]:
    origins = set()
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return origins
    for series in manifest.get("series", []) or []:
        if not isinstance(series, dict):
            continue
        for value in [
            series.get("sliceUrlBase"),
            series.get("rawUrl"),
            series.get("regionUrlBase"),
            series.get("regionMetaUrl"),
            *(series.get("overlayUrlBases", {}) or {}).values(),
        ]:
            origin = https_origin(value)
            if origin:
                origins.add(origin)
    return origins


def configured_proxy_origins(config: dict | None, data_dir: Path, runtime_config) -> set[str]:
    cfg = config or runtime_config()
    origins = manifest_proxy_origins(data_dir / "manifest.json")
    for value in [cfg.get("r2PublicUrl"), *(cfg.get("trustedUploadOrigins") or [])]:
        origin = https_origin(value)
        if origin:
            origins.add(origin)
    return origins


def private_proxy_host(hostname: str | None) -> bool:
    host = str(hostname or "").strip().strip("[]")
    if not host:
        return True
    try:
        addresses = [ipaddress.ip_address(host)]
    except ValueError:
        try:
            addresses = [
                ipaddress.ip_address(info[4][0])
                for info in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
            ]
        except OSError:
            return False
    return any(
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_unspecified
        for address in addresses
    )


def allowed_proxy_asset_url(url: str, config: dict | None, configured_proxy_origins) -> str:
    try:
        parsed = urlparse(url)
    except Exception:
        return ""
    if parsed.scheme != "https" or not parsed.netloc or private_proxy_host(parsed.hostname):
        return ""
    origin = f"{parsed.scheme}://{parsed.netloc}"
    allowed_origins = configured_proxy_origins(config)
    if origin in allowed_origins:
        return url
    return ""


def proxy_asset_request(url: str) -> urlrequest.Request:
    return urlrequest.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (VoxelLab local asset proxy)"},
    )


def proxy_asset_ssl_context():
    context = ssl.create_default_context()
    cafile = None
    if certifi is not None:
        try:
            cafile = certifi.where()
        except Exception:
            cafile = None
    if cafile:
        context.load_verify_locations(cafile=cafile)
    return context


def handle_proxy_asset_get(
    handler,
    parsed,
    current_config: dict,
    allowed_proxy_asset_url,
    proxy_asset_request,
    urlopen,
    ssl_context,
    chunk_bytes: int,
) -> None:
    target = allowed_proxy_asset_url((parse_qs(parsed.query).get("url") or [""])[0], current_config)
    if not target:
        handler._json(400, {"error": "invalid or untrusted asset url"})
        return
    try:
        with urlopen(
            proxy_asset_request(target),
            timeout=30,
            context=ssl_context,
        ) as response:
            content_type = response.headers.get_content_type() or "application/octet-stream"
            handler.send_response(200)
            handler.send_header("Content-Type", content_type)
            content_length = response.headers.get("Content-Length")
            if content_length:
                handler.send_header("Content-Length", content_length)
            handler.send_header("Cache-Control", "private, max-age=60")
            handler.end_headers()
            while True:
                chunk = response.read(chunk_bytes)
                if not chunk:
                    break
                try:
                    _ = handler.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
            return
    except urlrequest.HTTPError as exc:
        handler._json(exc.code, {"error": f"asset fetch failed: {exc.reason}"})
        return
    except Exception as exc:
        handler._json(502, {"error": f"asset fetch failed: {exc}"})
        return
