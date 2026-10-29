from __future__ import annotations

import http.server
import json
from pathlib import Path
import threading
import urllib.error
from urllib.parse import urlparse

import pytest

import serve
from asset_proxy import handle_proxy_asset_get

from tests.helpers.python.serve_http import browser_headers, capture_stream_response, make_handler
from tests.helpers.python.streams import FakeHTTPResponse, RecordingWriter

PROXY_ASSET_PATH = "/api/proxy-asset?url=https%3A%2F%2Fpub.example%2Fdata%2Fa.png"
PUBLIC_CONFIG = {
    "r2PublicUrl": "https://pub.example/assets",
    "trustedUploadOrigins": ["https://uploads.example"],
}

class ProxyHandlerDouble:
    """Minimal handler surface used by `asset_proxy.handle_proxy_asset_get`."""

    def __init__(self) -> None:
        self.wfile = RecordingWriter()
        self.json: tuple[int, dict] | None = None
        self.headers: list[tuple[str, str]] = []
        self.code: int | None = None

    def _json(self, code: int, body: dict) -> None:
        self.json = (code, body)

    def send_response(self, code: int) -> None:
        self.code = code

    def send_header(self, name: str, value: str) -> None:
        self.headers.append((name, value))

    def end_headers(self) -> None:
        return None

def run_asset_proxy(response: FakeHTTPResponse, max_bytes: int) -> ProxyHandlerDouble:
    handler = ProxyHandlerDouble()
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

@pytest.mark.parametrize(
    ("url", "config"),
    [
        ("https://pub.example/data/a.png", PUBLIC_CONFIG),
        ("https://uploads.example/file.dcm", PUBLIC_CONFIG),
    ],
    ids=["public-read-origin", "trusted-upload-origin"],
)
def test_proxy_targets_allow_configured_https_origins(monkeypatch, url: str, config: dict) -> None:
    monkeypatch.setattr(serve._asset_proxy, "public_proxy_address", lambda _hostname: "93.184.216.34")

    assert serve.allowed_proxy_asset_url(url, config) == url

@pytest.mark.parametrize(
    ("url", "config"),
    [
        ("https://evil.example/data/a.png", PUBLIC_CONFIG),
        ("http://pub.example/data/a.png", PUBLIC_CONFIG),
        ("https://pub.example/data/a.png", {}),
    ],
    ids=["untrusted-origin", "plain-http", "no-configured-origins"],
)
def test_proxy_targets_reject_untrusted_or_plaintext_origins(monkeypatch, url: str, config: dict) -> None:
    monkeypatch.setattr(serve._asset_proxy, "public_proxy_address", lambda _hostname: "93.184.216.34")

    assert serve.allowed_proxy_asset_url(url, config) == ""

@pytest.mark.parametrize(
    ("url", "config"),
    [
        ("https://127.0.0.1:8443/assets/a.png", {"r2PublicUrl": "https://127.0.0.1:8443/assets"}),
        (
            "https://169.254.169.254/latest/meta-data",
            {"trustedUploadOrigins": ["https://169.254.169.254"]},
        ),
    ],
    ids=["loopback-host", "link-local-metadata"],
)
def test_proxy_targets_reject_private_hosts_even_when_configured(url: str, config: dict) -> None:
    assert serve.allowed_proxy_asset_url(url, config) == ""

def test_proxy_targets_fail_closed_when_dns_cannot_be_resolved(monkeypatch) -> None:
    def fail_dns(*_args, **_kwargs):
        raise OSError("dns unavailable")

    monkeypatch.setattr(serve._asset_proxy.socket, "getaddrinfo", fail_dns)

    assert serve.allowed_proxy_asset_url(
        "https://assets.example/data/a.png",
        {"trustedUploadOrigins": ["https://assets.example"]},
    ) == ""

def test_proxy_connection_pins_the_validated_address_and_keeps_the_tls_hostname(monkeypatch) -> None:
    dns_calls = 0

    def rebinding_dns(*_args, **_kwargs):
        nonlocal dns_calls
        dns_calls += 1
        address = "93.184.216.34" if dns_calls == 1 else "127.0.0.1"
        return [(serve._asset_proxy.socket.AF_INET, serve._asset_proxy.socket.SOCK_STREAM, 6, "", (address, 443))]

    monkeypatch.setattr(serve._asset_proxy.socket, "getaddrinfo", rebinding_dns)
    target = serve.allowed_proxy_asset_url(
        "https://assets.example/data/a.png",
        {"trustedUploadOrigins": ["https://assets.example"]},
    )
    request = serve.proxy_asset_request(target)
    connected = {}

    class FakeContext:
        def wrap_socket(self, sock, *, server_hostname):
            connected["server_hostname"] = server_hostname
            return sock

    monkeypatch.setattr(
        serve._asset_proxy.socket,
        "create_connection",
        lambda address, timeout, source_address: connected.update({"address": address}),
    )
    connection = serve._asset_proxy._PinnedHTTPSConnection(
        "assets.example",
        pinned_ip=request.voxellab_pinned_ip,
        context=FakeContext(),
    )
    connection.connect()

    assert connected["address"] == ("93.184.216.34", 443)
    assert connected["server_hostname"] == "assets.example"
    assert dns_calls == 1

def test_configured_proxy_origins_include_every_manifest_asset_host(tmp_path: Path, monkeypatch) -> None:
    _ = (tmp_path / "manifest.json").write_text(json.dumps({
        "patient": "anonymous",
        "studyDate": "",
        "series": [{
            "slug": "cloud_ct",
            "sliceUrlBase": "https://pub-manifest.example/data/cloud_ct",
            "rawUrl": "https://raw-manifest.example/cloud_ct.raw.zst",
            "regionMetaUrl": "https://labels.example/cloud_ct_regions.json",
            "overlayUrlBases": {"cloud_ct_sym": "https://sym.example/data/cloud_ct"},
        }],
    }), encoding="utf-8")
    monkeypatch.setattr(serve, "DATA", tmp_path)

    origins = serve.configured_proxy_origins({})

    assert {
        "https://pub-manifest.example",
        "https://raw-manifest.example",
        "https://labels.example",
        "https://sym.example",
    } <= set(origins)

