"""
Upload data_compressed/*.raw.zst to a Cloudflare R2 bucket via the
S3-compatible API. Reads credentials from .env (same directory).

Why boto3: Cloudflare R2 is S3-compatible, and boto3 handles multipart
uploads, retries, and checksumming for us. We only use the tiny subset
(head_object, put_object, delete_object, list_objects_v2) so the runtime
overhead is minimal.

Idempotent: uploads use content-addressed object keys so immutable caching
stays safe across re-processing, and skips any object that's already present
with matching bytes. Use --force to re-upload everything regardless.

Usage:
  python3 upload_to_r2.py                 # upload all compressed volumes
  python3 upload_to_r2.py flair            # upload just this slug
  python3 upload_to_r2.py --force         # re-upload everything
  python3 upload_to_r2.py --dry-run       # show what would happen
"""

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from urllib.parse import quote

from json_store import update_json
from modal_io import get_r2_client, r2_transfer_config
from r2_config import normalize_public_r2_url

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data_compressed"
ENV_PATH = ROOT / ".env"


def load_env(path: Path) -> dict[str, str]:
    """Tiny .env parser — we avoid pulling in python-dotenv to keep the
    script dependency-free beyond boto3.
    """
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, _, v = line.partition("=")
        v = v.strip().strip('"').strip("'")
        env[k.strip()] = v
    return env


def md5_of(path: Path) -> str:
    """R2 returns ETag = md5 hex for single-part uploads. Use this to
    detect whether the local file already matches what's in the bucket.
    """
    h = hashlib.md5()  # noqa: S324  — ETag is MD5, not a security check
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def compressed_path_for_entry(out_dir: Path, entry: dict) -> Path:
    relative = Path(str(entry.get("compressed", "") or ""))
    if not relative.name or relative.is_absolute() or ".." in relative.parts:
        raise ValueError("compressed path must stay inside data_compressed")
    resolved = (out_dir / relative).resolve()
    if not resolved.is_relative_to(out_dir.resolve()):
        raise ValueError("compressed path must stay inside data_compressed")
    return resolved


def object_key_for_entry(entry: dict) -> str:
    source = Path(str(entry.get("source", "") or "volume.raw"))
    suffix = "".join(Path(str(entry.get("compressed", "") or source.name)).suffixes) or ".raw.zst"
    digest = str(entry.get("sha256_zst", "") or "").lower()[:16]
    stem = source.stem or source.name
    return f"{stem}-{digest}{suffix}" if digest else (str(entry.get("compressed", "") or source.name))


def public_object_url(public_url: str, object_key: str) -> str:
    return f"{public_url.rstrip('/')}/{quote(object_key, safe='/')}"


def patch_manifest_urls(
    manifest: dict,
    index: dict,
    public_url: str,
    available_keys: set[str],
) -> tuple[dict, int]:
    patched = 0
    by_slug = {
        series.get("slug"): series
        for series in manifest.get("series", [])
        if isinstance(series, dict) and series.get("slug")
    }
    for key, entry in index.items():
        obj_key = object_key_for_entry(entry)
        if obj_key not in available_keys:
            continue
        if key.endswith("_mask"):
            slug = key[:-5]
            field = "maskUrl"
        else:
            slug = key
            field = "rawUrl"
        if slug in by_slug:
            by_slug[slug][field] = public_object_url(public_url, obj_key)
            patched += 1
    return manifest, patched


