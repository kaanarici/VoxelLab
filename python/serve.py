"""
Tiny dev server for the MRI viewer.

Runs exactly like `python3 -m http.server 8000` for static files, but adds a
small JSON API so the Generate Analysis button in the viewer can actually
kick off analyze.py without the user dropping into a terminal.

Endpoints:
    POST /api/analyze?slug=<slug>    start analyze.py for one series
    GET  /api/analyze/result          read one source-keyed result without a noisy static 404
    GET  /api/analyze/status          per-slug terminal job state + last line
    POST /api/ask                     body: {slug, slice, question, x, y} or {slug, slice, question, region:{x0,y0,x1,y1}}
                                      point-and-ask the configured local AI
                                      provider about a crop of a specific
                                      slice. Cached to
                                      data/<slug>_asks.json.
    POST /api/consult                 synthesize all per-slice findings
                                      into a consolidated recommendation.
                                      Cached to data/consult.json. Pass
                                      ?force=1 to regenerate.
    GET  /api/consult                 return the cached consult if any.

analyze.py is already idempotent: if a JSON sidecar already exists for the
slug, only missing slices are sent to the configured AI provider. That means
the button is safe to click — it never re-pays for work that is already
cached.

Run from the mri-viewer folder:
    python3 serve.py              # :8000
    python3 serve.py --port 8080
"""

import argparse
import http.server
import io
import json
import socket
import sys
import time
from urllib import request as urlrequest
from urllib.parse import parse_qs, unquote, urlparse

import ai_routes as _ai_routes
import asset_proxy as _asset_proxy
import cloud_settings as _cloud_settings
import cloud_proxy as _cloud_proxy
import microscopy_routes as _microscopy_routes
import security_http as _security_http
import server_config as _server_config
from ai_runtime import public_ai_status
from microscopy_convert import SUPPORTED_EXTENSIONS as SUPPORTED_CONVERT_EXTENSIONS
from runtime_env import overlay_env


ROOT = _server_config.ROOT
DATA = _server_config.DATA

STATIC_ROOT_FILES = frozenset({
    "config.json",
    "config.local.json",
    "favicon.svg",
    "icons.svg",
    "index.html",
    "sw.js",
    "viewer.js",
})
STATIC_ROOT_DIRECTORIES = ("css", "data", "js", "templates")
STATIC_PACKAGE_PATHS = (
    "node_modules/@cornerstonejs/codec-charls/dist/",
    "node_modules/@cornerstonejs/codec-openjpeg/dist/",
    "node_modules/dcmjs/build/dcmjs.es.js",
    "node_modules/fzstd/esm/index.mjs",
    "node_modules/onnxruntime-web/dist/esm/ort.min.js",
    "node_modules/onnxruntime-web/dist/ort-training-wasm-simd.wasm",
    "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm",
    "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
    "node_modules/onnxruntime-web/dist/ort-wasm-simd.jsep.wasm",
    "node_modules/onnxruntime-web/dist/ort-wasm-simd.wasm",
    "node_modules/onnxruntime-web/dist/ort-wasm-threaded.wasm",
    "node_modules/onnxruntime-web/dist/ort-wasm.wasm",
    "node_modules/pako/dist/pako.esm.mjs",
    "node_modules/three/build/three.module.js",
    "node_modules/three/examples/jsm/controls/TrackballControls.js",
)
TRACKBALL_CONTROLS_PATH = "/node_modules/three/examples/jsm/controls/TrackballControls.js"


def allowed_static_path(request_path: str) -> bool:
    """Limit the local server to viewer assets and runtime package modules."""
    path = unquote(str(request_path or ""))
    if path in {"", "/", "/index.html"}:
        return True
    if not path.startswith("/"):
        return False
    relative = path.removeprefix("/")
    if not relative or any(part in {"", ".", ".."} for part in relative.split("/")):
        return False
    if relative in STATIC_ROOT_FILES:
        return True
    if any(relative.startswith(f"{directory}/") for directory in STATIC_ROOT_DIRECTORIES):
        return True
    return any(
        relative.startswith(package_path) if package_path.endswith("/") else relative == package_path
        for package_path in STATIC_PACKAGE_PATHS
    )


