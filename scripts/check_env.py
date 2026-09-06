#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import sys
from typing import Protocol, cast

ROOT = Path(__file__).resolve().parents[1]
PYTHON_ROOT = ROOT / "python"
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))

from modal_contract import modal_endpoint
from modal_io import get_r2_client
from r2_config import normalize_public_r2_url, normalize_r2_bucket, normalize_r2_endpoint

class R2HeadClient(Protocol):
    def head_bucket(self, *, Bucket: str) -> object: ...

R2_REQUIRED = (
    "R2_ENDPOINT",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_UPLOAD_BUCKET",
    "R2_RESULTS_BUCKET",
)
CLOUD_REQUIRED = (
    "R2_PUBLIC_URL",
    "MODAL_WEBHOOK_BASE",
    "MODAL_AUTH_TOKEN",
)

def load_dotenv(path: str = ".env") -> dict[str, str]:

    env: dict[str, str] = {}
    if not os.path.exists(path):
        return env
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip('"').strip("'")
    return env

def merged_env() -> dict[str, str]:

    env = dict(os.environ)
    for key, value in load_dotenv().items():
        _ = env.setdefault(key, value)
    return env

def find_executable(name: str) -> str | None:

    found = shutil.which(name)
    if found:
        return found
    for directory in (Path(sys.executable).parent, Path.cwd() / ".venv" / "bin", Path.cwd() / ".venv" / "Scripts"):
        candidate = directory / (f"{name}.exe" if os.name == "nt" else name)
        if candidate.exists():
            return str(candidate)
    return None

def check_cloud(dry_run: bool, r2_only: bool = False) -> list[str]:
    env = merged_env()
    errors: list[str] = []
    for key in (*R2_REQUIRED, *(() if r2_only else CLOUD_REQUIRED)):
        if not env.get(key):
            errors.append(f"missing {key}")
    if env.get("R2_ENDPOINT") and not normalize_r2_endpoint(env["R2_ENDPOINT"]):
        errors.append("R2_ENDPOINT must be an HTTPS Cloudflare R2 S3 endpoint")
    for name in ("R2_UPLOAD_BUCKET", "R2_RESULTS_BUCKET"):
        if env.get(name) and not normalize_r2_bucket(env[name]):
            errors.append(f"{name} is not a valid Cloudflare R2 bucket name")
    if (
        env.get("R2_UPLOAD_BUCKET")
        and env.get("R2_RESULTS_BUCKET")
        and env["R2_UPLOAD_BUCKET"] == env["R2_RESULTS_BUCKET"]
    ):
        errors.append("R2_UPLOAD_BUCKET must be private and different from R2_RESULTS_BUCKET")
    if env.get("R2_PUBLIC_URL") and not normalize_public_r2_url(env["R2_PUBLIC_URL"]):
        errors.append("R2_PUBLIC_URL must be an HTTPS public bucket URL without credentials or query parameters")
    if env.get("MODAL_WEBHOOK_BASE"):
        try:
            _ = modal_endpoint(env["MODAL_WEBHOOK_BASE"], "check_status")
        except Exception:
            errors.append("MODAL_WEBHOOK_BASE is invalid")
    if not r2_only and find_executable("modal") is None:
        errors.append("missing executable: modal")
    if errors or dry_run:
        return errors
    try:
        client = cast(R2HeadClient, get_r2_client(env))
        _ = client.head_bucket(Bucket=env["R2_UPLOAD_BUCKET"])
        _ = client.head_bucket(Bucket=env["R2_RESULTS_BUCKET"])
    except Exception as exc:
        errors.append(f"R2 read-only connectivity failed: {type(exc).__name__}: {exc}")
    return errors

def main() -> int:
    parser = argparse.ArgumentParser()
    _ = parser.add_argument("--mode", choices=["cloud"], default="cloud")
    _ = parser.add_argument("--dry-run", action="store_true")
    _ = parser.add_argument("--r2-only", action="store_true")
    args = parser.parse_args()

    errors = check_cloud(dry_run=args.dry_run, r2_only=args.r2_only)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print("cloud env preflight ok")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
