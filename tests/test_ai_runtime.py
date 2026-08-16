from __future__ import annotations

import json
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
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


CLAUDE_HELP_FIXTURE = """
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  -n, --name <name>                     Set a display name for this session
"""


def test_parse_claude_help_model_aliases_reads_latest_family_aliases() -> None:
    assert ai_runtime.parse_claude_help_model_aliases(CLAUDE_HELP_FIXTURE) == ["fable", "opus", "sonnet"]


def test_claude_picker_models_use_only_supported_help_output() -> None:
    assert ai_runtime._claude_picker_rows(CLAUDE_HELP_FIXTURE) == [
        {"model": "fable", "label": "Fable"},
        {"model": "opus", "label": "Opus"},
        {"model": "sonnet", "label": "Sonnet"},
    ]


def test_parse_codex_model_catalog_keeps_usable_models_and_skips_internal() -> None:
    catalog = {
        "data": [
            {"id": "gpt-5.6-sol-wm", "model": "gpt-5.6-sol-wm", "displayName": "GPT-5.6-Sol-WM", "hidden": True, "isDefault": False},
            {"id": "gpt-daybreak-blue-latest", "model": "gpt-daybreak-blue-latest", "displayName": "Daybreak Blue", "hidden": False, "isDefault": True},
            {"id": "gpt-5.5", "model": "gpt-5.5", "displayName": "GPT-5.5", "hidden": False, "isDefault": False},
            {"id": "codex-auto-review", "model": "codex-auto-review", "displayName": "Codex Auto Review", "hidden": True, "isDefault": False},
        ]
    }

    assert ai_runtime.parse_codex_model_catalog(catalog) == [
        {"model": "gpt-5.6-sol-wm", "label": "GPT-5.6-Sol-WM", "default": False},
        {"model": "gpt-daybreak-blue-latest", "label": "Daybreak Blue", "default": True},
        {"model": "gpt-5.5", "label": "GPT-5.5", "default": False},
    ]


def test_parse_codex_model_catalog_keeps_only_image_input_models() -> None:
    catalog = {
        "data": [
            {
                "id": "gpt-5.5",
                "model": "gpt-5.5",
                "displayName": "GPT-5.5",
                "inputModalities": ["text", "image"],
            },
            {
                "id": "gpt-5.3-codex-spark",
                "model": "gpt-5.3-codex-spark",
                "displayName": "GPT-5.3-Codex-Spark",
                "inputModalities": ["text"],
            },
        ]
    }

    assert ai_runtime.parse_codex_model_catalog(catalog) == [
        {"model": "gpt-5.5", "label": "GPT-5.5", "default": False},
    ]


def test_parse_codex_model_catalog_rejects_unsupported_debug_shape() -> None:
    assert ai_runtime.parse_codex_model_catalog({
        "models": [{"slug": "gpt-5.5", "display_name": "GPT-5.5"}],
    }) == []


def test_codex_model_catalog_bounds_pagination() -> None:
    class FakeApp:
        calls = 0

        def request(self, method, params):
            assert method == "model/list"
            self.calls += 1
            return {
                "data": [{
                    "model": f"gpt-page-{self.calls}",
                    "displayName": f"Page {self.calls}",
                    "inputModalities": ["text", "image"],
                }],
                "nextCursor": f"cursor-{self.calls}",
            }

    app = FakeApp()
    rows, truncated = ai_runtime._codex_model_catalog(app)

    assert truncated is True
    assert app.calls == ai_runtime._CODEX_MODEL_CATALOG_MAX_PAGES
    assert len(rows) == ai_runtime._CODEX_MODEL_CATALOG_MAX_PAGES


def provider_result(provider: str, catalog_status: str = "ready") -> dict:
    return ai_runtime._catalog_provider_status(
        {"provider": provider, "ready": True, "issues": []},
        catalog_status=catalog_status,
        source="claude_help" if provider == "claude" else "codex_app_server",
        model_count=1,
    )


def test_list_cli_models_includes_ready_claude_and_codex_catalogs(monkeypatch) -> None:
    ai_runtime.clear_cli_models_cache()
    monkeypatch.setattr(
        ai_runtime,
        "_discover_claude_models",
        lambda env: (provider_result("claude"), [
            {"key": "claude:opus", "provider": "claude", "model": "opus", "label": "Opus", "group": "Claude Code"},
        ]),
    )
    monkeypatch.setattr(
        ai_runtime,
        "_discover_codex_models",
        lambda env: (provider_result("codex"), [
            {"key": "codex:gpt-5.5", "provider": "codex", "model": "gpt-5.5", "label": "GPT-5.5", "group": "Codex"},
        ]),
    )

    payload = ai_runtime.list_cli_models({})

    assert [item["key"] for item in payload["models"]] == [
        "claude:opus",
        "codex:gpt-5.5",
    ]
    assert payload["models"][0]["label"] == "Opus"
    assert payload["models"][0]["group"] == "Claude Code"
    assert payload["models"][-1]["label"] == "GPT-5.5"
    assert payload["models"][-1]["group"] == "Codex"
    assert [item["catalog"]["status"] for item in payload["providers"]] == ["ready", "ready"]
    assert all(item["catalog"]["timeout_seconds"] == 8 for item in payload["providers"])