def rewritten_trackball_controls_source(source: str) -> str:
    return source.replace("from 'three';", "from '../../../build/three.module.js';")

LOCAL_API_TOKEN = _security_http.LOCAL_API_TOKEN
MAX_JSON_BODY_BYTES = _security_http.MAX_JSON_BODY_BYTES
MAX_API_JSON_BODY_BYTES = _security_http.MAX_API_JSON_BODY_BYTES
MAX_MODAL_JSON_BODY_BYTES = _cloud_proxy.MAX_MODAL_JSON_BODY_BYTES
MAX_CONVERT_BODY_BYTES = _microscopy_routes.MAX_CONVERT_BODY_BYTES
CONVERT_STREAM_CHUNK_BYTES = _microscopy_routes.CONVERT_STREAM_CHUNK_BYTES
LOCAL_ORIGIN_HOSTS = _security_http.LOCAL_ORIGIN_HOSTS
RATE_LIMITS = _security_http.RATE_LIMITS
PRIVATE_LOCAL_API_PATHS = _security_http.PRIVATE_LOCAL_API_PATHS
PRIVATE_LOCAL_API_TOKEN_PATHS = _security_http.PRIVATE_LOCAL_API_TOKEN_PATHS
BodyTooLargeError = _security_http.BodyTooLargeError
InvalidJsonBodyError = _security_http.InvalidJsonBodyError
RATE_LIMIT_BUCKETS = _security_http.RATE_LIMIT_BUCKETS
RATE_LIMIT_LOCK = _security_http.RATE_LIMIT_LOCK
RUNNING = _ai_routes.RUNNING
LOCK = _ai_routes.LOCK


class ViewerHTTPServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128

    def __init__(self, server_address, RequestHandlerClass, bind_and_activate=True):
        self.address_family = socket.AF_INET6 if ":" in str(server_address[0]) else socket.AF_INET
        super().__init__(server_address, RequestHandlerClass, bind_and_activate=bind_and_activate)


def env_bool(value: str | None) -> bool | None:
    return _server_config.env_bool(value)


def env_list(value: str | None) -> list[str] | None:
    return _server_config.env_list(value)


def runtime_config() -> dict:
    return _server_config.runtime_config(ROOT, overlay_env, public_ai_status, modal_proxy_available)


def _lazy_ask():
    return _ai_routes.lazy_ask()


def valid_slugs() -> set[str]:
    return _ai_routes.valid_slugs(DATA)


def modal_cloud_base() -> str:
    return _cloud_proxy.modal_cloud_base(overlay_env)


def modal_auth_token() -> str:
    return _cloud_proxy.modal_auth_token(overlay_env)


def modal_proxy_available() -> bool:
    return _cloud_proxy.modal_proxy_available(modal_cloud_base, modal_auth_token)


def proxy_modal_json(function_name: str, payload: dict, timeout: int = 60) -> tuple[int, dict]:
    return _cloud_proxy.proxy_modal_json(
        function_name,
        payload,
        timeout,
        MAX_MODAL_JSON_BODY_BYTES,
        modal_cloud_base,
        modal_auth_token,
        urlrequest.urlopen,
    )


def localhost_origin(origin: str) -> str:
    return _security_http.localhost_origin(origin)


def is_same_origin(origin: str, host: str) -> bool:
    return _security_http.is_same_origin(origin, host)


def loopback_host(value: str) -> bool:
    return _security_http.loopback_host(value)


def content_security_policy() -> str:
    return _security_http.content_security_policy()


def local_nostore_static_path(path: str) -> bool:
    return _security_http.local_nostore_static_path(path)


def https_origin(value: str | None) -> str:
    return _asset_proxy.https_origin(value)


def manifest_proxy_origins(manifest_path=None) -> set[str]:
    return _asset_proxy.manifest_proxy_origins(manifest_path or (DATA / "manifest.json"))