def test_proxy_requests_identify_themselves_as_the_local_asset_proxy() -> None:
    request = serve.proxy_asset_request("https://pub.example/data/a.png")

    assert request.full_url == "https://pub.example/data/a.png"
    assert request.get_header("User-agent") == "Mozilla/5.0 (VoxelLab local asset proxy)"

def test_redirect_handler_refuses_to_follow_a_redirect() -> None:
    handler = serve._asset_proxy._NoRedirect()

    with pytest.raises(urllib.error.HTTPError) as exc_info:
        handler.redirect_request(
            req=serve.proxy_asset_request("https://pub.example/data/a.png"),
            fp=None,
            code=302,
            msg="Found",
            headers={},
            newurl="http://169.254.169.254/latest/meta-data",
        )

    assert exc_info.value.code == 302
    assert exc_info.value.reason == "redirect blocked: Found"
    assert exc_info.value.url == "http://169.254.169.254/latest/meta-data"

def test_real_opener_never_follows_a_redirect_to_a_second_host() -> None:
    target_hits = 0

    class RedirectHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            nonlocal target_hits
            if self.path == "/redirect":
                self.send_response(302)
                self.send_header("Location", "/target")
                self.end_headers()
                return
            target_hits += 1
            self.send_response(200)
            self.end_headers()

        def log_message(self, format, *_args):
            return

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_address[1]}/redirect"
    try:
        with pytest.raises(urllib.error.HTTPError, match="redirect blocked") as exc_info:
            _ = serve.proxy_asset_urlopen(
                serve.proxy_asset_request(url),
                timeout=2,
                context=serve.PROXY_ASSET_SSL_CONTEXT,
            )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    assert exc_info.value.code == 302
    assert target_hits == 0
    assert serve.allowed_proxy_asset_url(url, {"trustedUploadOrigins": [url]}) == ""

def test_proxy_asset_route_rejects_an_untrusted_target(monkeypatch) -> None:
    handler, captured = make_handler(
        "/api/proxy-asset?url=https%3A%2F%2Fevil.example%2Fdata%2Fa.png",
        headers=browser_headers(),
    )
    monkeypatch.setattr(serve, "runtime_config", lambda: PUBLIC_CONFIG)

    serve.Handler.do_GET(handler)

    assert captured == {"code": 400, "body": {"error": "invalid or untrusted asset url"}}

def test_proxy_asset_route_streams_the_remote_body_in_bounded_chunks(monkeypatch) -> None:
    response = FakeHTTPResponse(b"0123456789", headers={"Content-Length": "10"}, content_type="image/png")
    handler, captured = make_handler(PROXY_ASSET_PATH, headers=browser_headers())
    writer = capture_stream_response(handler, captured)
    monkeypatch.setattr(serve, "CONVERT_STREAM_CHUNK_BYTES", 4)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"r2PublicUrl": "https://pub.example/assets"})
    monkeypatch.setattr(serve._asset_proxy, "public_proxy_address", lambda _hostname: "93.184.216.34")
    monkeypatch.setattr(serve, "proxy_asset_urlopen", lambda *_args, **_kwargs: response)

    serve.Handler.do_GET(handler)

    assert captured == {
        "headers": [
            ("Content-Type", "image/png"),
            ("Content-Length", "10"),
            ("Cache-Control", "no-store"),
        ],
        "code": 200,
        "ended": True,
    }
    assert response.read_sizes == [4, 4, 4, 4]
    assert writer.write_sizes == [4, 4, 2]
    assert writer.getvalue() == b"0123456789"

def test_proxy_asset_route_reports_a_blocked_redirect_without_following_it(monkeypatch) -> None:
    handler, captured = make_handler(PROXY_ASSET_PATH, headers=browser_headers())
    seen: dict = {}
    monkeypatch.setattr(serve, "runtime_config", lambda: {"r2PublicUrl": "https://pub.example/assets"})
    monkeypatch.setattr(serve._asset_proxy, "public_proxy_address", lambda _hostname: "93.184.216.34")

    def redirecting_urlopen(request, *_args, **_kwargs):
        seen["url"] = request.full_url
        raise urllib.error.HTTPError(
            "http://169.254.169.254/latest/meta-data",
            302,
            "redirect blocked: Found",
            hdrs={},
            fp=None,
        )

    monkeypatch.setattr(serve, "proxy_asset_urlopen", redirecting_urlopen)

    serve.Handler.do_GET(handler)

    assert seen["url"] == "https://pub.example/data/a.png"
    assert captured == {
        "code": 302,
        "body": {"error": "asset fetch failed: redirect blocked: Found"},
    }

def test_proxy_rejects_a_body_larger_than_the_declared_limit() -> None:
    handler = run_asset_proxy(FakeHTTPResponse(b"0123456789", headers={"Content-Length": "10"}), max_bytes=8)

    assert handler.json == (413, {"error": "asset exceeds proxy limit (8 bytes)"})
    assert handler.wfile.getvalue() == b""

def test_proxy_rejects_a_body_without_a_declared_length() -> None:
    handler = run_asset_proxy(FakeHTTPResponse(b"0123456789"), max_bytes=8)

    assert handler.json == (502, {"error": "asset fetch did not declare a content length"})
    assert handler.wfile.getvalue() == b""
