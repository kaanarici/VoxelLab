from __future__ import annotations

from pathlib import Path
from urllib.parse import urlparse


CLOUD_KEYS = (
    "MODAL_WEBHOOK_BASE",
    "MODAL_AUTH_TOKEN",
    "R2_PUBLIC_URL",
    "TRUSTED_UPLOAD_ORIGINS",
    "VIEWER_CLOUD_PROCESSING",
)


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


def write_cloud_settings(root: Path, body: dict, previous_env: dict[str, str]) -> dict:
    env_path = root / ".env"
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
    _ = env_path.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
    try:
        env_path.chmod(0o600)
    except Exception:
        pass
    return cloud_settings_payload(root, {**previous_env, **values})