def configured_proxy_origins(config: dict | None = None) -> set[str]:
    return _asset_proxy.configured_proxy_origins(config, DATA, runtime_config)


def private_proxy_host(hostname: str | None) -> bool:
    return _asset_proxy.private_proxy_host(hostname)


def allowed_proxy_asset_url(url: str, config: dict | None = None) -> str:
    return _asset_proxy.allowed_proxy_asset_url(url, config, configured_proxy_origins)


def proxy_asset_request(url: str) -> urlrequest.Request:
    return _asset_proxy.proxy_asset_request(url)


def proxy_asset_ssl_context():
    return _asset_proxy.proxy_asset_ssl_context()


def proxy_asset_urlopen(request, *, timeout, context):
    return _asset_proxy.proxy_asset_urlopen(request, timeout=timeout, context=context)


PROXY_ASSET_SSL_CONTEXT = proxy_asset_ssl_context()


def consume_rate_limit(path: str, client_key: str) -> tuple[bool, int]:
    return _security_http.consume_rate_limit(path, client_key)


def valid_cloud_upload_items(items) -> bool:
    return _cloud_proxy.valid_cloud_upload_items(items)


def validate_cloud_proxy_payload(path: str, payload) -> tuple[int, dict] | None:
    return _cloud_proxy.validate_cloud_proxy_payload(path, payload)


def validate_ask_payload(body, known_slugs: set[str]) -> tuple[dict, tuple[int, dict] | None]:
    return _ai_routes.validate_ask_payload(body, known_slugs)


def _analysis_status_entry(
    *,
    proc,
    status: str,
    last: str,
    exit_code: int | None = None,
    error: str | None = None,
    analysis_key: str,
    slug: str,
) -> dict:
    return _ai_routes.analysis_status_entry(
        time,
        proc=proc,
        status=status,
        last=last,
        exit_code=exit_code,
        error=error,
        analysis_key=analysis_key,
        slug=slug,
    )


def _stream_tail(proc, analysis_key: str, slug: str) -> None:
    return _ai_routes.stream_tail(proc, analysis_key, slug, RUNNING, LOCK, time)


def series_meta(slug: str) -> dict | None:
    return _ai_routes.series_meta(DATA, slug)


def parse_analysis_slices(raw: str, slug: str) -> tuple[list[int] | None, str | None]:
    return _ai_routes.parse_analysis_slices(raw, slug, series_meta)


def start_analysis(slug: str, *, analysis_key: str, force: bool = False, slices: list[int] | None = None) -> tuple[int, str]:
    return _ai_routes.start_analysis(
        ROOT,
        sys.executable,
        time,
        slug,
        analysis_key=analysis_key,
        force=force,
        slices=slices,
        valid_slugs=valid_slugs,
        running=RUNNING,
        lock=LOCK,
        stream_tail=_stream_tail,
    )


def status_payload(analysis_key: str | None = None) -> dict:
    return _ai_routes.status_payload(RUNNING, LOCK, analysis_key)


def consult_ready() -> bool:
    return _ai_routes.consult_ready(DATA)


def ai_post_guard(config: dict | None = None) -> tuple[int, dict] | None:
    return _ai_routes.ai_post_guard(config, runtime_config)


