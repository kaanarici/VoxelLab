from __future__ import annotations

import io
import types

import pytest

import serve

from tests.helpers.python.serve_http import make_handler

PRIVATE_LOCAL_API_GET_PATHS = [
    "/api/analyze/status",
    "/api/ai/models",
    "/api/cloud-settings",
    "/api/proxy-asset?url=https%3A%2F%2Fr2.example%2Fdata%2Fa.png",
]

@pytest.fixture(autouse=True)
def reset_rate_limits():
    """Rate limit buckets are process-wide; keep each request budget independent."""
    serve.RATE_LIMIT_BUCKETS.clear()
    yield
    serve.RATE_LIMIT_BUCKETS.clear()

def end_headers_for(path: str, origin: str, monkeypatch) -> dict[str, str]:
    handler = object.__new__(serve.Handler)
    headers: list[tuple[str, str]] = []
    handler.path = path
    handler.headers = {"Origin": origin}
    handler.send_header = lambda key, value: headers.append((key, value))
    monkeypatch.setattr(serve.http.server.SimpleHTTPRequestHandler, "end_headers", lambda self: None)

    serve.Handler.end_headers(handler)

    return dict(headers)

def test_local_api_token_header_must_match_the_process_token() -> None:
    handler = object.__new__(serve.Handler)

    handler.headers = {"X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN}
    assert handler._has_local_api_token() is True

    handler.headers = {}
    assert handler._has_local_api_token() is False

@pytest.mark.parametrize("path", PRIVATE_LOCAL_API_GET_PATHS)
def test_private_get_routes_reject_a_same_origin_request_without_the_token(path: str) -> None:
    handler, captured = make_handler(path, headers={"Sec-Fetch-Site": "same-origin"})

    serve.Handler.do_GET(handler)

    assert captured == {"code": 403, "body": {"error": "missing or invalid local api token"}}

def test_private_post_routes_reject_a_request_without_the_token(monkeypatch) -> None:
    handler, captured = make_handler("/api/cloud/get_upload_urls")
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})

    serve.Handler.do_POST(handler)

    assert captured == {"code": 403, "body": {"error": "missing or invalid local api token"}}

@pytest.mark.parametrize(
    ("headers", "reason"),
    [
        ({"Origin": "http://localhost:3000", "Host": "127.0.0.1:8000"}, "is same-origin only"),
        ({}, "requires a same-origin browser context"),
        ({"Sec-Fetch-Site": "same-origin"}, "requires a same-origin browser context"),
        ({"Origin": "http://192.168.1.25:8000", "Host": "192.168.1.25:8000"}, "is available only on loopback hosts"),
    ],
    ids=["cross-origin", "no-browser-context", "fetch-metadata-without-origin", "lan-host"],
)
def test_private_routes_require_a_loopback_same_origin_browser_context(headers: dict[str, str], reason: str) -> None:
    handler, captured = make_handler("/api/local-token", headers=headers)

    serve.Handler.do_GET(handler)

    assert captured == {"code": 403, "body": {"error": f"/api/local-token {reason}"}}

def test_private_options_preflight_rejects_a_cross_origin_request() -> None:
    handler, captured = make_handler(
        "/api/consult",
        headers={"Origin": "http://localhost:3000", "Host": "127.0.0.1:8000"},
    )

    serve.Handler.do_OPTIONS(handler)

    assert captured == {"code": 403, "body": {"error": "/api/consult is same-origin only"}}

def test_options_preflight_answers_204_without_a_body() -> None:
    handler = object.__new__(serve.Handler)
    seen: dict = {}
    handler.send_response = lambda code: seen.setdefault("code", code)
    handler.send_header = lambda key, value: seen.setdefault("headers", []).append((key, value))
    handler.end_headers = lambda: seen.setdefault("ended", True)

    serve.Handler.do_OPTIONS(handler)

    assert seen["code"] == 204
    assert ("Content-Length", "0") in seen["headers"]
    assert seen["ended"] is True

