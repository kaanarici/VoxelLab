from __future__ import annotations

import io
import json
from pathlib import Path
import sys

import serve


def make_handler(path: str, headers: dict[str, str] | None = None, body: bytes = b"") -> tuple[serve.Handler, dict]:
    captured: dict = {}
    handler = object.__new__(serve.Handler)
    handler.path = path
    handler.headers = headers or {}
    handler.rfile = io.BytesIO(body)
    handler.wfile = io.BytesIO()
    handler._json = lambda code, body: captured.update({"code": code, "body": body})
    return handler, captured


def authed_headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    return {
        "Sec-Fetch-Site": "same-origin",
        "X-VoxelLab-Local-Token": serve.LOCAL_API_TOKEN,
        **(extra or {}),
    }


def test_get_cloud_settings_returns_masked_local_env(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(serve, "ROOT", tmp_path)
    monkeypatch.setattr(serve, "overlay_env", lambda: {
        "MODAL_WEBHOOK_BASE": "https://example-org--medical-imaging-pipeline.modal.run",
        "MODAL_AUTH_TOKEN": "secret-token",
        "R2_PUBLIC_URL": "https://pub.example.r2.dev/assets",
        "TRUSTED_UPLOAD_ORIGINS": "https://pub.example.r2.dev/assets",
    })
    handler, captured = make_handler("/api/cloud-settings", headers=authed_headers())

    serve.Handler.do_GET(handler)

    assert captured["code"] == 200
    body = captured["body"]
    assert body["configured"] is True
    assert body["hasModalAuthToken"] is True
    assert "modalAuthToken" not in body
    assert body["trustedUploadOrigins"] == ["https://pub.example.r2.dev"]


def test_post_cloud_settings_writes_private_env(monkeypatch, tmp_path: Path) -> None:
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
    handler, captured = make_handler(
        "/api/cloud-settings",
        headers=authed_headers({"Content-Length": str(len(body))}),
        body=body,
    )

    serve.Handler.do_POST(handler)

    assert captured["code"] == 200
    assert captured["body"]["hasModalAuthToken"] is True
    written = (tmp_path / ".env").read_text(encoding="utf-8")
    assert "OTHER_VALUE=keep" in written
    assert "MODAL_AUTH_TOKEN=new-token" in written
    assert "MODAL_WEBHOOK_BASE=https://example-org--medical-imaging-pipeline.modal.run" in written
    assert "R2_PUBLIC_URL=https://pub.example.r2.dev/assets" in written
    if sys.platform != "win32":
        assert ((tmp_path / ".env").stat().st_mode & 0o777) == 0o600


def test_cloud_settings_requires_local_api_token() -> None:
    handler, captured = make_handler("/api/cloud-settings", headers={"Sec-Fetch-Site": "same-origin"})

    serve.Handler.do_GET(handler)

    assert captured == {"code": 403, "body": {"error": "missing or invalid local api token"}}
