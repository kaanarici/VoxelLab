"""Provider-neutral AI runtime for VoxelLab local tooling."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import threading
from collections.abc import Iterator
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
    """Whether the Claude Ask agent may use the `Bash` tool.

    The Claude CLI has no per-invocation network/filesystem sandbox flag, unlike
    the Codex app-server path (which runs with networkAccess disabled and
    scratch-only writable roots). Granting `Bash` there means an unsandboxed
    shell with full network access, driven by an LLM reading untrusted imaging
    metadata — a prompt-injection-to-command-execution surface. Default to
    Read-only and require an explicit opt-in to restore shell access.
    """
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


def _compact_error_text(text: str, limit: int = 240) -> str:
    one_line = " ".join(text.split())
    return one_line[:limit] + ("..." if len(one_line) > limit else "")


def _run_status(cmd: list[str], timeout: int = 30, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=overlay_env(env))


def claude_status(env: dict[str, str] | None = None) -> dict[str, Any]:
    env_map = overlay_env(env)
    if shutil.which("claude", path=env_map.get("PATH")) is None:
        return {
            "provider": "claude",
            "ready": False,
            "issues": ["`claude` CLI not found on PATH"],
            "auth_mode": None,
            "status_source": "missing_cli",
        }
    try:
        result = _run_status(["claude", "auth", "status"], env=env_map)
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


def codex_status(env: dict[str, str] | None = None) -> dict[str, Any]:
    env_map = overlay_env(env)
    if shutil.which("codex", path=env_map.get("PATH")) is None:
        return {
            "provider": "codex",
            "ready": False,
            "issues": ["`codex` CLI not found on PATH"],
            "auth_mode": None,
            "status_source": "missing_cli",
        }
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
    """Yield provider events, ending with {"type": "result", "output": ...}."""
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