def test_local_token_route_returns_the_token_to_a_same_origin_caller() -> None:
    handler, captured = make_handler(
        "/api/local-token",
        headers={"Origin": "http://127.0.0.1:8000", "Host": "127.0.0.1:8000"},
    )

    serve.Handler.do_POST(handler)

    assert captured == {"code": 200, "body": {"localApiToken": serve.LOCAL_API_TOKEN}}

def test_static_responses_allow_cors_only_for_a_localhost_origin(monkeypatch) -> None:
    headers = end_headers_for("/index.html", "http://localhost:8000", monkeypatch)

    assert headers["Access-Control-Allow-Origin"] == "http://localhost:8000"
    assert headers["Access-Control-Allow-Methods"] == "GET, POST, OPTIONS"
    assert headers["Access-Control-Allow-Headers"] == "Content-Type, X-VoxelLab-Local-Token"
    assert headers["Vary"] == "Origin"

@pytest.mark.parametrize(
    ("path", "origin"),
    [
        ("/api/proxy-asset?url=https%3A%2F%2Fr2.example%2Fdata%2Fa.png", "http://localhost:8000"),
        ("/index.html", "https://evil.example"),
    ],
    ids=["sensitive-local-api-route", "non-local-origin"],
)
def test_responses_withhold_cors_but_keep_csp(path: str, origin: str, monkeypatch) -> None:
    headers = end_headers_for(path, origin, monkeypatch)

    assert "Access-Control-Allow-Origin" not in headers
    assert "Content-Security-Policy" in headers

def test_content_security_policy_keeps_scripts_and_workers_self_hosted(monkeypatch) -> None:
    csp = end_headers_for("/index.html", "http://localhost:8000", monkeypatch)["Content-Security-Policy"]

    assert "script-src 'self' 'wasm-unsafe-eval'" in csp
    assert "worker-src 'self'" in csp
    assert "https://cdn.jsdelivr.net" not in csp

@pytest.mark.parametrize(
    "path",
    [
        "/",
        "/js/bootstrap.js",
        "/schemas/enums.json",
        "/data/manifest.json",
        "/node_modules/dcmjs/build/dcmjs.es.js",
        "/node_modules/three/examples/jsm/controls/TrackballControls.js",
    ],
)
def test_static_paths_serve_viewer_assets_and_required_node_modules(path: str) -> None:
    assert serve.allowed_static_path(path) is True

@pytest.mark.parametrize(
    "path",
    [
        "/package.json",
        "/docs/private.md",
        "/node_modules/electron/index.js",
        "/node_modules/dcmjs/test/sample-dicom.json",
        "/node_modules/onnxruntime-web/docs/api/index.md",
        "/node_modules/three/examples/jsm/loaders/OBJLoader.js",
        "/js/%2e%2e/AGENTS.md",
    ],
)
def test_static_paths_refuse_repo_files_and_unused_node_modules(path: str) -> None:
    assert serve.allowed_static_path(path) is False

def test_trackball_controls_rewrite_keeps_three_self_hosted() -> None:
    assert serve.rewritten_trackball_controls_source("import { EventDispatcher } from 'three';") == (
        "import { EventDispatcher } from '../../../build/three.module.js';"
    )

def test_loopback_origins_are_the_only_allowed_local_origins() -> None:
    assert serve.localhost_origin("http://localhost:8000") == "http://localhost:8000"
    assert serve.localhost_origin("https://127.0.0.1:3000") == "https://127.0.0.1:3000"
    assert serve.localhost_origin("https://evil.example") == ""
    assert serve.loopback_host("::1") is True
    assert serve.loopback_host("0.0.0.0") is False

def test_json_payloads_are_capped_before_reading_the_body() -> None:
    handler, captured = make_handler(
        "/api/ask",
        headers={"Content-Length": str(serve.MAX_API_JSON_BODY_BYTES + 1)},
        body=b"{}",
    )

    assert handler._read_json_payload_or_error() is None
    assert captured == {"code": 413, "body": {"error": "body too large"}}

