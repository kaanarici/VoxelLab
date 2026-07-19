from __future__ import annotations

import io
import http.server
import json
from pathlib import Path
import sys
import threading
import types
import urllib.error

import ai_routes
import pytest
import serve
from microscopy_convert import SUPPORTED_EXTENSIONS


def test_convert_endpoint_uses_converter_supported_extensions() -> None:
    assert serve.SUPPORTED_CONVERT_EXTENSIONS == SUPPORTED_EXTENSIONS


def test_ai_post_guard_rejects_disabled_ai() -> None:
    code, body = serve.ai_post_guard({"ai": {"enabled": False}})

    assert code == 503
    assert "disabled" in body["error"].lower()


def test_ai_post_guard_reports_unready_provider() -> None:
    code, body = serve.ai_post_guard({"ai": {"enabled": True, "ready": False, "provider": "codex", "issues": ["config broken"]}})

    assert code == 503
    assert body["provider"] == "codex"
    assert "config broken" in body["error"]


def test_handler_local_api_token_accepts_matching_header() -> None:
    handler = object.__new__(serve.Handler)
    handler.headers = {"X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN}

    assert handler._has_local_api_token() is True


def test_handler_local_api_token_rejects_missing_header() -> None:
    handler = object.__new__(serve.Handler)
    handler.headers = {}

    assert handler._has_local_api_token() is False


def make_handler(path: str, headers: dict[str, str] | None = None, body: bytes = b"") -> tuple[serve.Handler, dict]:
    captured: dict = {}
    handler = object.__new__(serve.Handler)
    handler.path = path
    handler.headers = headers or {}
    handler.rfile = io.BytesIO(body)
    handler.wfile = io.BytesIO()
    handler._json = lambda code, body: captured.update({"code": code, "body": body})
    return handler, captured


class TrackingWriter(io.BytesIO):
    def __init__(self):
        super().__init__()
        self.write_sizes: list[int] = []

    def write(self, data) -> int:
        self.write_sizes.append(len(data))
        return super().write(data)


def test_convert_microscopy_upload_streams_body_to_temp(monkeypatch) -> None:
    class TrackingBody(io.BytesIO):
        def __init__(self, raw: bytes):
            super().__init__(raw)
            self.read_sizes: list[int] = []

        def read(self, size: int | None = -1) -> bytes:
            self.read_sizes.append(size)
            return super().read(size)

    raw = b"0123456789"
    handler, captured = make_handler("/api/microscopy/convert")
    handler.rfile = TrackingBody(raw)
    handler.wfile = TrackingWriter()
    written_paths: dict[str, Path] = {}

    def fake_convert_to_ome_tiff_with_result(input_path: str, output_path: str):
        written_paths["input"] = Path(input_path)
        written_paths["output"] = Path(output_path)
        assert Path(input_path).read_bytes() == raw
        _ = Path(output_path).write_bytes(b"ome-tiff!!")
        return types.SimpleNamespace(
            output_path=output_path,
            warnings=["CZI contains 2 scenes; only the first scene was imported."],
        )

    monkeypatch.setattr(serve, "CONVERT_STREAM_CHUNK_BYTES", 4)
    monkeypatch.setitem(
        sys.modules,
        "microscopy_convert",
        types.SimpleNamespace(convert_to_ome_tiff_with_result=fake_convert_to_ome_tiff_with_result),
    )
    captured["headers"] = []
    handler.send_response = lambda code: captured.update({"code": code})
    handler.send_header = lambda name, value: captured["headers"].append((name, value))
    handler.end_headers = lambda: captured.update({"ended": True})

    handler._convert_microscopy_upload(".czi", len(raw))

    assert handler.rfile.read_sizes == [4, 4, 2]
    assert captured == {
        "headers": [
            ("Content-Type", "image/tiff"),
            ("X-VoxelLab-Convert-Warnings", '["CZI contains 2 scenes; only the first scene was imported."]'),
            ("Content-Length", "10"),
        ],
        "code": 200,
        "ended": True,
    }
    assert handler.wfile.write_sizes == [4, 4, 2]
    assert handler.wfile.getvalue() == b"ome-tiff!!"
    assert not written_paths["input"].exists()
    assert not written_paths["output"].exists()


def test_convert_microscopy_upload_omits_warning_header_without_warnings(monkeypatch) -> None:
    raw = b"0123"
    handler, captured = make_handler("/api/microscopy/convert", body=raw)
    handler.wfile = TrackingWriter()

    def fake_convert_to_ome_tiff_with_result(_input_path: str, output_path: str):
        _ = Path(output_path).write_bytes(b"ome")
        return types.SimpleNamespace(output_path=output_path, warnings=[])

    monkeypatch.setitem(
        sys.modules,
        "microscopy_convert",
        types.SimpleNamespace(convert_to_ome_tiff_with_result=fake_convert_to_ome_tiff_with_result),
    )
    captured["headers"] = []
    handler.send_response = lambda code: captured.update({"code": code})
    handler.send_header = lambda name, value: captured["headers"].append((name, value))
    handler.end_headers = lambda: captured.update({"ended": True})

    handler._convert_microscopy_upload(".czi", len(raw))

    assert ("X-VoxelLab-Convert-Warnings", "") not in captured["headers"]
    assert not any(name == "X-VoxelLab-Convert-Warnings" for name, _value in captured["headers"])
    assert captured["headers"] == [("Content-Type", "image/tiff"), ("Content-Length", "3")]
    assert handler.wfile.getvalue() == b"ome"


def test_split_convert_microscopy_upload_returns_bounded_multipart_parts(monkeypatch) -> None:
    raw = b"native-czi"
    handler, captured = make_handler("/api/microscopy/convert", body=raw)
    handler.wfile = TrackingWriter()
    written_paths: list[Path] = []

    def fake_convert_to_ome_tiff_parts(input_path: str, output_prefix: str, source_name: str):
        assert Path(input_path).read_bytes() == raw
        assert source_name == "sample.czi"
        results = []
        for index, value in enumerate((b"II*\x00scene-one", b"II*\x00scene-two"), start=1):
            output_path = Path(f"{output_prefix}.{index}")
            _ = output_path.write_bytes(value)
            written_paths.append(output_path)
            results.append(types.SimpleNamespace(
                output_path=str(output_path),
                warnings=[f"Scene {index} provenance"],
                part_id=f"czi-scene-{index - 1}",
                file_name=f"sample--scene-{index:03d}.ome.tiff",
            ))
        return results

    monkeypatch.setitem(
        sys.modules,
        "microscopy_convert",
        types.SimpleNamespace(convert_to_ome_tiff_parts=fake_convert_to_ome_tiff_parts),
    )
    monkeypatch.setattr(serve, "CONVERT_STREAM_CHUNK_BYTES", 4)
    captured["headers"] = []
    handler.send_response = lambda code: captured.update({"code": code})
    handler.send_header = lambda name, value: captured["headers"].append((name, value))
    handler.end_headers = lambda: captured.update({"ended": True})

    handler._convert_microscopy_upload(".czi", len(raw), split=True, source_name="sample.czi")

    headers = dict(captured["headers"])
    assert captured["code"] == 200
    assert captured["ended"] is True
    assert headers["Content-Type"].startswith('multipart/mixed; boundary="voxellab-')
    assert headers["X-VoxelLab-Convert-Parts"] == "2"
    assert int(headers["Content-Length"]) == len(handler.wfile.getvalue())
    payload = handler.wfile.getvalue()
    assert payload.count(b"Content-Type: image/tiff") == 2
    assert b'filename="sample--scene-001.ome.tiff"' in payload
    assert b'filename="sample--scene-002.ome.tiff"' in payload
    assert b"X-VoxelLab-Convert-Part: czi-scene-0" in payload
    assert b"II*\x00scene-one" in payload and b"II*\x00scene-two" in payload
    assert any(size > 4 for size in handler.wfile.write_sizes)
    assert all(not path.exists() for path in written_paths)


def test_split_convert_microscopy_upload_keeps_single_part_as_tiff(monkeypatch) -> None:
    raw = b"native-nd2"
    handler, captured = make_handler("/api/microscopy/convert", body=raw)
    handler.wfile = TrackingWriter()
    written_path: Path | None = None

    def fake_convert_to_ome_tiff_parts(_input_path: str, output_prefix: str, _source_name: str):
        nonlocal written_path
        written_path = Path(f"{output_prefix}.1")
        _ = written_path.write_bytes(b"II*\x00one-position")
        return [types.SimpleNamespace(
            output_path=str(written_path),
            warnings=["ND2 native position 1"],
            part_id="nd2-position-0",
            file_name="sample--position-001.ome.tiff",
        )]

    monkeypatch.setitem(
        sys.modules,
        "microscopy_convert",
        types.SimpleNamespace(convert_to_ome_tiff_parts=fake_convert_to_ome_tiff_parts),
    )
    captured["headers"] = []
    handler.send_response = lambda code: captured.update({"code": code})
    handler.send_header = lambda name, value: captured["headers"].append((name, value))
    handler.end_headers = lambda: captured.update({"ended": True})

    handler._convert_microscopy_upload(".nd2", len(raw), split=True, source_name="sample.nd2")

    assert captured["code"] == 200
    assert captured["headers"] == [
        ("Content-Type", "image/tiff"),
        ("Content-Disposition", 'attachment; filename="sample--position-001.ome.tiff"'),
        ("X-VoxelLab-Convert-Part", "nd2-position-0"),
        ("X-VoxelLab-Convert-Warnings", '["ND2 native position 1"]'),
        ("Content-Length", "16"),
    ]
    assert handler.wfile.getvalue() == b"II*\x00one-position"
    assert written_path is not None and not written_path.exists()


def test_convert_microscopy_upload_rejects_short_body(monkeypatch) -> None:
    handler, captured = make_handler("/api/microscopy/convert", body=b"short")
    monkeypatch.setattr(serve, "CONVERT_STREAM_CHUNK_BYTES", 4)
    monkeypatch.setitem(
        sys.modules,
        "microscopy_convert",
        types.SimpleNamespace(
            convert_to_ome_tiff_with_result=lambda _input_path, _output_path: types.SimpleNamespace(
                output_path=_output_path,
                warnings=[],
            )
        ),
    )

    handler._convert_microscopy_upload(".czi", 6)

    assert captured["code"] == 400
    assert "Content-Length" in captured["body"]["error"]


def test_convert_microscopy_upload_returns_stable_converter_reason(monkeypatch) -> None:
    handler, captured = make_handler("/api/microscopy/convert", body=b"input")

    class MissingConverter(ImportError):
        reason = "converter_path_missing"

    monkeypatch.setitem(
        sys.modules,
        "microscopy_convert",
        types.SimpleNamespace(
            convert_to_ome_tiff_with_result=lambda _input_path, _output_path: (_ for _ in ()).throw(
                MissingConverter("VOXELLAB_BFCONVERT path does not exist")
            )
        ),
    )

    handler._convert_microscopy_upload(".czi", 5)

    assert captured == {
        "code": 501,
        "body": {
            "error": "microscopy converter path does not exist",
            "reason": "converter_path_missing",
        },
    }


def test_convert_microscopy_upload_does_not_return_external_process_output(monkeypatch) -> None:
    handler, captured = make_handler("/api/microscopy/convert", body=b"input")

    class FailedConverter(RuntimeError):
        reason = "external_process_failure"

    monkeypatch.setitem(
        sys.modules,
        "microscopy_convert",
        types.SimpleNamespace(
            convert_to_ome_tiff_with_result=lambda _input_path, _output_path: (_ for _ in ()).throw(
                FailedConverter("token=super-secret /Users/alice/private/input.czi")
            )
        ),
    )

    handler._convert_microscopy_upload(".czi", 5)

    assert captured == {
        "code": 500,
        "body": {
            "error": "external microscopy converter failed",
            "reason": "external_process_failure",
        },
    }
    assert "super-secret" not in str(captured)


def test_convert_microscopy_upload_rejects_unsupported_format_with_stable_reason() -> None:
    handler, captured = make_handler("/api/microscopy/convert")
    handler._enforce_rate_limit = lambda _path: None

    serve._microscopy_routes.handle_convert_post(handler, {"name": ["cells.png"]}, SUPPORTED_EXTENSIONS, 1024)

    assert captured == {
        "code": 400,
        "body": {"error": "unsupported microscopy format", "reason": "unsupported_format"},
    }


def test_convert_endpoint_plumbs_opt_in_split_mode_without_changing_legacy_mode() -> None:
    calls = []
    for query in (
        {"name": ["cells.czi"], "mode": ["split"]},
        {"name": ["cells.czi"]},
    ):
        handler, _captured = make_handler(
            "/api/microscopy/convert",
            headers={"Content-Length": "5"},
            body=b"input",
        )
        handler._enforce_rate_limit = lambda _path: None
        handler._convert_microscopy_upload = lambda ext, length, **kwargs: calls.append((ext, length, kwargs))
        serve._microscopy_routes.handle_convert_post(handler, query, SUPPORTED_EXTENSIONS, 1024)

    assert calls == [
        (".czi", 5, {"split": True, "source_name": "cells.czi"}),
        (".czi", 5, {"split": False, "source_name": "cells.czi"}),
    ]


def test_read_json_payload_caps_body_size() -> None:
    body = b"{}"
    handler, captured = make_handler("/api/ask", headers={"Content-Length": str(serve.MAX_API_JSON_BODY_BYTES + 1)}, body=body)

    assert handler._read_json_payload_or_error() is None
    assert captured == {"code": 413, "body": {"error": "body too large"}}


def test_read_json_payload_rejects_invalid_json() -> None:
    body = b"{not-json"
    handler, captured = make_handler("/api/ask", headers={"Content-Length": str(len(body))}, body=body)

    assert handler._read_json_payload_or_error() is None
    assert captured == {"code": 400, "body": {"error": "invalid JSON body"}}


def test_runtime_config_overlays_env_proxy_and_feature_flags(monkeypatch, tmp_path: Path) -> None:
    _ = (tmp_path / "config.json").write_text(json.dumps({
        "modalWebhookBase": "https://remote.example",
        "r2PublicUrl": "https://static.example",
        "trustedUploadOrigins": ["https://static-upload.example"],
        "siteName": "VoxelLab Base",
        "disclaimer": "Base disclaimer",
        "features": {
            "cloudProcessing": True,
            "aiAnalysis": False,
        },
    }))
    env = {
        "MODAL_WEBHOOK_BASE": "https://example-org--medical-imaging-pipeline.modal.run",
        "MODAL_AUTH_TOKEN": "modal-auth-token",
        "TRUSTED_UPLOAD_ORIGINS": "https://upload-a.example, https://upload-b.example",
        "R2_PUBLIC_URL": "https://public-r2.example",
        "SITE_NAME": "VoxelLab Local",
        "VIEWER_DISCLAIMER": "Local disclaimer",
        "VIEWER_CLOUD_PROCESSING": "false",
        "VIEWER_AI_ANALYSIS": "true",
    }
    ai_status = {
        "enabled": True,
        "provider": "codex",
        "ready": False,
        "issues": ["missing key"],
    }
    called: dict = {}

    monkeypatch.setattr(serve, "ROOT", tmp_path)
    monkeypatch.setattr(serve, "overlay_env", lambda: env.copy())

    def fake_public_ai_status(enabled: bool, env: dict | None = None):
        called["enabled"] = enabled
        called["env"] = env
        return ai_status

    monkeypatch.setattr(serve, "public_ai_status", fake_public_ai_status)

    config = serve.runtime_config()

    assert config["modalWebhookBase"] == ""
    assert config["trustedUploadOrigins"] == ["https://upload-a.example", "https://upload-b.example"]
    assert config["r2PublicUrl"] == "https://public-r2.example"
    assert config["siteName"] == "VoxelLab Local"
    assert config["disclaimer"] == "Local disclaimer"
    assert config["features"] == {
        "cloudProcessing": False,
        "aiAnalysis": True,
    }
    assert config["ai"] == ai_status
    assert config["localAiAvailable"] is False
    assert called["enabled"] is True
    assert called["env"]["MODAL_AUTH_TOKEN"] == "modal-auth-token"
    assert "localApiToken" not in config


def test_do_get_config_json_returns_runtime_config(monkeypatch) -> None:
    expected = {"siteName": "VoxelLab"}
    handler, captured = make_handler("/config.json")
    monkeypatch.setattr(serve, "runtime_config", lambda: expected)

    serve.Handler.do_GET(handler)

    assert captured == {"code": 200, "body": expected}


def test_do_post_local_token_returns_same_origin_token() -> None:
    handler, captured = make_handler("/api/local-token", headers={"Origin": "http://127.0.0.1:8000", "Host": "127.0.0.1:8000"})

    serve.Handler.do_POST(handler)

    assert captured == {"code": 200, "body": {"localApiToken": serve.LOCAL_API_TOKEN}}


def test_do_get_proxy_asset_rejects_untrusted_target(monkeypatch) -> None:
    handler, captured = make_handler(
        "/api/proxy-asset?url=https%3A%2F%2Fevil.example%2Fdata%2Fa.png",
        headers={
            "Sec-Fetch-Site": "same-origin",
            "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        },
    )
    monkeypatch.setattr(serve, "runtime_config", lambda: {
        "r2PublicUrl": "https://pub.example/assets",
        "trustedUploadOrigins": ["https://uploads.example"],
    })

    serve.Handler.do_GET(handler)

    assert captured == {"code": 400, "body": {"error": "invalid or untrusted asset url"}}


def test_do_get_analyze_status_rejects_missing_local_api_token() -> None:
    handler, captured = make_handler("/api/analyze/status", headers={"Sec-Fetch-Site": "same-origin"})

    serve.Handler.do_GET(handler)

    assert captured == {"code": 403, "body": {"error": "missing or invalid local api token"}}


def test_do_get_proxy_asset_rejects_missing_local_api_token() -> None:
    handler, captured = make_handler(
        "/api/proxy-asset?url=https%3A%2F%2Fr2.example%2Fdata%2Fa.png",
        headers={"Sec-Fetch-Site": "same-origin"},
    )

    serve.Handler.do_GET(handler)

    assert captured == {"code": 403, "body": {"error": "missing or invalid local api token"}}


def test_do_post_cloud_proxy_rejects_missing_local_api_token(monkeypatch) -> None:
    handler, captured = make_handler("/api/cloud/get_upload_urls")
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})

    serve.Handler.do_POST(handler)

    assert captured == {"code": 403, "body": {"error": "missing or invalid local api token"}}


