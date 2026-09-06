from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
import threading
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from runtime_env import ROOT, overlay_env

SUPPORTED_PROVIDERS = {"claude", "codex"}

DEFAULT_MODELS = {
    "claude": "",
    "codex": "",
}

CODEX_CLIENT_INFO = {
    "name": "voxellab",
    "title": "VoxelLab",
    "version": "0.1.0",
}
CODEX_NOTIFICATION_OPTOUTS = [
    "item/fileChange/patchUpdated",
    "item/reasoning/summaryTextDelta",
    "turn/diff/updated",
]

def _claude_agent_bash_enabled(env: dict[str, str] | None = None) -> bool:

    raw = (overlay_env(env).get("VOXELLAB_ASK_CLAUDE_BASH") or "").strip().lower()
    return raw in {"1", "true", "yes", "on"}

def configured_provider(provider: str | None = None, env: dict[str, str] | None = None) -> str:
    raw = (provider or overlay_env(env).get("VOXELLAB_AI_PROVIDER") or "claude").strip().lower()
    if raw not in SUPPORTED_PROVIDERS:
        raise RuntimeError(
            f"unsupported AI provider {raw!r}; expected one of {sorted(SUPPORTED_PROVIDERS)}"
        )
    return raw

def resolve_model(model: str | None = None, provider: str | None = None, env: dict[str, str] | None = None) -> str:
    env_map = overlay_env(env)
    chosen_provider = configured_provider(provider, env_map)
    return (model or env_map.get("VOXELLAB_AI_MODEL") or DEFAULT_MODELS[chosen_provider] or "").strip()

_CLI_MODELS_TTL_S = 60.0
_CLI_MODEL_DISCOVERY_TIMEOUT_S = 8.0
_CODEX_MODEL_CATALOG_MAX_PAGES = 5
_cli_models_cache: tuple[float, dict[str, Any]] | None = None
_cli_models_condition = threading.Condition()
_cli_models_inflight = False
_CLAUDE_MODEL_OPTION_RE = re.compile(
    r"--model <model>(.*?)(?:\n  -n,|\n  --[a-z]|\Z)",
    re.S,
)
_CLAUDE_ALIAS_GROUP_RE = re.compile(
    r"alias for the latest model\s*\((.*?)\)",
    re.I | re.S,
)
_CLAUDE_ALIAS_TOKEN_RE = re.compile(r"'([a-z][a-z0-9._-]{0,31})'")

def clear_cli_models_cache() -> None:
    global _cli_models_cache
    with _cli_models_condition:
        _cli_models_cache = None

def parse_claude_help_model_aliases(help_text: str) -> list[str]:
    block_match = _CLAUDE_MODEL_OPTION_RE.search(help_text or "")
    block = block_match.group(1) if block_match else (help_text or "")
    alias_match = _CLAUDE_ALIAS_GROUP_RE.search(block)
    source = alias_match.group(1) if alias_match else block
    aliases: list[str] = []
    for token in _CLAUDE_ALIAS_TOKEN_RE.findall(source):
        if token.startswith("claude-") or token in aliases:
            continue
        aliases.append(token)
    return aliases