def test_malformed_json_payloads_are_rejected_before_routing() -> None:
    body = b"{not-json"
    handler, captured = make_handler("/api/ask", headers={"Content-Length": str(len(body))}, body=body)

    assert handler._read_json_payload_or_error() is None
    assert captured == {"code": 400, "body": {"error": "invalid JSON body"}}

def test_rate_limit_buckets_run_out_of_capacity_and_report_a_retry_delay(monkeypatch) -> None:
    monkeypatch.setattr(serve.time, "monotonic", lambda: 0.0)

    allowed = [serve.consume_rate_limit("/api/analyze", "127.0.0.1") for _index in range(5)]
    exhausted, retry_after = serve.consume_rate_limit("/api/analyze", "127.0.0.1")

    assert allowed == [(True, 0)] * 5
    assert exhausted is False
    assert retry_after >= 1

def test_rate_limited_requests_answer_429_with_the_retry_hint(monkeypatch) -> None:
    handler = object.__new__(serve.Handler)
    monkeypatch.setattr(handler, "_rate_limit_key", lambda: "local")
    monkeypatch.setattr(serve, "consume_rate_limit", lambda path, key: (False, 12))

    assert handler._enforce_rate_limit("/api/ask") == (
        429,
        {"error": "rate limit exceeded", "retryAfterSeconds": 12},
    )

@pytest.mark.parametrize(
    ("request_line", "expected"),
    [
        ('"GET /data/example_analysis.json HTTP/1.1" 404 -', []),
        ('"GET /missing.json HTTP/1.1" 404 -', ['[serve] "GET /missing.json HTTP/1.1" 404 -\n']),
    ],
    ids=["optional-sidecar", "unexpected-path"],
)
def test_request_logging_suppresses_only_optional_sidecar_misses(monkeypatch, request_line: str, expected: list[str]) -> None:
    handler = object.__new__(serve.Handler)
    writes: list[str] = []
    monkeypatch.setattr(serve.sys, "stderr", types.SimpleNamespace(write=writes.append))

    serve.Handler.log_message(handler, request_line)

    assert writes == expected

def test_json_replies_survive_a_client_that_disconnects() -> None:
    handler = object.__new__(serve.Handler)
    handler.send_response = lambda code: None
    handler.send_header = lambda key, value: None
    handler.end_headers = lambda: None
    handler.wfile = types.SimpleNamespace(write=lambda payload: (_ for _ in ()).throw(BrokenPipeError()))

    serve.Handler._json(handler, 200, {"ok": True})

def test_static_replies_survive_a_client_that_disconnects() -> None:
    class DisconnectedWriter(io.BytesIO):
        def write(self, _data: object) -> int:
            raise BrokenPipeError("client disconnected")

    handler = object.__new__(serve.Handler)

    handler.copyfile(io.BytesIO(b"response body"), DisconnectedWriter())

def test_main_refuses_a_non_loopback_bind_before_starting_the_server(monkeypatch, capsys) -> None:
    monkeypatch.setattr(serve.sys, "argv", ["serve.py", "--bind", "0.0.0.0"])
    monkeypatch.setattr(
        serve,
        "ViewerHTTPServer",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("server must not start")),
    )

    assert serve.main() is False
    assert "refusing non-loopback bind" in capsys.readouterr().err

def test_server_selects_an_ipv6_socket_for_the_ipv6_loopback(monkeypatch) -> None:
    captured = {}

    def fake_init(self, server_address, handler, bind_and_activate=True):
        captured.update({"family": self.address_family, "address": server_address})

    monkeypatch.setattr(serve.http.server.ThreadingHTTPServer, "__init__", fake_init)

    _ = serve.ViewerHTTPServer(("::1", 8000), serve.Handler)

    assert captured["family"] == serve.socket.AF_INET6
    assert captured["address"] == ("::1", 8000)