def test_do_post_cloud_proxy_forwards_body_with_runtime_token(monkeypatch) -> None:
    body = b'{"job_id":"job_123","items":[{"upload_id":"f000000"}]}'
    headers = {
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        "Content-Length": str(len(body)),
    }
    handler, captured = make_handler("/api/cloud/start_processing", headers=headers, body=body)
    seen: dict = {}
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})

    def fake_proxy(function_name: str, payload: dict, timeout: int = 60):
        seen["function_name"] = function_name
        seen["payload"] = payload
        seen["timeout"] = timeout
        return 200, {"status": "started"}

    monkeypatch.setattr(serve, "proxy_modal_json", fake_proxy)

    serve.Handler.do_POST(handler)

    assert seen == {
        "function_name": "start_processing",
        "payload": {"job_id": "job_123", "items": [{"upload_id": "f000000"}]},
        "timeout": 120,
    }
    assert captured == {"code": 200, "body": {"status": "started"}}


def test_do_post_cloud_proxy_rejects_invalid_upload_url_payload(monkeypatch) -> None:
    body = b'{"items":[{"filename":"slice.dcm"}]}'
    headers = {
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        "Content-Length": str(len(body)),
    }
    handler, captured = make_handler("/api/cloud/get_upload_urls", headers=headers, body=body)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})

    serve.Handler.do_POST(handler)

    assert captured == {
        "code": 400,
        "body": {"error": "expected body {items:[{upload_id, filename}, ...]}"},
    }


