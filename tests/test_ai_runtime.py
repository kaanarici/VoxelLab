from __future__ import annotations

import json
from pathlib import Path

import ai_runtime


class DummyCompleted:
    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_public_ai_status_reports_disabled_state() -> None:
    status = ai_runtime.public_ai_status(False, provider="codex")

    assert status["enabled"] is False
    assert status["provider"] == "codex"
    assert status["status_source"] == "disabled"


def test_codex_status_reports_config_error(monkeypatch) -> None:
    monkeypatch.setattr(ai_runtime.shutil, "which", lambda name, path=None: "/usr/bin/codex")
    monkeypatch.setattr(
        ai_runtime,
        "_codex_account_read",
        lambda env=None, timeout=30: (_ for _ in ()).throw(
            RuntimeError("Error loading configuration: /Users/test/.codex/config.toml:82:1: missing field `path`")
        ),
    )

    status = ai_runtime.codex_status({})

    assert status["ready"] is False
    assert status["status_source"] == "config_error"
    assert "Error loading configuration" in status["issues"][0]


def test_codex_status_reads_app_server_account(monkeypatch) -> None:
    monkeypatch.setattr(ai_runtime.shutil, "which", lambda name, path=None: "/usr/bin/codex")
    monkeypatch.setattr(
        ai_runtime,
        "_codex_account_read",
        lambda env=None, timeout=30: {"account": {"type": "chatgpt"}, "requiresOpenaiAuth": True},
    )

    status = ai_runtime.codex_status({})

    assert status["ready"] is True
    assert status["auth_mode"] == "chatgpt"
    assert status["status_source"] == "app_server_account"


def test_run_structured_codex_uses_app_server_stream(monkeypatch, tmp_path: Path) -> None:
    calls: list[dict] = []
    monkeypatch.setattr(ai_runtime, "require_provider_ready", lambda provider=None, env=None: {"provider": "codex", "ready": True})
    monkeypatch.setattr(ai_runtime, "resolve_model", lambda model=None, provider=None, env=None: "gpt-5.4")

    def fake_stream(**kwargs):
        calls.append(kwargs)
        yield {"type": "result", "output": {"answer": "ok"}}

    monkeypatch.setattr(ai_runtime, "_stream_codex_app_server", fake_stream)

    schema = {"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"]}
    result = ai_runtime.run_structured(
        prompt="Describe the attached image.",
        system="Return JSON only.",
        schema=schema,
        provider="codex",
        images=[tmp_path / "slice.png"],
    )

    assert result == {"answer": "ok"}
    assert calls[0]["schema"] == schema
    assert calls[0]["images"] == [tmp_path / "slice.png"]


def test_run_structured_claude_prefixes_image_reads(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(ai_runtime, "require_provider_ready", lambda provider=None, env=None: {"provider": "claude", "ready": True})
    monkeypatch.setattr(ai_runtime, "resolve_model", lambda model=None, provider=None, env=None: "claude-opus-4-6")

    observed = {}

    def fake_run(cmd, input=None, capture_output=None, text=None, timeout=None, env=None):
        observed["cmd"] = cmd
        observed["input"] = input
        return DummyCompleted(stdout=json.dumps({"structured_output": {"answer": "ok"}}))

    monkeypatch.setattr(ai_runtime.subprocess, "run", fake_run)

    result = ai_runtime.run_structured(
        prompt="Describe the image.",
        system="Return JSON only.",
        schema={"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"]},
        provider="claude",
        images=[tmp_path / "slice.png"],
    )

    assert result == {"answer": "ok"}
    assert "Read these local image files before answering:" in observed["input"]
    assert str((tmp_path / "slice.png").resolve()) in observed["input"]


def test_run_structured_claude_omits_forced_model_and_permission_bypass(monkeypatch) -> None:
    monkeypatch.setattr(ai_runtime, "require_provider_ready", lambda provider=None, env=None: {"provider": "claude", "ready": True})
    monkeypatch.setattr(ai_runtime, "resolve_model", lambda model=None, provider=None, env=None: "")

    observed = {}

    def fake_run(cmd, input=None, capture_output=None, text=None, timeout=None, env=None):
        observed["cmd"] = cmd
        return DummyCompleted(stdout=json.dumps({"structured_output": {"answer": "ok"}}))

    monkeypatch.setattr(ai_runtime.subprocess, "run", fake_run)

    result = ai_runtime.run_structured(
        prompt="Describe the image.",
        system="Return JSON only.",
        schema={"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"]},
        provider="claude",
    )

    assert result == {"answer": "ok"}
    assert "--model" not in observed["cmd"]
    assert "bypassPermissions" not in observed["cmd"]