def main() -> bool:
    ap = argparse.ArgumentParser(description="Upload data_compressed/*.raw.zst to Cloudflare R2.")
    _ = ap.add_argument(
        "slugs",
        nargs="*",
        metavar="SLUG",
        help="Series / index keys to upload (default: all in index.json)",
    )
    _ = ap.add_argument("--force", action="store_true", help="re-upload even if remote matches")
    _ = ap.add_argument("--dry-run", action="store_true", help="print actions only")
    args = ap.parse_args()
    force = args.force
    dry_run = args.dry_run
    wanted = set(args.slugs)

    env = load_env(ENV_PATH)
    # .env wins unless the user has already exported the vars in their shell.
    for k in ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_RESULTS_BUCKET"):
        if not os.environ.get(k) and env.get(k):
            os.environ[k] = env[k]

    endpoint = os.environ.get("R2_ENDPOINT")
    access_key = os.environ.get("R2_ACCESS_KEY_ID")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY")
    bucket = os.environ.get("R2_RESULTS_BUCKET")
    if not (endpoint and access_key and secret_key and bucket):
        print("ERROR: R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_RESULTS_BUCKET", file=sys.stderr)
        print("       must be set (e.g. via .env). Copy .env.example and fill in.", file=sys.stderr)
        return False

    try:
        from botocore.exceptions import ClientError  # type: ignore
    except ImportError:
        print("ERROR: boto3 not installed. Run: pip install boto3", file=sys.stderr)
        return False

    index_path = OUT / "index.json"
    if not index_path.exists():
        print(f"ERROR: {index_path} missing. Run compress_volumes.py first.", file=sys.stderr)
        return False
    index = json.loads(index_path.read_text())

    client = None
    if not dry_run:
        try:
            client = get_r2_client(dict(os.environ))
            client.head_bucket(Bucket=bucket)
        except (ClientError, ValueError) as e:
            code = getattr(e, "response", {}).get("Error", {}).get("Code", "")
            if code == "404" or "NoSuch" in code:
                print(f"ERROR: bucket '{bucket}' does not exist. Create it in the", file=sys.stderr)
                print("       Cloudflare R2 dashboard first, then re-run.", file=sys.stderr)
            else:
                print(f"ERROR: R2 preflight failed: {e}", file=sys.stderr)
            return False

    public_url = normalize_public_r2_url(env.get("R2_PUBLIC_URL") or os.environ.get("R2_PUBLIC_URL"))
    if not public_url:
        print("WARN: R2_PUBLIC_URL not set — will upload, but won't patch", file=sys.stderr)
        print("      manifest.json with rawUrl fields. Fill R2_PUBLIC_URL in .env", file=sys.stderr)
        print("      and re-run to patch.", file=sys.stderr)

    uploaded = 0
    skipped = 0
    ok = True
    available_keys: set[str] = set()
    for key, entry in sorted(index.items()):
        if wanted and key not in wanted and entry["source"].split(".")[0] not in wanted:
            continue
        try:
            local = compressed_path_for_entry(OUT, entry)
        except ValueError as exc:
            print(f"ERROR: {key}: {exc}", file=sys.stderr)
            ok = False
            continue
        if not local.exists():
            print(f"ERROR: {key}: {local.name} missing locally", file=sys.stderr)
            ok = False
            continue

        # The object key in the bucket is just the compressed file name at
        # the top level — no prefix. Keeps URLs short:
        #   https://<public>/<slug>.raw.zst
        obj_key = object_key_for_entry(entry)
        local_sha256 = sha256_of(local)
        expected_sha256 = str(entry.get("sha256_zst", "") or "").lower()
        if expected_sha256 and expected_sha256 != local_sha256:
            print(f"ERROR: {key}: compressed SHA-256 does not match index.json", file=sys.stderr)
            ok = False
            continue

        if dry_run:
            print(f"  [dry] would upload {obj_key} ({local.stat().st_size / 1024 / 1024:.1f} MB)")
            continue

        if not force:
            try:
                head = client.head_object(Bucket=bucket, Key=obj_key)
                remote_size = int(head.get("ContentLength", 0))
                remote_etag = (head.get("ETag") or "").strip('"')
                remote_sha256 = str((head.get("Metadata") or {}).get("sha256") or "").lower()
                content_matches = remote_sha256 == local_sha256
                if not remote_sha256 and "-" not in remote_etag:
                    content_matches = remote_etag == md5_of(local)
                if remote_size == local.stat().st_size and content_matches:
                    print(f"  [skip] {obj_key} already up to date")
                    skipped += 1
                    available_keys.add(obj_key)
                    continue
            except ClientError as e:
                if e.response.get("Error", {}).get("Code") not in ("404", "NoSuchKey"):
                    print(f"ERROR: head_object {obj_key}: {e}", file=sys.stderr)
                    ok = False
                    continue

        print(f"  [up]  {obj_key} ({local.stat().st_size / 1024 / 1024:.1f} MB) ...", end="", flush=True)
        client.upload_file(
            str(local),
            bucket,
            obj_key,
            ExtraArgs={
                "ContentType": "application/zstd",
                "CacheControl": "public, max-age=31536000, immutable",
                "Metadata": {"sha256": local_sha256},
            },
            Config=r2_transfer_config(),
        )
        uploaded_head = client.head_object(Bucket=bucket, Key=obj_key)
        uploaded_size = int(uploaded_head.get("ContentLength", -1))
        uploaded_sha256 = str((uploaded_head.get("Metadata") or {}).get("sha256") or "").lower()
        if uploaded_size != local.stat().st_size or uploaded_sha256 != local_sha256:
            print(" failed")
            print(f"ERROR: uploaded metadata verification failed for {obj_key}", file=sys.stderr)
            ok = False
            continue
        print(" ok")
        uploaded += 1
        available_keys.add(obj_key)

    print(f"\ndone. uploaded={uploaded} skipped={skipped}")

    # Patch data/manifest.json with rawUrl fields so the hosted viewer
    # knows where to fetch each series' compressed volume. We only write
    # URLs for objects that actually exist in the index (i.e. were
    # compressed and uploaded). Mask volumes (_mask.raw) are published
    # under a parallel maskUrl key.
    if public_url and not dry_run:
        manifest_path = ROOT / "data" / "manifest.json"
        if manifest_path.exists():
            patched = 0

            def patch_urls(manifest: dict) -> dict:
                nonlocal patched
                manifest, patched = patch_manifest_urls(manifest, index, public_url, available_keys)
                return manifest

            _ = update_json(manifest_path, patch_urls)
            print(f"patched {patched} url fields in {manifest_path}")
    return ok


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