class Handler(http.server.SimpleHTTPRequestHandler):
    # Serve only from the mri-viewer folder regardless of where we were
    # launched. `directory=` was added in 3.7.
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def copyfile(self, source, outputfile) -> None:
        try:
            super().copyfile(source, outputfile)
        except (BrokenPipeError, ConnectionResetError):
            # Browsers routinely cancel prefetches and superseded image loads.
            # The request is already over, so do not emit a server traceback.
            return

    def end_headers(self):
        origin = localhost_origin(self.headers.get("Origin") or "")
        parsed = urlparse(getattr(self, "path", "") or "")
        if origin:
            if parsed.path not in PRIVATE_LOCAL_API_PATHS:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, X-VoxelLab-Local-Token")
                self.send_header("Vary", "Origin")
        if local_nostore_static_path(parsed.path):
            self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", content_security_policy())
        super().end_headers()

    def _json(self, code: int, body) -> None:
        payload = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            _ = self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            # Client disconnected before reading the JSON body.
            return

    def _has_local_api_token(self) -> bool:
        return _security_http.has_local_api_token(self.headers, LOCAL_API_TOKEN)

    def _read_json_body(self, max_bytes: int = MAX_JSON_BODY_BYTES):
        return _security_http.read_json_body(self.headers, self.rfile, max_bytes=max_bytes)

    def _read_json_payload_or_error(self, max_bytes: int = MAX_API_JSON_BODY_BYTES):
        try:
            return self._read_json_body(max_bytes=max_bytes)
        except BodyTooLargeError:
            self._json(413, {"error": "body too large"})
            return None
        except InvalidJsonBodyError:
            self._json(400, {"error": "invalid JSON body"})
            return None

    def _write_request_body_to_temp(self, ext: str, length: int) -> str:
        return _microscopy_routes.write_request_body_to_temp(self, ext, length, CONVERT_STREAM_CHUNK_BYTES)

    def _convert_microscopy_upload(
        self,
        ext: str,
        length: int,
        split: bool = False,
        source_name: str = "",
    ) -> None:
        return _microscopy_routes.convert_microscopy_upload(
            self,
            ext,
            length,
            self._write_request_body_to_temp,
            CONVERT_STREAM_CHUNK_BYTES,
            split=split,
            source_name=source_name,
        )

    def _rate_limit_key(self) -> str:
        if isinstance(getattr(self, "client_address", None), tuple) and self.client_address:
            return str(self.client_address[0])
        return "local"

    def _enforce_rate_limit(self, path: str) -> tuple[int, dict] | None:
        allowed, retry_after = consume_rate_limit(path, self._rate_limit_key())
        if allowed:
            return None
        return 429, {"error": "rate limit exceeded", "retryAfterSeconds": retry_after}

    def _private_api_origin_guard(self, parsed) -> tuple[int, dict] | None:
        return _security_http.private_api_origin_guard(getattr(self, "headers", {}), parsed.path)

    def send_head(self):
        parsed = urlparse(self.path)
        if not allowed_static_path(parsed.path):
            self.send_error(404)
            return None
        requested_path = unquote(parsed.path)
        if requested_path not in {"", "/", "/index.html"} and (ROOT / requested_path.lstrip("/")).is_dir():
            self.send_error(404)
            return None
        if parsed.path == TRACKBALL_CONTROLS_PATH:
            source_path = ROOT / parsed.path.lstrip("/")
            try:
                source = source_path.read_text(encoding="utf-8")
            except OSError:
                self.send_error(404)
                return None
            payload = rewritten_trackball_controls_source(source).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            return io.BytesIO(payload)
        return super().send_head()

    def do_OPTIONS(self):
        parsed = urlparse(getattr(self, "path", "") or "")
        blocked = self._private_api_origin_guard(parsed)
        if blocked is not None:
            self._json(*blocked)
            return
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        current_config = runtime_config()
        blocked = self._private_api_origin_guard(parsed)
        if blocked is not None:
            self._json(*blocked)
            return
        if parsed.path == "/api/local-token":
            self._json(200, {"localApiToken": LOCAL_API_TOKEN})
            return
        if parsed.path in {
            "/api/analyze", "/api/ask", "/api/ask/stream", "/api/consult",
            "/api/cloud/get_upload_urls", "/api/cloud/start_processing", "/api/cloud/check_status",
            "/api/cloud-settings",
            "/api/microscopy/convert",
        } and not self._has_local_api_token():
            self._json(403, {"error": "missing or invalid local api token"})
            return

        if parsed.path == "/api/cloud-settings":
            payload = self._read_json_payload_or_error()
            if payload is None:
                return
            if not isinstance(payload, dict):
                self._json(400, {"error": "expected JSON object body"})
                return
            self._json(200, _cloud_settings.write_cloud_settings(ROOT, payload, overlay_env()))
            return
        if parsed.path == "/api/microscopy/convert":
            _microscopy_routes.handle_convert_post(self, qs, SUPPORTED_CONVERT_EXTENSIONS, MAX_CONVERT_BODY_BYTES)
            return
        if parsed.path in {"/api/analyze", "/api/ask", "/api/ask/stream", "/api/consult"}:
            _ai_routes.handle_ai_post(
                self,
                parsed,
                qs,
                current_config,
                ai_post_guard,
                parse_analysis_slices,
                start_analysis,
                validate_ask_payload,
                valid_slugs,
                _lazy_ask,
                consult_ready,
            )
            return
        if parsed.path in {"/api/cloud/get_upload_urls", "/api/cloud/start_processing", "/api/cloud/check_status"}:
            if (current_config.get("features") or {}).get("cloudProcessing") is False:
                self._json(503, {"error": "cloud processing is disabled"})
                return
            _cloud_proxy.handle_cloud_post(
                self,
                parsed.path,
                self._read_json_payload_or_error,
                validate_cloud_proxy_payload,
                proxy_modal_json,
            )
            return

        self.send_error(404)

    def do_GET(self):
        parsed = urlparse(self.path)
        blocked = self._private_api_origin_guard(parsed)
        if blocked is not None:
            self._json(*blocked)
            return
        if parsed.path in PRIVATE_LOCAL_API_TOKEN_PATHS and not self._has_local_api_token():
            self._json(403, {"error": "missing or invalid local api token"})
            return
        if parsed.path == "/api/local-token":
            self._json(200, {"localApiToken": LOCAL_API_TOKEN})
            return
        if parsed.path == "/api/cloud-settings":
            self._json(200, _cloud_settings.cloud_settings_payload(ROOT, overlay_env()))
            return
        if parsed.path == "/config.json":
            self._json(200, runtime_config())
            return
        if parsed.path == "/api/proxy-asset":
            _asset_proxy.handle_proxy_asset_get(
                self,
                parsed,
                runtime_config(),
                allowed_proxy_asset_url,
                proxy_asset_request,
                proxy_asset_urlopen,
                PROXY_ASSET_SSL_CONTEXT,
                CONVERT_STREAM_CHUNK_BYTES,
            )
            return
        if _ai_routes.handle_ai_get(self, parsed, DATA, self._has_local_api_token, status_payload):
            return
        # Everything else -> static file under ROOT
        return super().do_GET()

    # Quieter access log so the terminal isn't drowned in image requests.
    def log_message(self, format, *args):
        msg = format % args
        if any(marker in msg for marker in ("favicon.ico", "_asks.json", "_analysis.json")) and " 404 " in msg:
            return
        if "/api/" in msg or any(code in msg for code in (" 404 ", " 500 ", " 409 ")):
            _ = sys.stderr.write(f"[serve] {msg}\n")


def main() -> bool:
    ap = argparse.ArgumentParser()
    _ = ap.add_argument("--port", type=int, default=8000)
    _ = ap.add_argument("--bind", default="127.0.0.1")
    args = ap.parse_args()

    if not loopback_host(args.bind):
        print(
            f"ERROR: refusing non-loopback bind {args.bind!r}; the local helper API has no remote authentication contract",
            file=sys.stderr,
        )
        return False
    DATA.mkdir(exist_ok=True)
    try:
        server = ViewerHTTPServer((args.bind, args.port), Handler)
    except OSError as e:
        print(f"ERROR: could not bind {args.bind}:{args.port}: {e}", file=sys.stderr)
        return False
    print(f"MRI viewer → http://{args.bind}:{args.port}")
    print(f"Serving:    {ROOT}")
    print("API:        POST /api/analyze?slug=<slug>  +  GET /api/analyze/status")
    print("Local API:  private helper routes require a same-origin browser context; proxy/status/consult also require the runtime token from /api/local-token")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    return True


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
