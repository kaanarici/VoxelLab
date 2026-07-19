from __future__ import annotations

import os
import threading
from pathlib import Path
from urllib.parse import urlparse


CLOUD_KEYS = (
    "MODAL_WEBHOOK_BASE",
    "MODAL_AUTH_TOKEN",
    "R2_PUBLIC_URL",
    "TRUSTED_UPLOAD_ORIGINS",
    "VIEWER_CLOUD_PROCESSING",
)
_CLOUD_SETTINGS_WRITE_LOCK = threading.Lock()


def _clean(value, limit: int = 2048) -> str:
    return str(value or "").strip()[:limit]


def _origins(value) -> list[str]:
    raw = value if isinstance(value, list) else str(value or "").split(",")
    out: list[str] = []
    for item in raw:
        text = _clean(item)
        if not text:
            continue
        try:
            parsed = urlparse(text)
        except Exception:
            continue
        if parsed.scheme == "https" and parsed.netloc:
            origin = f"{parsed.scheme}://{parsed.netloc}"
            if origin not in out:
                out.append(origin)
    return out


def _valid_modal_base(value: str) -> bool:
    raw = _clean(value).rstrip("/")
    if not raw:
        return False
    try:
        parsed = urlparse(raw if raw.startswith("http") else f"https://{raw}")
    except Exception:
        return False
    return bool(parsed.hostname)


def _env_value(value: str) -> str:
    if not value:
        return ""
    if any(ch.isspace() or ch in {'"', "'", "#"} for ch in value):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return value


def cloud_settings_payload(root: Path, env: dict[str, str]) -> dict:
    modal_base = _clean(env.get("MODAL_WEBHOOK_BASE"))
    auth_token = _clean(env.get("MODAL_AUTH_TOKEN"), 8192)
    r2_public = _clean(env.get("R2_PUBLIC_URL"))
    origins = _origins(env.get("TRUSTED_UPLOAD_ORIGINS"))
    cloud_processing = _clean(env.get("VIEWER_CLOUD_PROCESSING")).lower()
    enabled = False if cloud_processing in {"0", "false", "no", "off"} else True
    return {
        "source": "local-env",
        "storagePath": str(root / ".env"),
        "modalWebhookBase": modal_base,
        "r2PublicUrl": r2_public,
        "trustedUploadOrigins": origins,
        "cloudProcessing": enabled,
        "hasModalAuthToken": bool(auth_token),
        "configured": bool(_valid_modal_base(modal_base) and auth_token and (r2_public or origins)),
    }


def normalize_cloud_settings(body: dict, previous_env: dict[str, str]) -> dict[str, str]:
    trusted_origins = _origins(body.get("trustedUploadOrigins"))
    token = _clean(body.get("modalAuthToken"), 8192)
    clear_token = bool(body.get("clearModalAuthToken"))
    previous_token = _clean(previous_env.get("MODAL_AUTH_TOKEN"), 8192)
    return {
        "MODAL_WEBHOOK_BASE": _clean(body.get("modalWebhookBase")),
        "MODAL_AUTH_TOKEN": "" if clear_token else token or previous_token,
        "R2_PUBLIC_URL": _clean(body.get("r2PublicUrl")),
        "TRUSTED_UPLOAD_ORIGINS": ",".join(trusted_origins),
        "VIEWER_CLOUD_PROCESSING": "1" if body.get("cloudProcessing", True) is not False else "0",
    }


def _write_cloud_settings_unlocked(root: Path, body: dict, previous_env: dict[str, str]) -> dict:
    env_path = root / ".env"
    temp_path = root / ".env.voxellab.tmp"
    values = normalize_cloud_settings(body, previous_env)
    lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
    written: set[str] = set()
    out: list[str] = []
    for line in lines:
        stripped = line.strip()
        key = stripped.split("=", 1)[0].strip() if "=" in stripped and not stripped.startswith("#") else ""
        if key in values:
            out.append(f"{key}={_env_value(values[key])}")
            written.add(key)
        else:
            out.append(line)
    for key in CLOUD_KEYS:
        if key in written:
            continue
        out.append(f"{key}={_env_value(values.get(key, ''))}")
    content = "\n".join(out).rstrip() + "\n"

    # Keep the replacement on the same filesystem so an interruption can leave
    # either the old complete .env or the new complete .env, never a partial one.
    descriptor = os.open(temp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        os.fchmod(handle.fileno(), 0o600)
        _ = handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp_path, env_path)
    try:
        directory_descriptor = os.open(root, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    except OSError:
        # Some platforms do not support fsync on a directory. The replacement
        # remains atomic even when that extra durability barrier is unavailable.
        pass
    return cloud_settings_payload(root, {**previous_env, **values})


def write_cloud_settings(root: Path, body: dict, previous_env: dict[str, str]) -> dict:
    with _CLOUD_SETTINGS_WRITE_LOCK:
        return _write_cloud_settings_unlocked(root, body, previous_env)
