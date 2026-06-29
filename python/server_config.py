from __future__ import annotations

import json
from pathlib import Path
from typing import Callable


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"


def env_bool(value: str | None) -> bool | None:
    if value is None or value == "":
        return None
    return value.strip().lower() in {"1", "true", "yes", "on"}


def env_list(value: str | None) -> list[str] | None:
    if value is None or value == "":
        return None
    return [item.strip() for item in value.split(",") if item.strip()]


def runtime_config(
    root: Path,
    overlay_env: Callable[[], dict[str, str]],
    public_ai_status: Callable[..., dict],
    modal_proxy_available: Callable[[], bool],
) -> dict:
    try:
        config = json.loads((root / "config.json").read_text(encoding="utf-8"))
    except Exception:
        config = {}
    env = overlay_env()
    for env_key, config_key in (
        ("R2_PUBLIC_URL", "r2PublicUrl"),
        ("SITE_NAME", "siteName"),
        ("VIEWER_DISCLAIMER", "disclaimer"),
    ):
        if env.get(env_key):
            config[config_key] = env[env_key]
    trusted_upload_origins = env_list(env.get("TRUSTED_UPLOAD_ORIGINS"))
    if trusted_upload_origins is not None:
        config["trustedUploadOrigins"] = trusted_upload_origins
    features = dict(config.get("features") or {})
    for env_key, feature_key in (
        ("VIEWER_CLOUD_PROCESSING", "cloudProcessing"),
        ("VIEWER_AI_ANALYSIS", "aiAnalysis"),
    ):
        parsed = env_bool(env.get(env_key))
        if parsed is not None:
            features[feature_key] = parsed
    if features:
        config["features"] = features
    cloud_enabled = features.get("cloudProcessing") is not False
    if modal_proxy_available():
        config["modalWebhookBase"] = "/api/cloud" if cloud_enabled else ""
    elif not cloud_enabled:
        config["modalWebhookBase"] = ""
    config["ai"] = public_ai_status(bool(features.get("aiAnalysis", True)), env=env)
    config["localAiAvailable"] = bool(config["ai"].get("ready"))
    return config