def test_do_post_cloud_proxy_rejects_missing_job_id(monkeypatch) -> None:
    body = b'{}'
    headers = {
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        "Content-Length": str(len(body)),
    }
    handler, captured = make_handler("/api/cloud/check_status", headers=headers, body=body)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})

    serve.Handler.do_POST(handler)

    assert captured == {"code": 400, "body": {"error": "missing job_id"}}


def test_do_post_cloud_proxy_rejects_malformed_json_body(monkeypatch) -> None:
    body = b'{"job_id":'
    headers = {
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        "Content-Length": str(len(body)),
    }
    handler, captured = make_handler("/api/cloud/check_status", headers=headers, body=body)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})

    serve.Handler.do_POST(handler)

    assert captured == {"code": 400, "body": {"error": "invalid JSON body"}}


def test_do_post_cloud_proxy_rejects_negative_upload_bytes(monkeypatch) -> None:
    body = b'{"job_id":"job_123","total_upload_bytes":-1}'
    headers = {
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        "Content-Length": str(len(body)),
    }
    handler, captured = make_handler("/api/cloud/start_processing", headers=headers, body=body)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})

    serve.Handler.do_POST(handler)

    assert captured == {
        "code": 400,
        "body": {"error": "total_upload_bytes must be a non-negative integer"},
    }


def test_proxy_modal_json_caps_success_body(monkeypatch) -> None:
    class Response:
        status = 200

        def __init__(self, payload: bytes):
            self.payload = io.BytesIO(payload)
            self.read_sizes: list[int] = []

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, size: int = -1) -> bytes:
            self.read_sizes.append(size)
            return self.payload.read(size)

    response = Response(b'{"status":"started"}')
    monkeypatch.setattr(serve, "MAX_MODAL_JSON_BODY_BYTES", 5)
    monkeypatch.setattr(serve, "modal_cloud_base", lambda: "https://example-org--pipeline.modal.run")
    monkeypatch.setattr(serve, "modal_auth_token", lambda: "token")
    monkeypatch.setattr(serve.urlrequest, "urlopen", lambda *_args, **_kwargs: response)

    assert serve.proxy_modal_json("start_processing", {"job_id": "job_123"}) == (
        502,
        {"error": "modal response body too large"},
    )
    assert response.read_sizes == [6]