def test_list_cli_models_caches_after_discovery_completion(monkeypatch) -> None:
    ai_runtime.clear_cli_models_cache()
    clock = {"now": 10.0}

    def finish_late(env):
        clock["now"] = 100.0
        return provider_result("claude"), []

    monkeypatch.setattr(ai_runtime.time, "monotonic", lambda: clock["now"])
    monkeypatch.setattr(ai_runtime, "_discover_claude_models", finish_late)
    monkeypatch.setattr(ai_runtime, "_discover_codex_models", lambda env: (provider_result("codex"), []))

    _ = ai_runtime.list_cli_models({})

    assert ai_runtime._cli_models_cache is not None
    assert ai_runtime._cli_models_cache[0] == 160.0


def test_list_cli_models_deduplicates_concurrent_discovery(monkeypatch) -> None:
    ai_runtime.clear_cli_models_cache()
    entered = threading.Event()
    release = threading.Event()
    calls = {"claude": 0, "codex": 0}

    def discover_claude(env):
        calls["claude"] += 1
        entered.set()
        assert release.wait(timeout=2)
        return provider_result("claude"), []

    def discover_codex(env):
        calls["codex"] += 1
        return provider_result("codex"), []

    monkeypatch.setattr(ai_runtime, "_discover_claude_models", discover_claude)
    monkeypatch.setattr(ai_runtime, "_discover_codex_models", discover_codex)

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(ai_runtime.list_cli_models, {})
        assert entered.wait(timeout=2)
        second = pool.submit(ai_runtime.list_cli_models, {})
        release.set()
        assert second.result(timeout=2) == first.result(timeout=2)

    assert calls == {"claude": 1, "codex": 1}


def test_claude_catalog_timeout_is_explicit_and_keeps_cli_default(monkeypatch) -> None:
    monkeypatch.setattr(
        ai_runtime,
        "claude_status",
        lambda env=None, timeout=30: {"provider": "claude", "ready": True, "issues": []},
    )
    monkeypatch.setattr(
        ai_runtime,
        "_run_status",
        lambda *args, **kwargs: (_ for _ in ()).throw(subprocess.TimeoutExpired("claude --help", 8)),
    )

    status, models = ai_runtime._discover_claude_models({})

    assert status["ready"] is True
    assert status["catalog"]["status"] == "timeout"
    assert status["catalog"]["issues"] == ["Claude model catalog exceeded 8s"]
    assert models == [{
        "key": "claude:default",
        "provider": "claude",
        "model": "",
        "label": "Claude",
        "group": "Claude Code",
    }]


def test_claude_catalog_does_not_start_after_provider_deadline(monkeypatch) -> None:
    clock = iter((10.0, 18.0))
    monkeypatch.setattr(ai_runtime.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(
        ai_runtime,
        "claude_status",
        lambda env=None, timeout=30: {"provider": "claude", "ready": True, "issues": []},
    )
    monkeypatch.setattr(
        ai_runtime,
        "_run_status",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("help must not run")),
    )

    status, models = ai_runtime._discover_claude_models({})

    assert status["catalog"]["status"] == "timeout"
    assert models == [ai_runtime._default_cli_model("claude")]


def test_codex_catalog_failure_is_explicit_and_keeps_cli_default(monkeypatch) -> None:
    class FakeAppServer:
        def __init__(self, timeout, env):
            assert timeout == 8

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return None

        def request(self, method, params):
            if method == "account/read":
                return {"account": {"type": "chatgpt"}, "requiresOpenaiAuth": True}
            raise RuntimeError("model/list unavailable")

    monkeypatch.setattr(ai_runtime.shutil, "which", lambda name, path=None: "/usr/bin/codex")
    monkeypatch.setattr(ai_runtime, "_CodexAppServer", FakeAppServer)

    status, models = ai_runtime._discover_codex_models({})

    assert status["ready"] is True
    assert status["catalog"]["status"] == "error"
    assert status["catalog"]["issues"] == ["could not read Codex model catalog: model/list unavailable"]
    assert models == [{
        "key": "codex:default",
        "provider": "codex",
        "model": "",
        "label": "Codex",
        "group": "Codex",
    }]
