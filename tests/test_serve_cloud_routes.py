from __future__ import annotations

import io
import json
import os
from pathlib import Path
import sys
import urllib.error

import pytest

import cloud_settings
import serve

from tests.helpers.python.serve_http import browser_headers, make_handler, token_headers
from tests.helpers.python.streams import FakeHTTPResponse

CLOUD_READY = {"ai": {"enabled": True, "ready": True}}

@pytest.fixture()
def cloud_ready(monkeypatch):
    """Runtime config with the cloud proxy enabled."""
    monkeypatch.setattr(serve, "runtime_config", lambda: CLOUD_READY)

def post(path: str, payload: bytes, monkeypatch=None) -> dict:
    handler, captured = make_handler(path, headers=token_headers(payload), body=payload)
    serve.Handler.do_POST(handler)
    return captured

def test_runtime_config_overlays_env_over_the_committed_config(monkeypatch, tmp_path: Path) -> None:
    _ = (tmp_path / "config.json").write_text(json.dumps({
        "modalWebhookBase": "https://remote.example",
        "r2PublicUrl": "https://static.example",
        "trustedUploadOrigins": ["https://static-upload.example"],
        "siteName": "VoxelLab Base",
        "disclaimer": "Base disclaimer",
        "features": {"cloudProcessing": True, "aiAnalysis": False},
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
    ai_status = {"enabled": True, "provider": "codex", "ready": False, "issues": ["missing key"]}
    called: dict = {}

    monkeypatch.setattr(serve, "ROOT", tmp_path)
    monkeypatch.setattr(serve, "overlay_env", lambda: env.copy())
    monkeypatch.setattr(
        serve,
        "public_ai_status",
        lambda enabled, env=None: called.update({"enabled": enabled, "env": env}) or ai_status,
    )

    config = serve.runtime_config()

    assert config["modalWebhookBase"] == ""
    assert config["trustedUploadOrigins"] == ["https://upload-a.example", "https://upload-b.example"]
    assert config["r2PublicUrl"] == "https://public-r2.example"
    assert config["siteName"] == "VoxelLab Local"
    assert config["disclaimer"] == "Local disclaimer"
    assert config["features"] == {"cloudProcessing": False, "aiAnalysis": True}
    assert config["ai"] == ai_status
    assert config["localAiAvailable"] is False
    assert called["enabled"] is True
    assert called["env"]["MODAL_AUTH_TOKEN"] == "modal-auth-token"

def test_runtime_config_routes_the_browser_through_the_local_cloud_proxy(monkeypatch, tmp_path: Path) -> None:
    _ = (tmp_path / "config.json").write_text(json.dumps({"modalWebhookBase": "https://remote.example"}))
    monkeypatch.setattr(serve, "ROOT", tmp_path)
    monkeypatch.setattr(serve, "overlay_env", lambda: {
        "MODAL_WEBHOOK_BASE": "https://example-org--medical-imaging-pipeline.modal.run",
        "MODAL_AUTH_TOKEN": "modal-auth-token",
    })
    monkeypatch.setattr(serve, "public_ai_status", lambda enabled, env=None: {"enabled": enabled})

    config = serve.runtime_config()

    assert config["modalWebhookBase"] == "/api/cloud"
    assert "localApiToken" not in config
    assert "modalAuthToken" not in config
    assert "modal-auth-token" not in json.dumps(config)

def test_config_route_serves_the_runtime_config(monkeypatch) -> None:
    expected = {"siteName": "VoxelLab"}
    handler, captured = make_handler("/config.json")
    monkeypatch.setattr(serve, "runtime_config", lambda: expected)

    serve.Handler.do_GET(handler)

    assert captured == {"code": 200, "body": expected}

def test_cloud_proxy_forwards_the_body_with_the_server_side_token(cloud_ready, monkeypatch) -> None:
    seen: dict = {}
    monkeypatch.setattr(
        serve,
        "proxy_modal_json",
        lambda function_name, payload, timeout=60: seen.update(
            {"function_name": function_name, "payload": payload, "timeout": timeout}
        ) or (200, {"status": "started"}),
    )

    captured = post("/api/cloud/start_processing", b'{"job_id":"job_123","items":[{"upload_id":"f000000"}]}')

    assert seen == {
        "function_name": "start_processing",
        "payload": {"job_id": "job_123", "items": [{"upload_id": "f000000"}]},
        "timeout": 120,
    }
    assert captured == {"code": 200, "body": {"status": "started"}}

@pytest.mark.parametrize(
    ("path", "body", "error"),
    [
        (
            "/api/cloud/get_upload_urls",
            b'{"items":[{"filename":"slice.dcm"}]}',
            "expected body {items:[{upload_id, filename}, ...]}",
        ),
        ("/api/cloud/check_status", b"{}", "missing job_id"),
        ("/api/cloud/check_status", b'{"job_id":', "invalid JSON body"),
        (
            "/api/cloud/start_processing",
            b'{"job_id":"job_123","total_upload_bytes":-1}',
            "total_upload_bytes must be a non-negative integer",
        ),
    ],
    ids=["upload-items-without-ids", "missing-job-id", "malformed-json", "negative-upload-bytes"],
)
def test_cloud_proxy_rejects_malformed_requests_before_calling_modal(
    cloud_ready, monkeypatch, path: str, body: bytes, error: str
) -> None:
    monkeypatch.setattr(
        serve,
        "proxy_modal_json",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("modal must not be called")),
    )

    assert post(path, body) == {"code": 400, "body": {"error": error}}

def test_cloud_proxy_is_closed_while_cloud_processing_is_disabled(monkeypatch) -> None:
    monkeypatch.setattr(serve, "runtime_config", lambda: {"features": {"cloudProcessing": False}})

    captured = post("/api/cloud/get_upload_urls", b'{"items":[{"upload_id":"u1","filename":"slice.dcm"}]}')

    assert captured == {"code": 503, "body": {"error": "cloud processing is disabled"}}

def test_modal_success_bodies_are_capped_before_parsing(monkeypatch) -> None:
    response = FakeHTTPResponse(b'{"status":"started"}')
    monkeypatch.setattr(serve, "MAX_MODAL_JSON_BODY_BYTES", 5)
    monkeypatch.setattr(serve, "modal_cloud_base", lambda: "https://example-org--pipeline.modal.run")
    monkeypatch.setattr(serve, "modal_auth_token", lambda: "token")
    monkeypatch.setattr(serve.urlrequest, "urlopen", lambda *_args, **_kwargs: response)

    assert serve.proxy_modal_json("start_processing", {"job_id": "job_123"}) == (
        502,
        {"error": "modal response body too large"},
    )
    assert response.read_sizes == [6]

def test_modal_error_bodies_are_capped_before_parsing(monkeypatch) -> None:
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
    monkeypatch.setattr(
        serve.urlrequest,
        "urlopen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(error),
    )

    assert serve.proxy_modal_json("get_upload_urls", {"items": []}) == (
        413,
        {"error": "modal error response body too large"},
    )

def test_cloud_settings_report_configured_origins_without_the_auth_token(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(serve, "ROOT", tmp_path)
    monkeypatch.setattr(serve, "overlay_env", lambda: {
        "MODAL_WEBHOOK_BASE": "https://example-org--medical-imaging-pipeline.modal.run",
        "MODAL_AUTH_TOKEN": "secret-token",
        "R2_ENDPOINT": "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
        "R2_PUBLIC_URL": "https://pub.example.r2.dev/assets",
        "TRUSTED_UPLOAD_ORIGINS": "https://pub.example.r2.dev/assets",
    })
    handler, captured = make_handler("/api/cloud-settings", headers=browser_headers())

    serve.Handler.do_GET(handler)

    assert captured["code"] == 200
    assert captured["body"]["configured"] is True
    assert captured["body"]["hasModalAuthToken"] is True
    assert "modalAuthToken" not in captured["body"]
    assert captured["body"]["trustedUploadOrigins"] == [
        "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
        "https://pub.example.r2.dev",
    ]

def test_cloud_settings_write_secrets_only_to_the_private_env_file(monkeypatch, tmp_path: Path) -> None:
    _ = (tmp_path / ".env").write_text("OTHER_VALUE=keep\nMODAL_AUTH_TOKEN=old-token\n", encoding="utf-8")
    monkeypatch.setattr(serve, "ROOT", tmp_path)
    monkeypatch.setattr(serve, "overlay_env", lambda: {"MODAL_AUTH_TOKEN": "old-token"})
    body = json.dumps({
        "modalWebhookBase": "https://example-org--medical-imaging-pipeline.modal.run",
        "modalAuthToken": "new-token",
        "r2PublicUrl": "https://pub.example.r2.dev/assets",
        "trustedUploadOrigins": ["https://pub.example.r2.dev/assets"],
        "cloudProcessing": True,
    }).encode()
    handler, captured = make_handler("/api/cloud-settings", headers=browser_headers(body), body=body)

    serve.Handler.do_POST(handler)

    written = (tmp_path / ".env").read_text(encoding="utf-8")
    assert captured["code"] == 200
    assert captured["body"]["hasModalAuthToken"] is True
    assert "OTHER_VALUE=keep" in written
    assert "MODAL_AUTH_TOKEN=new-token" in written
    assert "MODAL_WEBHOOK_BASE=https://example-org--medical-imaging-pipeline.modal.run" in written
    assert "R2_PUBLIC_URL=https://pub.example.r2.dev/assets" in written
    if sys.platform != "win32":
        assert ((tmp_path / ".env").stat().st_mode & 0o777) == 0o600

def test_cloud_settings_keep_the_previous_env_when_the_replace_fails(monkeypatch, tmp_path: Path) -> None:
    env_path = tmp_path / ".env"
    previous = "OTHER_VALUE=keep\nMODAL_AUTH_TOKEN=old-token\n"
    _ = env_path.write_text(previous, encoding="utf-8")

    def fail_replace(source: os.PathLike[str], destination: os.PathLike[str]) -> None:
        raise OSError("simulated replacement failure")

    monkeypatch.setattr(cloud_settings.os, "replace", fail_replace)

    with pytest.raises(OSError, match="simulated replacement failure"):
        _ = cloud_settings.write_cloud_settings(
            tmp_path,
            {"modalAuthToken": "new-token"},
            {"MODAL_AUTH_TOKEN": "old-token"},
        )

    staged = tmp_path / ".env.voxellab.tmp"
    assert env_path.read_text(encoding="utf-8") == previous
    assert staged.exists()
    if sys.platform != "win32":
        assert (staged.stat().st_mode & 0o777) == 0o600