def test_proxy_modal_json_caps_http_error_body(monkeypatch) -> None:
    error = urllib.error.HTTPError(
        "https://modal.example",
        413,
        "Payload Too Large",
        hdrs=None,
        fp=io.BytesIO(b'{"error":"too much detail"}'),
    )
    monkeypatch.setattr(serve, "MAX_MODAL_JSON_BODY_BYTES", 5)
    monkeypatch.setattr(serve, "modal_cloud_base", lambda: "https://example-org--pipeline.modal.run")
    monkeypatch.setattr(serve, "modal_auth_token", lambda: "token")

    def raise_http_error(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(serve.urlrequest, "urlopen", raise_http_error)

    assert serve.proxy_modal_json("get_upload_urls", {"items": []}) == (
        413,
        {"error": "modal error response body too large"},
    )


def test_do_post_analyze_rejects_unknown_slug(monkeypatch) -> None:
    headers = {"X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN}
    key = "v2:11111111111111111111111111111111"
    handler, captured = make_handler(f"/api/analyze?slug=missing&analysisKey={key}", headers=headers)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})
    monkeypatch.setattr(serve, "start_analysis", lambda slug, **_kwargs: (400, f"unknown slug: {slug}"))

    serve.Handler.do_POST(handler)

    assert captured == {"code": 400, "body": {
        "message": "unknown slug: missing",
        "slug": "missing",
        "analysisKey": key,
        "resultUrl": "./data/analysis-v2-11111111111111111111111111111111.json",
    }}


def test_do_post_analyze_parses_slice_ranges_before_starting(monkeypatch) -> None:
    headers = {"X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN}
    key = "v2:22222222222222222222222222222222"
    handler, captured = make_handler(f"/api/analyze?slug=scan&analysisKey={key}&slices=0,2-3&force=1", headers=headers)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})
    monkeypatch.setattr(serve, "series_meta", lambda slug: {"slug": slug, "slices": 5})
    seen = {}

    def fake_start_analysis(slug: str, *, analysis_key: str, force: bool = False, slices=None):
      seen["slug"] = slug
      seen["analysis_key"] = analysis_key
      seen["force"] = force
      seen["slices"] = slices
      return 202, "started: scan (force)"

    monkeypatch.setattr(serve, "start_analysis", fake_start_analysis)

    serve.Handler.do_POST(handler)

    assert seen == {"slug": "scan", "analysis_key": key, "force": True, "slices": [0, 2, 3]}
    assert captured == {"code": 202, "body": {
        "message": "started: scan (force)",
        "slug": "scan",
        "analysisKey": key,
        "resultUrl": "./data/analysis-v2-22222222222222222222222222222222.json",
    }}


def test_do_post_analyze_rejects_missing_or_path_like_analysis_identity(monkeypatch) -> None:
    headers = {"X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN}
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})
    for identity in ("", "../../escape", "v2:ABCDEF", "v3:" + "0" * 32):
        serve.RATE_LIMIT_BUCKETS.clear()
        handler, captured = make_handler(f"/api/analyze?slug=scan&analysisKey={identity}", headers=headers)
        serve.Handler.do_POST(handler)
        assert captured == {"code": 400, "body": {"error": "invalid analysis key"}}


def test_do_post_analyze_rejects_malformed_json_body(monkeypatch) -> None:
    body = b'{"unexpected":'
    headers = {
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        "Content-Length": str(len(body)),
    }
    handler, captured = make_handler("/api/analyze?slug=scan", headers=headers, body=body)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})
    serve.RATE_LIMIT_BUCKETS.clear()

    serve.Handler.do_POST(handler)

    assert captured == {"code": 400, "body": {"error": "invalid JSON body"}}


def test_analyze_rejects_same_slug_while_first_popen_is_launching(monkeypatch, tmp_path: Path) -> None:
    running = {}
    lock = threading.Lock()
    first_popen_started = threading.Event()
    release_first_popen = threading.Event()
    popen_calls = []
    first_result = {}
    key = "v2:33333333333333333333333333333333"

    class FakeProc:
        stdout = iter(())

    def fake_popen(cmd, **kwargs):
        call_index = len(popen_calls)
        popen_calls.append((cmd, kwargs))
        if call_index == 0:
            first_popen_started.set()
            assert release_first_popen.wait(2), "timed out releasing first Popen"
        return FakeProc()

    monkeypatch.setattr(ai_routes.subprocess, "Popen", fake_popen)

    def launch_first():
        first_result["value"] = ai_routes.start_analysis(
            tmp_path,
            "python",
            types.SimpleNamespace(time=lambda: 123.0),
            "scan",
            analysis_key=key,
            force=False,
            slices=None,
            valid_slugs=lambda: {"scan"},
            running=running,
            lock=lock,
            stream_tail=lambda *_args: None,
        )

    first_thread = threading.Thread(target=launch_first)
    first_thread.start()
    assert first_popen_started.wait(2), "first Popen did not start"

    try:
        second = ai_routes.start_analysis(
            tmp_path,
            "python",
            types.SimpleNamespace(time=lambda: 124.0),
            "scan",
            analysis_key=key,
            force=False,
            slices=None,
            valid_slugs=lambda: {"scan"},
            running=running,
            lock=lock,
            stream_tail=lambda *_args: None,
        )

        payload = ai_routes.status_payload(running, lock)[key]
        assert payload["running"] is True
        assert payload["last"] == "starting..."
        assert second == (409, "already running for this source series")
        assert len(popen_calls) == 1
    finally:
        release_first_popen.set()
        first_thread.join(2)

    assert not first_thread.is_alive()
    assert first_result["value"] == (202, "started: scan")


def test_analyze_spawn_failure_clears_launch_reservation(monkeypatch, tmp_path: Path) -> None:
    running = {}
    lock = threading.Lock()

    def raise_oserror(*_args, **_kwargs):
        raise OSError("boom")

    monkeypatch.setattr(ai_routes.subprocess, "Popen", raise_oserror)

    result = ai_routes.start_analysis(
        tmp_path,
        "python",
        types.SimpleNamespace(time=lambda: 123.0),
        "scan",
        analysis_key="v2:44444444444444444444444444444444",
        force=False,
        slices=None,
        valid_slugs=lambda: {"scan"},
        running=running,
        lock=lock,
        stream_tail=lambda *_args: None,
    )

    assert result == (500, "failed to start analysis: boom")
    assert running == {}


def test_analyze_allows_bounded_distinct_source_identities_for_the_same_slug(monkeypatch, tmp_path: Path) -> None:
    running = {}
    lock = threading.Lock()
    launched = []

    class FakeProc:
        stdout = iter(())

    def fake_popen(cmd, **kwargs):
        launched.append((cmd, kwargs))
        return FakeProc()

    monkeypatch.setattr(ai_routes.subprocess, "Popen", fake_popen)
    first_key = "v2:77777777777777777777777777777777"
    second_key = "v2:88888888888888888888888888888888"
    for key in (first_key, second_key):
        assert ai_routes.start_analysis(
            tmp_path,
            "python",
            types.SimpleNamespace(time=lambda: 123.0),
            "scan",
            analysis_key=key,
            force=False,
            slices=None,
            valid_slugs=lambda: {"scan"},
            running=running,
            lock=lock,
            stream_tail=lambda *_args: None,
        ) == (202, "started: scan")

    assert len(launched) == 2
    assert set(running) == {first_key, second_key}
    assert all("--analysis-key" in cmd for cmd, _kwargs in launched)

    third_key = "v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    assert ai_routes.start_analysis(
        tmp_path,
        "python",
        types.SimpleNamespace(time=lambda: 124.0),
        "scan",
        analysis_key=third_key,
        force=False,
        slices=None,
        valid_slugs=lambda: {"scan"},
        running=running,
        lock=lock,
        stream_tail=lambda *_args: None,
    ) == (429, "too many analysis jobs are already running")
    assert len(launched) == 2