def parse_codex_model_catalog(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    return _parse_codex_app_model_list(payload)

def _claude_alias_label(alias: str) -> str:
    return alias[:1].upper() + alias[1:] if alias else "Claude"

def _is_internal_codex_model(model_id: str) -> bool:
    return "auto-review" in model_id.lower()

def _codex_supports_image_input(item: dict[str, Any]) -> bool:
    raw = item.get("inputModalities")
    if raw is None:
        return True
    if not isinstance(raw, list):
        return False
    return any(str(value).strip().lower() == "image" for value in raw)

def _parse_codex_app_model_list(payload: dict[str, Any]) -> list[dict[str, Any]]:
    listed: list[dict[str, Any]] = []
    for item in payload.get("data") or []:
        if not isinstance(item, dict):
            continue
        model = str(item.get("model") or item.get("id") or "").strip()
        if not model or _is_internal_codex_model(model) or not _codex_supports_image_input(item):
            continue
        listed.append({
            "model": model,
            "label": str(item.get("displayName") or model).strip() or model,
            "default": bool(item.get("isDefault")),
        })
    return listed

def _claude_picker_rows(help_text: str) -> list[dict[str, str]]:
    return [
        {"model": alias, "label": _claude_alias_label(alias)}
        for alias in parse_claude_help_model_aliases(help_text)
    ]

def _catalog_provider_status(
    status: dict[str, Any],
    *,
    catalog_status: str,
    source: str,
    issues: list[str] | None = None,
    model_count: int = 0,
) -> dict[str, Any]:
    return {
        "provider": str(status.get("provider") or ""),
        "ready": bool(status.get("ready")),
        "issues": list(status.get("issues") or []),
        "catalog": {
            "status": catalog_status,
            "source": source,
            "issues": list(issues or []),
            "model_count": model_count,
            "timeout_seconds": _CLI_MODEL_DISCOVERY_TIMEOUT_S,
        },
    }

def _default_cli_model(provider: str) -> dict[str, Any]:
    return {
        "key": f"{provider}:default",
        "provider": provider,
        "model": "",
        "label": "Claude" if provider == "claude" else "Codex",
        "group": "Claude Code" if provider == "claude" else "Codex",
    }

def _claude_model_rows(rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    return [{
        "key": f"claude:{item['model']}",
        "provider": "claude",
        "model": item["model"],
        "label": item["label"],
        "group": "Claude Code",
    } for item in rows]

def _codex_model_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{
        "key": f"codex:{item['model']}",
        "provider": "codex",
        "model": item["model"],
        "label": item["label"],
        "group": "Codex",
    } for item in rows]

def _discover_claude_models(env: dict[str, str]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    deadline = time.monotonic() + _CLI_MODEL_DISCOVERY_TIMEOUT_S
    status = claude_status(env, timeout=_CLI_MODEL_DISCOVERY_TIMEOUT_S)
    if not status.get("ready"):
        return _catalog_provider_status(status, catalog_status="skipped", source="claude_help"), []
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        issue = f"Claude model catalog exceeded {_CLI_MODEL_DISCOVERY_TIMEOUT_S:g}s"
        return _catalog_provider_status(
            status, catalog_status="timeout", source="claude_help", issues=[issue]
        ), [_default_cli_model("claude")]
    try:
        result = _run_status(
            ["claude", "--help"],
            timeout=remaining,
            env=env,
        )
    except subprocess.TimeoutExpired:
        issue = f"Claude model catalog exceeded {_CLI_MODEL_DISCOVERY_TIMEOUT_S:g}s"
        return _catalog_provider_status(
            status, catalog_status="timeout", source="claude_help", issues=[issue]
        ), [_default_cli_model("claude")]
    except Exception as exc:
        issue = f"could not read Claude model catalog: {_compact_error_text(str(exc))}"
        return _catalog_provider_status(
            status, catalog_status="error", source="claude_help", issues=[issue]
        ), [_default_cli_model("claude")]
    if result.returncode != 0:
        detail = _compact_error_text(result.stderr or result.stdout or str(result.returncode))
        issue = f"`claude --help` failed: {detail}"
        return _catalog_provider_status(
            status, catalog_status="error", source="claude_help", issues=[issue]
        ), [_default_cli_model("claude")]
    help_text = f"{result.stdout or ''}\n{result.stderr or ''}"
    rows = _claude_model_rows(_claude_picker_rows(help_text))
    catalog_status = "ready" if rows else "empty"
    issues = [] if rows else ["Claude help did not list model aliases; using the CLI default"]
    return _catalog_provider_status(
        status,
        catalog_status=catalog_status,
        source="claude_help",
        issues=issues,
        model_count=len(rows),
    ), rows or [_default_cli_model("claude")]

def _codex_model_catalog(app: "_CodexAppServer") -> tuple[list[dict[str, Any]], bool]:
    items: list[Any] = []
    cursor: str | None = None
    seen_cursors: set[str] = set()
    for _ in range(_CODEX_MODEL_CATALOG_MAX_PAGES):
        params: dict[str, Any] = {"includeHidden": True, "limit": 100}
        if cursor:
            params["cursor"] = cursor
        page = app.request("model/list", params)
        chunk = page.get("data")
        if isinstance(chunk, list):
            items.extend(chunk)
        cursor_value = page.get("nextCursor")
        if not isinstance(cursor_value, str) or not cursor_value:
            return _parse_codex_app_model_list({"data": items}), False
        if cursor_value in seen_cursors:
            return _parse_codex_app_model_list({"data": items}), True
        seen_cursors.add(cursor_value)
        cursor = cursor_value
    return _parse_codex_app_model_list({"data": items}), True

def _discover_codex_models(env: dict[str, str]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if shutil.which("codex", path=env.get("PATH")) is None:
        status = _missing_provider_status("codex")
        return _catalog_provider_status(status, catalog_status="skipped", source="codex_app_server"), []
    deadline = time.monotonic() + _CLI_MODEL_DISCOVERY_TIMEOUT_S
    status: dict[str, Any] | None = None
    try:
        with _CodexAppServer(_CLI_MODEL_DISCOVERY_TIMEOUT_S, env) as app:
            status = _codex_status_from_account(app.request("account/read", {"refreshToken": False}))
            if not status.get("ready"):
                return _catalog_provider_status(
                    status, catalog_status="skipped", source="codex_app_server"
                ), []
            parsed, truncated = _codex_model_catalog(app)
    except Exception as exc:
        timed_out = time.monotonic() >= deadline
        detail = f"{_CLI_MODEL_DISCOVERY_TIMEOUT_S:g}s" if timed_out else _compact_error_text(str(exc))
        if status is None:
            prefix = "Codex provider status exceeded" if timed_out else "could not read Codex app-server account state:"
            issue = f"{prefix} {detail}"
            status = {
                "provider": "codex",
                "ready": False,
                "issues": [issue],
                "auth_mode": None,
                "status_source": "app_server_account",
            }
            return _catalog_provider_status(
                status,
                catalog_status="skipped",
                source="codex_app_server",
                issues=["Codex model catalog skipped because provider status was unavailable"],
            ), []
        catalog_status = "timeout" if timed_out else "error"
        prefix = "Codex model catalog exceeded" if timed_out else "could not read Codex model catalog:"
        issue = f"{prefix} {detail}"
        return _catalog_provider_status(
            status, catalog_status=catalog_status, source="codex_app_server", issues=[issue]
        ), [_default_cli_model("codex")]
    rows = _codex_model_rows(parsed)
    if truncated:
        issue = f"Codex model catalog exceeded {_CODEX_MODEL_CATALOG_MAX_PAGES} pages"
        return _catalog_provider_status(
            status,
            catalog_status="truncated",
            source="codex_app_server",
            issues=[issue],
            model_count=len(rows),
        ), rows or [_default_cli_model("codex")]
    catalog_status = "ready" if rows else "empty"
    issues = [] if rows else ["Codex app-server returned no usable image-input models; using its default"]
    return _catalog_provider_status(
        status,
        catalog_status=catalog_status,
        source="codex_app_server",
        issues=issues,
        model_count=len(rows),
    ), rows or [_default_cli_model("codex")]

def list_cli_models(env: dict[str, str] | None = None) -> dict[str, Any]:
    global _cli_models_cache, _cli_models_inflight
    with _cli_models_condition:
        while True:
            now = time.monotonic()
            if _cli_models_cache is not None and now < _cli_models_cache[0]:
                return _cli_models_cache[1]
            if not _cli_models_inflight:
                _cli_models_inflight = True
                break
            _ = _cli_models_condition.wait()
    payload: dict[str, Any] = {"models": [], "providers": []}
    try:
        env_map = overlay_env(env)
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="voxellab-models") as pool:
            claude_future = pool.submit(_discover_claude_models, env_map)
            codex_future = pool.submit(_discover_codex_models, env_map)
            claude_status_payload, claude_models = claude_future.result()
            codex_status_payload, codex_models = codex_future.result()
        payload = {
            "models": [*claude_models, *codex_models],
            "providers": [claude_status_payload, codex_status_payload],
        }
    except Exception as exc:
        issue = f"model discovery failed: {_compact_error_text(str(exc))}"
        payload = {
            "models": [],
            "providers": [
                _catalog_provider_status(
                    {"provider": provider, "ready": False, "issues": [issue]},
                    catalog_status="error",
                    source="claude_help" if provider == "claude" else "codex_app_server",
                    issues=[issue],
                )
                for provider in ("claude", "codex")
            ],
        }
    finally:
        with _cli_models_condition:
            _cli_models_cache = (time.monotonic() + _CLI_MODELS_TTL_S, payload)
            _cli_models_inflight = False
            _cli_models_condition.notify_all()
    return payload

def _compact_error_text(text: str, limit: int = 240) -> str:
    one_line = " ".join(text.split())
    return one_line[:limit] + ("..." if len(one_line) > limit else "")

def _run_status(cmd: list[str], timeout: float = 30, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=overlay_env(env))

def _missing_provider_status(provider: str) -> dict[str, Any]:
    return {
        "provider": provider,
        "ready": False,
        "issues": [f"`{provider}` CLI not found on PATH"],
        "auth_mode": None,
        "status_source": "missing_cli",
    }

def claude_status(env: dict[str, str] | None = None, timeout: float = 30) -> dict[str, Any]:
    env_map = overlay_env(env)
    if shutil.which("claude", path=env_map.get("PATH")) is None:
        return _missing_provider_status("claude")
    try:
        result = _run_status(["claude", "auth", "status"], timeout=timeout, env=env_map)
    except Exception as exc:
        return {
            "provider": "claude",
            "ready": False,
            "issues": [f"could not read `claude auth status`: {exc}"],
            "auth_mode": None,
            "status_source": "status_command",
        }
    if result.returncode != 0:
        detail = _compact_error_text(result.stderr or result.stdout or str(result.returncode))
        return {
            "provider": "claude",
            "ready": False,
            "issues": [f"`claude auth status` failed: {detail}"],
            "auth_mode": None,
            "status_source": "status_command",
        }
    try:
        payload = json.loads(result.stdout or "{}")
    except Exception as exc:
        return {
            "provider": "claude",
            "ready": False,
            "issues": [f"could not parse `claude auth status`: {exc}"],
            "auth_mode": None,
            "status_source": "status_command",
        }
    if not payload.get("loggedIn"):
        return {
            "provider": "claude",
            "ready": False,
            "issues": ["Claude CLI is not logged in; run `claude auth login`."],
            "auth_mode": payload.get("authMethod"),
            "status_source": "status_command",
        }
    auth_method = payload.get("authMethod")
    return {
        "provider": "claude",
        "ready": True,
        "issues": [],
        "auth_mode": auth_method if isinstance(auth_method, str) else None,
        "status_source": "status_command",
    }

def _codex_status_from_account(account: dict[str, Any]) -> dict[str, Any]:
    active = account.get("account")
    if not active and account.get("requiresOpenaiAuth", True):
        return {
            "provider": "codex",
            "ready": False,
            "issues": ["Codex app-server is not signed in; start a ChatGPT or API-key login in Codex."],
            "auth_mode": None,
            "status_source": "app_server_account",
        }
    auth_mode = active.get("type") if isinstance(active, dict) else "not_required"
    return {
        "provider": "codex",
        "ready": True,
        "issues": [],
        "auth_mode": auth_mode if isinstance(auth_mode, str) else None,
        "status_source": "app_server_account",
    }

def codex_status(env: dict[str, str] | None = None) -> dict[str, Any]:
    env_map = overlay_env(env)
    if shutil.which("codex", path=env_map.get("PATH")) is None:
        return _missing_provider_status("codex")
    try:
        account = _codex_account_read(env=env_map, timeout=30)
    except Exception as exc:
        detail = _compact_error_text(str(exc))
        if "Error loading configuration:" in detail:
            source = "config_error"
            issues = [detail]
        else:
            source = "app_server_account"
            issues = [f"could not read Codex app-server account state: {detail}"]
        return {
            "provider": "codex",
            "ready": False,
            "issues": issues,
            "auth_mode": None,
            "status_source": source,
        }
    return _codex_status_from_account(account)

def provider_status(provider: str | None = None, env: dict[str, str] | None = None) -> dict[str, Any]:
    env_map = overlay_env(env)
    try:
        chosen = configured_provider(provider, env_map)
    except RuntimeError as exc:
        raw = (provider or env_map.get("VOXELLAB_AI_PROVIDER") or "").strip().lower() or None
        return {
            "provider": raw,
            "ready": False,
            "issues": [str(exc)],
            "auth_mode": None,
            "status_source": "config_error",
        }
    return claude_status(env) if chosen == "claude" else codex_status(env)

def public_ai_status(enabled: bool, provider: str | None = None, env: dict[str, str] | None = None) -> dict[str, Any]:
    if not enabled:
        env_map = overlay_env(env)
        raw = (provider or env_map.get("VOXELLAB_AI_PROVIDER") or "claude").strip().lower() or None
        return {
            "enabled": False,
            "provider": raw,
            "ready": False,
            "issues": ["AI features are disabled in config."],
            "auth_mode": None,
            "status_source": "disabled",
        }
    status = provider_status(provider, env)
    return {"enabled": True, **status}

def require_provider_ready(provider: str | None = None, env: dict[str, str] | None = None) -> dict[str, Any]:
    status = provider_status(provider, env)
    if not status["ready"]:
        issues = "; ".join(status.get("issues") or ["provider not ready"])
        raise RuntimeError(f"{status['provider']} provider not ready: {issues}")
    return status

def _claude_prompt(prompt: str, images: list[Path]) -> str:
    if not images:
        return prompt
    lines = ["Read these local image files before answering:"]
    lines.extend(f"- {path.resolve()}" for path in images)
    lines.append("")
    lines.append(prompt)
    return "\n".join(lines)

def _parse_claude_payload(proc: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    if proc.returncode != 0:
        raise RuntimeError(f"claude exited {proc.returncode}: {proc.stderr.strip() or proc.stdout.strip()}")
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"claude returned non-JSON: {exc}\n{proc.stdout[:400]}") from exc
    if payload.get("is_error"):
        raise RuntimeError(f"claude reported error: {payload.get('result', '')}")
    out = payload.get("structured_output")
    if out is None:
        raise RuntimeError(f"no structured_output in response: {json.dumps(payload)[:400]}")
    return out

def _run_claude(
    prompt: str,
    system: str,
    schema: dict[str, Any],
    model: str,
    images: list[Path],
    timeout: int,
    *,
    allow_agent_tools: bool = False,
    add_dirs: list[Path] | None = None,
) -> dict[str, Any]:
    cmd = [
        "claude",
        "-p",
        "--output-format",
        "json",
        "--allowedTools",
        "Read,Bash" if (allow_agent_tools and _claude_agent_bash_enabled()) else "Read",
        "--append-system-prompt",
        system,
        "--json-schema",
        json.dumps(schema),
        "--no-session-persistence",
    ]
    if model:
        cmd[4:4] = ["--model", model]
    for directory in add_dirs or []:
        cmd += ["--add-dir", str(Path(directory).resolve())]
    text = _claude_prompt(prompt, images)

    def _invoke(cwd: str | None) -> subprocess.CompletedProcess[str]:
        kwargs: dict[str, Any] = {
            "input": text,
            "capture_output": True,
            "text": True,
            "timeout": timeout,
            "env": overlay_env(),
        }
        if cwd is not None:
            kwargs["cwd"] = cwd
        return subprocess.run(cmd, **kwargs)

    if allow_agent_tools:
        with tempfile.TemporaryDirectory(prefix="voxellab-ask-") as scratch:
            return _parse_claude_payload(_invoke(scratch))
    return _parse_claude_payload(_invoke(None))

class _CodexAppServer:
    def __init__(self, timeout: int, env: dict[str, str] | None = None) -> None:
        self.env = overlay_env(env)
        self.timeout = timeout
        self.next_id = 1
        self.proc: subprocess.Popen[str] | None = None
        self.timer: threading.Timer | None = None

    def __enter__(self) -> "_CodexAppServer":
        codex_bin = shutil.which("codex", path=self.env.get("PATH"))
        if codex_bin is None:
            raise RuntimeError("`codex` CLI not found on PATH")
        self.proc = subprocess.Popen(
            [codex_bin, "app-server", "--stdio"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=str(ROOT),
            env=self.env,
        )
        self.timer = threading.Timer(self.timeout, self.proc.kill)
        self.timer.start()
        _ = self.request("initialize", {
            "clientInfo": CODEX_CLIENT_INFO,
            "capabilities": {"optOutNotificationMethods": CODEX_NOTIFICATION_OPTOUTS},
        })
        self.notify("initialized", {})
        return self

    def __exit__(self, *_exc: object) -> None:
        if self.timer is not None:
            self.timer.cancel()
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()
            try:
                _ = self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.kill()

    def send(self, method: str, params: dict[str, Any] | None = None) -> int:
        request_id = self.next_id
        self.next_id += 1
        self.write({"method": method, "id": request_id, "params": params or {}})
        return request_id

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        self.write({"method": method, "params": params or {}})

    def write(self, message: dict[str, Any]) -> None:
        if self.proc is None or self.proc.stdin is None:
            raise RuntimeError("codex app-server stdin is closed")
        _ = self.proc.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
        self.proc.stdin.flush()

    def messages(self) -> Iterator[dict[str, Any]]:
        if self.proc is None or self.proc.stdout is None:
            return
        for raw in self.proc.stdout:
            if not raw.strip():
                continue
            try:
                yield json.loads(raw)
            except json.JSONDecodeError:
                continue

    def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        request_id = self.send(method, params)
        for message in self.messages():
            if message.get("id") != request_id:
                continue
            if message.get("error"):
                raise RuntimeError(str(message["error"].get("message") or message["error"]))
            result = message.get("result")
            return result if isinstance(result, dict) else {}
        raise self.error(f"{method} produced no response")

    def error(self, fallback: str) -> RuntimeError:
        stderr = ""
        if self.proc is not None and self.proc.poll() is not None and self.proc.stderr is not None:
            try:
                stderr = self.proc.stderr.read()
            except Exception:
                stderr = ""
        return RuntimeError(f"codex app-server failed: {_compact_error_text(stderr or fallback)}")

def _codex_account_read(env: dict[str, str] | None = None, timeout: int = 30) -> dict[str, Any]:
    with _CodexAppServer(timeout, env) as app:
        return app.request("account/read", {"refreshToken": False})

def _codex_input(prompt: str, images: list[Path]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    items.extend({"type": "localImage", "path": str(image.resolve()), "detail": "high"} for image in images)
    return items

def _parse_codex_structured_message(text: str) -> dict[str, Any]:
    raw = text.strip()
    if raw.startswith("```"):
        raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"codex returned non-JSON: {exc}\n{raw[:400]}") from exc
    if not isinstance(value, dict):
        raise RuntimeError(f"codex returned non-object JSON: {raw[:400]}")
    return value

def _stream_codex_app_server(
    *,
    prompt: str,
    system: str,
    schema: dict[str, Any],
    model: str | None,
    images: list[Path] | None,
    timeout: int,
) -> Iterator[dict[str, Any]]:
    chosen_model = resolve_model(model, "codex")
    with tempfile.TemporaryDirectory(prefix="voxellab-codex-") as scratch_dir:
        scratch = Path(scratch_dir)
        with _CodexAppServer(timeout) as app:
            thread_params: dict[str, Any] = {
                "approvalPolicy": "never",
                "cwd": str(scratch),
                "developerInstructions": system,
                "ephemeral": True,
                "sandbox": "workspace-write",
                "threadSource": "user",
            }
            if chosen_model:
                thread_params["model"] = chosen_model
            thread = app.request("thread/start", thread_params).get("thread") or {}
            thread_id = thread.get("id")
            if not isinstance(thread_id, str) or not thread_id:
                raise RuntimeError(f"unexpected thread/start response: {thread}")

            turn_params: dict[str, Any] = {
                "approvalPolicy": "never",
                "cwd": str(scratch),
                "input": _codex_input(prompt, list(images or [])),
                "outputSchema": schema,
                "sandboxPolicy": {
                    "type": "workspaceWrite",
                    "networkAccess": False,
                    "writableRoots": [str(scratch)],
                },
                "threadId": thread_id,
            }
            if chosen_model:
                turn_params["model"] = chosen_model
            turn_request_id = app.send("turn/start", turn_params)

            final_text: str | None = None
            composing = False
            output_streamed: set[object] = set()
            for message in app.messages():
                if message.get("id") == turn_request_id:
                    if message.get("error"):
                        raise RuntimeError(str(message["error"].get("message") or message["error"]))
                    continue
                method = message.get("method")
                params = message.get("params") or {}
                if method == "error":
                    raise RuntimeError(str(params.get("message") or "codex app-server error"))
                if not isinstance(params, dict):
                    continue
                if method == "item/commandExecution/outputDelta":
                    output_streamed.add(params.get("itemId"))
                    yield {"type": "codex_event", "method": method, "params": params}
                    continue
                if method == "item/agentMessage/delta":
                    yield {"type": "codex_event", "method": method, "params": params}
                    continue

                item = params.get("item")
                if method == "item/started" and isinstance(item, dict) and item.get("type") == "commandExecution":
                    yield {
                        "type": "tool_use",
                        "id": item.get("id"),
                        "name": "Bash",
                        "input": {"command": item.get("command", "")},
                    }
                elif method == "item/completed" and isinstance(item, dict):
                    if item.get("type") == "commandExecution":
                        output = item.get("aggregatedOutput")
                        if output and item.get("id") not in output_streamed:
                            yield {
                                "type": "codex_event",
                                "method": "item/commandExecution/outputDelta",
                                "params": {"itemId": item.get("id"), "delta": str(output)},
                            }
                        yield {
                            "type": "tool_result",
                            "id": item.get("id"),
                            "is_error": item.get("status") == "failed" or item.get("exitCode") not in (0, None),
                        }
                    elif item.get("type") == "agentMessage":
                        final_text = str(item.get("text") or "")
                        if not composing:
                            composing = True
                            yield {"type": "composing"}
                elif method == "turn/completed":
                    turn = params.get("turn")
                    status = turn.get("status") if isinstance(turn, dict) else None
                    if status not in (None, "completed"):
                        error = turn.get("error") if isinstance(turn, dict) else None
                        raise RuntimeError(str(error or f"codex turn ended with status {status}"))
                    if not final_text:
                        raise RuntimeError("codex app-server produced no final agent message")
                    yield {"type": "result", "output": _parse_codex_structured_message(final_text)}
                    return
            raise app.error("turn completed without a result")

def _run_codex(prompt: str, system: str, schema: dict[str, Any], model: str, images: list[Path], timeout: int) -> dict[str, Any]:
    for event in _stream_codex_app_server(
        prompt=prompt,
        system=system,
        schema=schema,
        model=model,
        images=images,
        timeout=timeout,
    ):
        if event.get("type") == "result":
            output = event.get("output")
            if isinstance(output, dict):
                return output
    raise RuntimeError("codex app-server produced no structured output")

def stream_structured(
    *,
    prompt: str,
    system: str,
    schema: dict[str, Any],
    model: str | None = None,
    images: list[Path] | None = None,
    timeout: int = 360,
    add_dirs: list[Path] | None = None,
    provider: str | None = None,
    allow_agent_tools: bool = False,
) -> Iterator[dict[str, Any]]:

    chosen = configured_provider(provider)
    _ = require_provider_ready(chosen)
    if chosen == "codex":
        yield from _stream_codex_app_server(
            prompt=prompt,
            system=system,
            schema=schema,
            model=model,
            images=images,
            timeout=timeout,
        )
        return
    chosen_model = resolve_model(model, "claude")
    cmd = [
        "claude",
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--allowedTools",
        "Read,Bash" if (allow_agent_tools and _claude_agent_bash_enabled()) else "Read",
        "--append-system-prompt",
        system,
        "--json-schema",
        json.dumps(schema),
        "--no-session-persistence",
    ]
    if chosen_model:
        cmd[2:2] = ["--model", chosen_model]
    for directory in add_dirs or []:
        cmd += ["--add-dir", str(Path(directory).resolve())]
    text = _claude_prompt(prompt, list(images or []))

    with tempfile.TemporaryDirectory(prefix="voxellab-ask-") as scratch:
        proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, cwd=scratch, env=overlay_env(),
        )
        watchdog = threading.Timer(timeout, proc.kill)
        watchdog.start()
        final: dict[str, Any] | None = None
        try:
            if proc.stdin:
                _ = proc.stdin.write(text)
                proc.stdin.close()
            for raw in proc.stdout or []:
                line = raw.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                etype = event.get("type")
                if etype == "assistant":
                    for block in (event.get("message", {}) or {}).get("content") or []:
                        if isinstance(block, dict) and block.get("type") == "tool_use":
                            yield {"type": "tool_use", "id": block.get("id"), "name": block.get("name", ""), "input": block.get("input") or {}}
                elif etype == "user":
                    for block in (event.get("message", {}) or {}).get("content") or []:
                        if isinstance(block, dict) and block.get("type") == "tool_result":
                            yield {"type": "tool_result", "id": block.get("tool_use_id"), "is_error": bool(block.get("is_error"))}
                elif etype == "result":
                    final = event.get("structured_output")
        finally:
            watchdog.cancel()
            stderr = (proc.stderr.read() if proc.stderr else "") or ""
            _ = proc.wait()
        if final is None:
            raise RuntimeError(f"claude stream produced no structured_output{(': ' + _compact_error_text(stderr)) if stderr.strip() else ''}")
        yield {"type": "result", "output": final}

def run_structured(
    *,
    prompt: str,
    system: str,
    schema: dict[str, Any],
    model: str | None = None,
    provider: str | None = None,
    images: list[Path] | None = None,
    timeout: int = 240,
    allow_agent_tools: bool = False,
    add_dirs: list[Path] | None = None,
) -> dict[str, Any]:
    chosen_provider = configured_provider(provider)
    chosen_model = resolve_model(model, chosen_provider)
    _ = require_provider_ready(chosen_provider)
    image_paths = list(images or [])
    if chosen_provider == "claude":
        return _run_claude(
            prompt, system, schema, chosen_model, image_paths, timeout,
            allow_agent_tools=allow_agent_tools, add_dirs=add_dirs,
        )
    return _run_codex(prompt, system, schema, chosen_model, image_paths, timeout)