def test_do_get_analyze_status_returns_running_payload(monkeypatch) -> None:
    handler, captured = make_handler(
        "/api/analyze/status",
        headers={
            "Sec-Fetch-Site": "same-origin",
            "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        },
    )
    monkeypatch.setattr(serve, "status_payload", lambda: {"scan": {"running": True, "last": "working"}})

    serve.Handler.do_GET(handler)

    assert captured == {"code": 200, "body": {"scan": {"running": True, "last": "working"}}}


def test_do_get_analyze_status_filters_by_validated_analysis_key(monkeypatch) -> None:
    key = "v2:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    handler, captured = make_handler(
        f"/api/analyze/status?analysisKey={key}",
        headers={
            "Sec-Fetch-Site": "same-origin",
            "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        },
    )
    seen = []

    def fake_status_payload(analysis_key=None):
        seen.append(analysis_key)
        return {analysis_key: {"running": True, "slug": "scan"}}

    monkeypatch.setattr(serve, "status_payload", fake_status_payload)

    serve.Handler.do_GET(handler)

    assert seen == [key]
    assert captured == {"code": 200, "body": {key: {"running": True, "slug": "scan"}}}


def test_do_get_analyze_status_rejects_blank_or_path_like_analysis_key() -> None:
    headers = {
        "Sec-Fetch-Site": "same-origin",
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
    }
    for query in ("analysisKey=", "analysisKey=..%2F..%2Fescape", "analysisKey=v2%3AABCDEF"):
        handler, captured = make_handler(f"/api/analyze/status?{query}", headers=headers)
        serve.Handler.do_GET(handler)
        assert captured == {"code": 400, "body": {"error": "invalid analysis key"}}


def test_analyze_status_persists_terminal_error_state() -> None:
    class FakeProc:
        stdout = iter(["working\n", "ERROR: provider offline\n", "later success-looking output\n"])

        @staticmethod
        def wait():
            return 2

        @staticmethod
        def poll():
            return 2

    key = "v2:55555555555555555555555555555555"
    serve.RUNNING.clear()
    serve.RUNNING[key] = serve._analysis_status_entry(
        proc=FakeProc(),
        status="running",
        last="starting...",
        analysis_key=key,
        slug="scan",
    )

    serve._stream_tail(FakeProc(), key, "scan")

    payload = serve.status_payload()[key]
    assert payload["status"] == "error"
    assert payload["running"] is False
    assert payload["exitCode"] == 2
    assert "provider offline" in payload["error"]
    serve.RUNNING.clear()


def test_analyze_status_persists_terminal_done_state() -> None:
    class FakeProc:
        stdout = iter(["Done. Refresh the viewer.\n"])

        @staticmethod
        def wait():
            return 0

        @staticmethod
        def poll():
            return 0

    key = "v2:66666666666666666666666666666666"
    serve.RUNNING.clear()
    serve.RUNNING[key] = serve._analysis_status_entry(
        proc=FakeProc(),
        status="running",
        last="starting...",
        analysis_key=key,
        slug="scan",
    )

    serve._stream_tail(FakeProc(), key, "scan")

    payload = serve.status_payload()[key]
    assert payload["status"] == "done"
    assert payload["running"] is False
    assert payload["exitCode"] == 0
    assert payload["error"] is None
    serve.RUNNING.clear()


def test_analyze_rejects_reusing_a_running_key_for_another_slug(monkeypatch, tmp_path: Path) -> None:
    running = {}
    lock = threading.Lock()
    launched = []

    class FakeProc:
        stdout = iter(())

    def fake_popen(cmd, **kwargs):
        launched.append((cmd, kwargs))
        return FakeProc()

    monkeypatch.setattr(ai_routes.subprocess, "Popen", fake_popen)
    key = "v2:99999999999999999999999999999999"
    common = {
        "force": False,
        "slices": None,
        "valid_slugs": lambda: {"scan", "other"},
        "running": running,
        "lock": lock,
        "stream_tail": lambda *_args: None,
    }
    assert ai_routes.start_analysis(
        tmp_path, "python", types.SimpleNamespace(time=lambda: 1.0), "scan", analysis_key=key, **common,
    ) == (202, "started: scan")
    assert ai_routes.start_analysis(
        tmp_path, "python", types.SimpleNamespace(time=lambda: 2.0), "other", analysis_key=key, **common,
    ) == (409, "analysis key is already bound to another slug")
    assert len(launched) == 1
    assert running[key]["slug"] == "scan"


def test_analysis_status_history_is_bounded_without_evicting_live_jobs() -> None:
    running = {}
    lock = threading.Lock()
    for index in range(ai_routes.MAX_TERMINAL_ANALYSIS_STATUS_ENTRIES + 7):
        key = f"v2:{index:032x}"
        running[key] = ai_routes.analysis_status_entry(
            types.SimpleNamespace(time=lambda index=index: float(index)),
            proc=None,
            status="done",
            last=f"done-{index}",
            analysis_key=key,
            slug=f"scan-{index}",
        )
    live_key = "v2:ffffffffffffffffffffffffffffffff"
    running[live_key] = ai_routes.analysis_status_entry(
        types.SimpleNamespace(time=lambda: 999.0),
        proc=object(),
        status="running",
        last="working",
        analysis_key=live_key,
        slug="current-scan",
    )

    payload = ai_routes.status_payload(running, lock)

    terminal = [entry for entry in payload.values() if not entry["running"]]
    assert len(terminal) == ai_routes.MAX_TERMINAL_ANALYSIS_STATUS_ENTRIES
    assert live_key in payload
    assert payload[live_key]["slug"] == "current-scan"
    assert payload[live_key]["last"] == "working"
    assert "v2:00000000000000000000000000000000" not in payload
    newest_terminal = f"v2:{ai_routes.MAX_TERMINAL_ANALYSIS_STATUS_ENTRIES + 6:032x}"
    assert newest_terminal in payload

    exact = ai_routes.status_payload(running, lock, live_key)
    assert list(exact) == [live_key]
    assert exact[live_key]["slug"] == "current-scan"


def test_do_get_consult_returns_cached_consult(monkeypatch, tmp_path: Path) -> None:
    _ = (tmp_path / "consult.json").write_text(json.dumps({"impression": "Stable.", "ask_radiologist": [], "limitations": "None."}))
    handler, captured = make_handler(
        "/api/consult",
        headers={
            "Sec-Fetch-Site": "same-origin",
            "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        },
    )
    monkeypatch.setattr(serve, "DATA", tmp_path)

    serve.Handler.do_GET(handler)

    assert captured == {
        "code": 200,
        "body": {"cached": True, "impression": "Stable.", "ask_radiologist": [], "limitations": "None."},
    }


def test_do_get_consult_returns_named_error_on_invalid_cache(monkeypatch, tmp_path: Path) -> None:
    _ = (tmp_path / "consult.json").write_text("[1,2,3]")
    handler, captured = make_handler(
        "/api/consult",
        headers={
            "Sec-Fetch-Site": "same-origin",
            "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        },
    )
    monkeypatch.setattr(serve, "DATA", tmp_path)

    serve.Handler.do_GET(handler)

    assert captured["code"] == 409
    assert captured["body"]["error"] == "consult cache is invalid"
    assert captured["body"]["regeneratePath"] == "/api/consult?force=1"


def test_do_post_consult_forwards_force_flag(monkeypatch) -> None:
    headers = {
        "Sec-Fetch-Site": "same-origin",
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
    }
    handler, captured = make_handler("/api/consult?force=1", headers=headers)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})
    monkeypatch.setattr(serve, "consult_ready", lambda: True)
    seen = {}

    class FakeAsk:
        @staticmethod
        def consult(force=False):
            seen["force"] = force
            return {"impression": "ok", "ask_radiologist": [], "limitations": ""}

    monkeypatch.setattr(serve, "_lazy_ask", lambda: FakeAsk)

    serve.Handler.do_POST(handler)

    assert seen == {"force": True}
    assert captured == {"code": 200, "body": {"impression": "ok", "ask_radiologist": [], "limitations": ""}}


def test_do_post_consult_rejects_when_no_analysis_is_available(monkeypatch) -> None:
    headers = {
        "Sec-Fetch-Site": "same-origin",
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
    }
    handler, captured = make_handler("/api/consult", headers=headers)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})
    monkeypatch.setattr(serve, "consult_ready", lambda: False)

    serve.Handler.do_POST(handler)

    assert captured == {"code": 400, "body": {"error": "no analysis data to consult on — run analyze.py first"}}


def test_do_post_ask_rejects_empty_question(monkeypatch) -> None:
    body = b'{"slug":"scan","slice":0,"question":"   ","x":1,"y":2}'
    headers = {
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        "Content-Length": str(len(body)),
    }
    handler, captured = make_handler("/api/ask", headers=headers, body=body)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})
    monkeypatch.setattr(serve, "valid_slugs", lambda: {"scan"})

    serve.Handler.do_POST(handler)

    assert captured == {"code": 400, "body": {"error": "empty question"}}


def test_do_post_ask_rejects_malformed_json_body(monkeypatch) -> None:
    body = b'{"slug":'
    headers = {
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        "Content-Length": str(len(body)),
    }
    handler, captured = make_handler("/api/ask", headers=headers, body=body)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})

    serve.Handler.do_POST(handler)

    assert captured == {"code": 400, "body": {"error": "invalid JSON body"}}


def test_do_post_ask_forwards_region_payload(monkeypatch) -> None:
    body = b'{"slug":"scan","slice":4,"question":"what is this?","viewerContext":"Cloud action ready.","region":{"x0":1,"y0":2,"x1":5,"y1":6}}'
    headers = {
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        "Content-Length": str(len(body)),
    }
    handler, captured = make_handler("/api/ask", headers=headers, body=body)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})
    monkeypatch.setattr(serve, "valid_slugs", lambda: {"scan"})
    seen = {}

    class FakeAsk:
        @staticmethod
        def ask(slug, slice_idx, question, region=None, provider=None, model=None, viewer_context=None):
            seen["slug"] = slug
            seen["slice_idx"] = slice_idx
            seen["question"] = question
            seen["region"] = region
            seen["provider"] = provider
            seen["model"] = model
            seen["viewer_context"] = viewer_context
            return {"answer": "ok"}

    monkeypatch.setattr(serve, "_lazy_ask", lambda: FakeAsk)

    serve.Handler.do_POST(handler)

    assert seen == {
        "slug": "scan",
        "slice_idx": 4,
        "question": "what is this?",
        "region": (1, 2, 5, 6),
        "provider": None,
        "model": None,
        "viewer_context": "Cloud action ready.",
    }
    assert captured == {"code": 200, "body": {"answer": "ok"}}


def test_do_post_ask_rejects_ambiguous_point_and_region_payload(monkeypatch) -> None:
    body = b'{"slug":"scan","slice":4,"question":"what is this?","x":1,"y":2,"region":{"x0":1,"y0":2,"x1":5,"y1":6}}'
    headers = {
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        "Content-Length": str(len(body)),
    }
    handler, captured = make_handler("/api/ask", headers=headers, body=body)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})

    serve.Handler.do_POST(handler)

    assert captured == {
        "code": 400,
        "body": {"error": "give at most one location: {x, y} OR {region:{x0,y0,x1,y1}}, or neither to ask about the whole study"},
    }


def test_do_post_ask_rejects_inverted_region_box(monkeypatch) -> None:
    body = b'{"slug":"scan","slice":4,"question":"what is this?","region":{"x0":5,"y0":2,"x1":1,"y1":6}}'
    headers = {
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        "Content-Length": str(len(body)),
    }
    handler, captured = make_handler("/api/ask", headers=headers, body=body)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})

    serve.Handler.do_POST(handler)

    assert captured == {
        "code": 400,
        "body": {"error": "region coordinates must define a non-empty top-left to bottom-right box"},
    }


def test_do_post_ask_rejects_negative_slice(monkeypatch) -> None:
    body = b'{"slug":"scan","slice":-1,"question":"what is this?","x":1,"y":2}'
    headers = {
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        "Content-Length": str(len(body)),
    }
    handler, captured = make_handler("/api/ask", headers=headers, body=body)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})
    monkeypatch.setattr(serve, "valid_slugs", lambda: {"scan"})

    serve.Handler.do_POST(handler)

    assert captured == {"code": 400, "body": {"error": "slice must be a non-negative integer"}}


def test_json_writer_ignores_broken_pipe() -> None:
    handler = object.__new__(serve.Handler)
    handler.send_response = lambda code: None
    handler.send_header = lambda key, value: None
    handler.end_headers = lambda: None
    handler.wfile = types.SimpleNamespace(write=lambda payload: (_ for _ in ()).throw(BrokenPipeError()))

    serve.Handler._json(handler, 200, {"ok": True})


def test_log_message_suppresses_optional_sidecar_404(monkeypatch) -> None:
    handler = object.__new__(serve.Handler)
    writes: list[str] = []
    monkeypatch.setattr(serve.sys, "stderr", types.SimpleNamespace(write=writes.append))

    serve.Handler.log_message(handler, '"GET /data/example_analysis.json HTTP/1.1" 404 -')

    assert writes == []


def test_log_message_keeps_unexpected_404(monkeypatch) -> None:
    handler = object.__new__(serve.Handler)
    writes: list[str] = []
    monkeypatch.setattr(serve.sys, "stderr", types.SimpleNamespace(write=writes.append))

    serve.Handler.log_message(handler, '"GET /missing.json HTTP/1.1" 404 -')

    assert writes == ['[serve] "GET /missing.json HTTP/1.1" 404 -\n']


def test_consume_rate_limit_enforces_capacity(monkeypatch) -> None:
    serve.RATE_LIMIT_BUCKETS.clear()
    times = iter([0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
    monkeypatch.setattr(serve.time, "monotonic", lambda: next(times))

    assert serve.consume_rate_limit("/api/analyze", "127.0.0.1") == (True, 0)
    assert serve.consume_rate_limit("/api/analyze", "127.0.0.1") == (True, 0)
    assert serve.consume_rate_limit("/api/analyze", "127.0.0.1") == (True, 0)
    assert serve.consume_rate_limit("/api/analyze", "127.0.0.1") == (True, 0)
    assert serve.consume_rate_limit("/api/analyze", "127.0.0.1") == (True, 0)
    allowed, retry_after = serve.consume_rate_limit("/api/analyze", "127.0.0.1")
    assert allowed is False
    assert retry_after >= 1


def test_enforce_rate_limit_returns_retry_hint(monkeypatch) -> None:
    handler = object.__new__(serve.Handler)
    monkeypatch.setattr(handler, "_rate_limit_key", lambda: "local")
    monkeypatch.setattr(serve, "consume_rate_limit", lambda path, key: (False, 12))

    assert handler._enforce_rate_limit("/api/ask") == (
        429,
        {"error": "rate limit exceeded", "retryAfterSeconds": 12},
    )


def test_localhost_origin_allows_only_loopback_hosts() -> None:
    assert serve.localhost_origin("http://localhost:8000") == "http://localhost:8000"
    assert serve.localhost_origin("https://127.0.0.1:3000") == "https://127.0.0.1:3000"
    assert serve.localhost_origin("https://evil.example") == ""
    assert serve.loopback_host("::1") is True
    assert serve.loopback_host("0.0.0.0") is False


def test_allowed_proxy_asset_url_allows_only_configured_https_origins(monkeypatch) -> None:
    monkeypatch.setattr(serve._asset_proxy, "public_proxy_address", lambda _hostname: "93.184.216.34")
    config = {
        "r2PublicUrl": "https://pub.example/assets",
        "trustedUploadOrigins": ["https://uploads.example"],
    }

    assert serve.allowed_proxy_asset_url("https://pub.example/data/a.png", config) == "https://pub.example/data/a.png"
    assert serve.allowed_proxy_asset_url("https://uploads.example/file.dcm", config) == "https://uploads.example/file.dcm"
    assert serve.allowed_proxy_asset_url("https://evil.example/data/a.png", config) == ""
    assert serve.allowed_proxy_asset_url("http://pub.example/data/a.png", config) == ""


def test_allowed_proxy_asset_url_rejects_private_ip_hosts() -> None:
    config = {"r2PublicUrl": "https://127.0.0.1:8443/assets"}

    assert serve.allowed_proxy_asset_url("https://127.0.0.1:8443/assets/a.png", config) == ""
    assert serve.allowed_proxy_asset_url("https://169.254.169.254/latest/meta-data", {
        "trustedUploadOrigins": ["https://169.254.169.254"],
    }) == ""


def test_allowed_proxy_asset_url_fails_closed_when_dns_fails(monkeypatch) -> None:
    def fail_dns(*_args, **_kwargs):
        raise OSError("dns unavailable")

    monkeypatch.setattr(serve._asset_proxy.socket, "getaddrinfo", fail_dns)

    assert serve.allowed_proxy_asset_url(
        "https://assets.example/data/a.png",
        {"trustedUploadOrigins": ["https://assets.example"]},
    ) == ""


def test_proxy_connection_uses_once_validated_address_and_tls_hostname(monkeypatch) -> None:
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

    fake_socket = object()

    def fake_create_connection(address, timeout, source_address):
        connected["address"] = address
        return fake_socket

    monkeypatch.setattr(serve._asset_proxy.socket, "create_connection", fake_create_connection)
    connection = serve._asset_proxy._PinnedHTTPSConnection(
        "assets.example",
        pinned_ip=request.voxellab_pinned_ip,
        context=FakeContext(),
    )
    connection.connect()

    assert connected["address"] == ("93.184.216.34", 443)
    assert connected["server_hostname"] == "assets.example"
    assert dns_calls == 1


def test_configured_proxy_origins_include_manifest_remote_asset_hosts(tmp_path: Path, monkeypatch) -> None:
    manifest = tmp_path / "manifest.json"
    _ = manifest.write_text(json.dumps({
        "patient": "anonymous",
        "studyDate": "",
        "series": [{
            "slug": "cloud_ct",
            "sliceUrlBase": "https://pub-manifest.example/data/cloud_ct",
            "rawUrl": "https://raw-manifest.example/cloud_ct.raw.zst",
            "regionMetaUrl": "https://labels.example/cloud_ct_regions.json",
            "overlayUrlBases": {
                "cloud_ct_sym": "https://sym.example/data/cloud_ct",
            },
        }],
    }), encoding="utf-8")
    monkeypatch.setattr(serve, "DATA", tmp_path)

    origins = serve.configured_proxy_origins({})

    assert "https://pub-manifest.example" in origins
    assert "https://raw-manifest.example" in origins
    assert "https://labels.example" in origins
    assert "https://sym.example" in origins


def test_allowed_proxy_asset_url_rejects_all_when_no_proxy_origins_are_configured() -> None:
    assert serve.allowed_proxy_asset_url("https://pub.example/data/a.png", {}) == ""


def test_proxy_asset_request_uses_browser_user_agent() -> None:
    req = serve.proxy_asset_request("https://pub.example/data/a.png")

    assert req.full_url == "https://pub.example/data/a.png"
    assert req.get_header("User-agent") == "Mozilla/5.0 (VoxelLab local asset proxy)"


def test_proxy_asset_no_redirect_handler_raises_http_error() -> None:
    handler = serve._asset_proxy._NoRedirect()

    try:
        handler.redirect_request(
            req=serve.proxy_asset_request("https://pub.example/data/a.png"),
            fp=None,
            code=302,
            msg="Found",
            headers={},
            newurl="http://169.254.169.254/latest/meta-data",
        )
    except urllib.error.HTTPError as exc:
        assert exc.code == 302
        assert exc.reason == "redirect blocked: Found"
        assert exc.url == "http://169.254.169.254/latest/meta-data"
    else:
        raise AssertionError("redirect was not blocked")


def test_proxy_asset_real_opener_blocks_http_redirect() -> None:
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


def test_do_get_proxy_asset_streams_remote_body(monkeypatch) -> None:
    class Headers:
        def get_content_type(self):
            return "image/png"

        def get(self, name):
            return "10" if name == "Content-Length" else None

    class Response:
        headers = Headers()

        def __init__(self):
            self.body = io.BytesIO(b"0123456789")
            self.read_sizes: list[int] = []

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, size: int = -1) -> bytes:
            self.read_sizes.append(size)
            return self.body.read(size)

    response = Response()
    handler, _captured = make_handler(
        "/api/proxy-asset?url=https%3A%2F%2Fpub.example%2Fdata%2Fa.png",
        headers={
            "Sec-Fetch-Site": "same-origin",
            "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        },
    )
    handler.wfile = TrackingWriter()
    seen: dict = {"headers": []}
    handler.send_response = lambda code: seen.update({"code": code})
    handler.send_header = lambda name, value: seen["headers"].append((name, value))
    handler.end_headers = lambda: seen.update({"ended": True})
    monkeypatch.setattr(serve, "CONVERT_STREAM_CHUNK_BYTES", 4)
    monkeypatch.setattr(serve, "runtime_config", lambda: {"r2PublicUrl": "https://pub.example/assets"})
    monkeypatch.setattr(serve._asset_proxy, "public_proxy_address", lambda _hostname: "93.184.216.34")
    monkeypatch.setattr(serve, "proxy_asset_urlopen", lambda *_args, **_kwargs: response)

    serve.Handler.do_GET(handler)

    assert seen == {
        "headers": [
            ("Content-Type", "image/png"),
            ("Content-Length", "10"),
            ("Cache-Control", "private, max-age=60"),
        ],
        "code": 200,
        "ended": True,
    }
    assert response.read_sizes == [4, 4, 4, 4]
    assert handler.wfile.write_sizes == [4, 4, 2]
    assert handler.wfile.getvalue() == b"0123456789"


def test_do_get_proxy_asset_blocks_redirect_to_private_host(monkeypatch) -> None:
    handler, captured = make_handler(
        "/api/proxy-asset?url=https%3A%2F%2Fpub.example%2Fdata%2Fa.png",
        headers={
            "Sec-Fetch-Site": "same-origin",
            "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        },
    )
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


def test_end_headers_adds_localhost_cors_and_csp(monkeypatch) -> None:
    handler = object.__new__(serve.Handler)
    headers: list[tuple[str, str]] = []
    handler.path = "/index.html"
    handler.headers = {"Origin": "http://localhost:8000"}
    handler.send_header = lambda key, value: headers.append((key, value))
    monkeypatch.setattr(serve.http.server.SimpleHTTPRequestHandler, "end_headers", lambda self: None)

    serve.Handler.end_headers(handler)

    assert ("Access-Control-Allow-Origin", "http://localhost:8000") in headers
    assert ("Access-Control-Allow-Methods", "GET, POST, OPTIONS") in headers
    assert ("Access-Control-Allow-Headers", "Content-Type, X-VoxelLab-Local-Token") in headers
    assert ("Vary", "Origin") in headers
    csp = dict(headers)["Content-Security-Policy"]
    assert "script-src 'self' 'wasm-unsafe-eval'" in csp
    assert "https://cdn.jsdelivr.net" not in csp
    assert "worker-src 'self'" in csp


def test_static_paths_allow_viewer_assets_and_only_required_node_modules() -> None:
    assert serve.allowed_static_path("/") is True
    assert serve.allowed_static_path("/js/bootstrap.js") is True
    assert serve.allowed_static_path("/data/manifest.json") is True
    assert serve.allowed_static_path("/node_modules/dcmjs/build/dcmjs.es.js") is True
    assert serve.allowed_static_path("/node_modules/three/examples/jsm/controls/TrackballControls.js") is True

    assert serve.allowed_static_path("/package.json") is False
    assert serve.allowed_static_path("/docs/private.md") is False
    assert serve.allowed_static_path("/node_modules/electron/index.js") is False
    assert serve.allowed_static_path("/node_modules/dcmjs/test/sample-dicom.json") is False
    assert serve.allowed_static_path("/node_modules/onnxruntime-web/docs/api/index.md") is False
    assert serve.allowed_static_path("/node_modules/three/examples/jsm/loaders/OBJLoader.js") is False
    assert serve.allowed_static_path("/js/%2e%2e/AGENTS.md") is False


def test_trackball_controls_rewrite_keeps_three_self_hosted() -> None:
    source = "import { EventDispatcher } from 'three';"

    assert serve.rewritten_trackball_controls_source(source) == (
        "import { EventDispatcher } from '../../../build/three.module.js';"
    )


def test_end_headers_skips_cors_for_sensitive_local_api_routes(monkeypatch) -> None:
    handler = object.__new__(serve.Handler)
    headers: list[tuple[str, str]] = []
    handler.path = "/api/proxy-asset?url=https%3A%2F%2Fr2.example%2Fdata%2Fa.png"
    handler.headers = {"Origin": "http://localhost:8000"}
    handler.send_header = lambda key, value: headers.append((key, value))
    monkeypatch.setattr(serve.http.server.SimpleHTTPRequestHandler, "end_headers", lambda self: None)

    serve.Handler.end_headers(handler)

    assert "Access-Control-Allow-Origin" not in dict(headers)
    assert "Content-Security-Policy" in dict(headers)


def test_end_headers_skips_cors_for_non_local_origin(monkeypatch) -> None:
    handler = object.__new__(serve.Handler)
    headers: list[tuple[str, str]] = []
    handler.headers = {"Origin": "https://evil.example"}
    handler.send_header = lambda key, value: headers.append((key, value))
    monkeypatch.setattr(serve.http.server.SimpleHTTPRequestHandler, "end_headers", lambda self: None)

    serve.Handler.end_headers(handler)

    assert "Access-Control-Allow-Origin" not in dict(headers)
    assert "Content-Security-Policy" in dict(headers)


def test_do_options_returns_204(monkeypatch) -> None:
    handler = object.__new__(serve.Handler)
    seen: dict = {}
    handler.send_response = lambda code: seen.setdefault("code", code)
    handler.send_header = lambda key, value: seen.setdefault("headers", []).append((key, value))
    handler.end_headers = lambda: seen.setdefault("ended", True)

    serve.Handler.do_OPTIONS(handler)

    assert seen["code"] == 204
    assert ("Content-Length", "0") in seen["headers"]
    assert seen["ended"] is True


def test_private_local_api_options_reject_cross_origin_with_403() -> None:
    handler, captured = make_handler(
        "/api/consult",
        headers={"Origin": "http://localhost:3000", "Host": "127.0.0.1:8000"},
    )

    serve.Handler.do_OPTIONS(handler)

    assert captured == {"code": 403, "body": {"error": "/api/consult is same-origin only"}}


def test_private_local_api_get_rejects_cross_origin_with_403() -> None:
    handler, captured = make_handler(
        "/api/local-token",
        headers={"Origin": "http://localhost:3000", "Host": "127.0.0.1:8000"},
    )

    serve.Handler.do_GET(handler)

    assert captured == {"code": 403, "body": {"error": "/api/local-token is same-origin only"}}


def test_private_local_api_get_rejects_missing_browser_context_headers() -> None:
    handler, captured = make_handler("/api/local-token")

    serve.Handler.do_GET(handler)

    assert captured == {"code": 403, "body": {"error": "/api/local-token requires a same-origin browser context"}}


def test_private_local_api_get_rejects_same_origin_lan_host() -> None:
    handler, captured = make_handler(
        "/api/local-token",
        headers={"Origin": "http://192.168.1.25:8000", "Host": "192.168.1.25:8000"},
    )

    serve.Handler.do_GET(handler)

    assert captured == {
        "code": 403,
        "body": {"error": "/api/local-token is available only on loopback hosts"},
    }


def test_main_rejects_non_loopback_bind_before_starting_server(monkeypatch, capsys) -> None:
    monkeypatch.setattr(serve.sys, "argv", ["serve.py", "--bind", "0.0.0.0"])
    monkeypatch.setattr(
        serve,
        "ViewerHTTPServer",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("server must not start")),
    )

    assert serve.main() is False
    assert "refusing non-loopback bind" in capsys.readouterr().err


def test_viewer_server_selects_ipv6_socket_for_ipv6_loopback(monkeypatch) -> None:
    captured = {}

    def fake_init(self, server_address, handler, bind_and_activate=True):
        captured.update({
            "family": self.address_family,
            "address": server_address,
            "handler": handler,
            "bind": bind_and_activate,
        })

    monkeypatch.setattr(serve.http.server.ThreadingHTTPServer, "__init__", fake_init)

    _ = serve.ViewerHTTPServer(("::1", 8000), serve.Handler)

    assert captured["family"] == serve.socket.AF_INET6
    assert captured["address"] == ("::1", 8000)


def test_private_local_api_get_rejects_same_origin_fetch_metadata_without_origin() -> None:
    handler, captured = make_handler("/api/local-token", headers={"Sec-Fetch-Site": "same-origin"})

    serve.Handler.do_GET(handler)

    assert captured == {
        "code": 403,
        "body": {"error": "/api/local-token requires a same-origin browser context"},
    }
