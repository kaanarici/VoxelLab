from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from r2_config import normalize_r2_bucket, normalize_r2_endpoint


DEFAULT_MAX_R2_UPLOAD_FILES = 10_000
DEFAULT_MAX_R2_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
DEFAULT_MAX_RAW_VOLUME_BYTES = 4 * 1024 * 1024 * 1024


def _bounded_env_int(name: str, default: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, "") or default)
    except ValueError:
        value = default
    return max(1, min(value, maximum))


def get_r2_client(env: dict[str, str] | None = None):
    import boto3
    from botocore.config import Config

    values = os.environ if env is None else env
    endpoint = normalize_r2_endpoint(values.get("R2_ENDPOINT"))
    access_key = str(values.get("R2_ACCESS_KEY_ID") or "").strip()
    secret_key = str(values.get("R2_SECRET_ACCESS_KEY") or "").strip()
    if not endpoint:
        raise ValueError("R2_ENDPOINT must be a valid Cloudflare R2 S3 endpoint")
    for name in ("R2_UPLOAD_BUCKET", "R2_RESULTS_BUCKET"):
        if values.get(name) and not normalize_r2_bucket(values.get(name)):
            raise ValueError(f"{name} must be a valid Cloudflare R2 bucket name")
    if not access_key or not secret_key:
        raise ValueError("R2 S3 client credentials are not configured")
    try:
        workers = int(values.get("MRI_VIEWER_R2_TRANSFER_WORKERS") or 4)
    except (TypeError, ValueError):
        workers = 4
    workers = max(1, min(workers, 16))

    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            retries={"mode": "standard", "max_attempts": 4},
            max_pool_connections=workers,
            connect_timeout=10,
            read_timeout=120,
        ),
    )


def r2_transfer_config():
    from boto3.s3.transfer import TransferConfig

    return TransferConfig(
        multipart_threshold=64 * 1024 * 1024,
        multipart_chunksize=16 * 1024 * 1024,
        use_threads=False,
    )


def iter_r2_objects(s3, bucket: str, prefix: str):
    token = None
    while True:
        kwargs = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        resp = s3.list_objects_v2(**kwargs)
        for obj in resp.get("Contents", []):
            key = obj.get("Key")
            if key:
                yield obj
        token = resp.get("NextContinuationToken")
        if not resp.get("IsTruncated") and not token:
            break
        if not token:
            raise RuntimeError("R2 listing was truncated without a continuation token")


def iter_r2_object_keys(s3, bucket: str, prefix: str):
    for obj in iter_r2_objects(s3, bucket, prefix):
        yield obj["Key"]


def download_r2_objects(
    s3,
    bucket: str,
    prefix: str,
    out_dir: Path,
    max_workers: int,
    max_files: int | None = None,
    max_total_bytes: int | None = None,
) -> int:
    max_files = (
        _bounded_env_int("MRI_VIEWER_MODAL_MAX_UPLOAD_FILES", DEFAULT_MAX_R2_UPLOAD_FILES, 100_000)
        if max_files is None
        else int(max_files)
    )
    max_total_bytes = (
        _bounded_env_int(
            "MRI_VIEWER_MODAL_MAX_UPLOAD_BYTES",
            DEFAULT_MAX_R2_UPLOAD_BYTES,
            5 * 1024 * 1024 * 1024 * 1024,
        )
        if max_total_bytes is None
        else int(max_total_bytes)
    )
    if max_files < 1 or max_files > 100_000:
        raise ValueError("R2 file limit must be between 1 and 100000")
    if max_total_bytes < 1 or max_total_bytes > 5 * 1024 * 1024 * 1024 * 1024:
        raise ValueError("R2 byte limit is outside the supported range")

    listed = []
    total_bytes = 0
    for obj in iter_r2_objects(s3, bucket, prefix):
        if len(listed) >= max_files:
            raise ValueError(f"R2 upload prefix exceeds file limit ({max_files})")
        try:
            size = int(obj["Size"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("R2 listing omitted a valid object size") from None
        if size < 0:
            raise ValueError("R2 listing returned a negative object size")
        total_bytes += size
        if total_bytes > max_total_bytes:
            raise ValueError(f"R2 upload prefix exceeds byte limit ({max_total_bytes})")
        listed.append(obj)
    objects = [
        obj for obj in listed
        if obj["Key"].rsplit("/", 1)[-1] and not obj["Key"].rsplit("/", 1)[-1].startswith(".")
    ]
    if not objects:
        return 0

    names = [obj["Key"].rsplit("/", 1)[-1] for obj in objects]
    if len(names) != len(set(names)):
        raise ValueError("R2 upload prefix contains duplicate leaf filenames")

    def download_one(obj: dict) -> None:
        key = obj["Key"]
        destination = out_dir / key.rsplit("/", 1)[-1]
        partial = destination.with_name(f".{destination.name}.part")
        etag = str(obj.get("ETag") or "").strip()
        if not etag:
            raise ValueError(f"R2 listing omitted an ETag: {key}")
        partial.unlink(missing_ok=True)
        response = None
        try:
            response = s3.get_object(Bucket=bucket, Key=key, IfMatch=etag)
            declared_size = int(response.get("ContentLength", obj["Size"]))
            if declared_size != int(obj["Size"]):
                raise IOError(f"R2 object changed size after listing: {key}")
            written = 0
            with partial.open("xb") as handle:
                while True:
                    chunk = response["Body"].read(1024 * 1024)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > int(obj["Size"]):
                        raise IOError(f"downloaded R2 object exceeds listed size: {key}")
                    _ = handle.write(chunk)
            if written != int(obj["Size"]):
                raise IOError(f"downloaded R2 object size mismatch: {key}")
            os.replace(partial, destination)
        finally:
            body = (response or {}).get("Body")
            if body is not None and hasattr(body, "close"):
                body.close()
            partial.unlink(missing_ok=True)

    with ThreadPoolExecutor(max_workers=max(1, max_workers)) as pool:
        futures = [pool.submit(download_one, obj) for obj in objects]
        for future in as_completed(futures):
            future.result()
    return len(objects)


def upload_r2_files(s3, bucket: str, uploads: list[tuple[Path, str, str]], max_workers: int) -> None:
    if not uploads:
        return

    transfer_config = r2_transfer_config()

    def upload_one(item: tuple[Path, str, str]) -> None:
        path, key, content_type = item
        s3.upload_file(
            str(path),
            bucket,
            key,
            ExtraArgs={
                "ContentType": content_type,
                "CacheControl": "public, max-age=31536000, immutable",
            },
            Config=transfer_config,
        )

    with ThreadPoolExecutor(max_workers=max(1, max_workers)) as pool:
        futures = [pool.submit(upload_one, item) for item in uploads]
        for future in as_completed(futures):
            future.result()


def compress_raw_volume(raw_path: Path, zst_path: Path, max_input_bytes: int | None = None) -> None:
    limit = max_input_bytes or _bounded_env_int(
        "MRI_VIEWER_MODAL_MAX_RAW_BYTES",
        DEFAULT_MAX_RAW_VOLUME_BYTES,
        5 * 1024 * 1024 * 1024 * 1024,
    )
    input_bytes = raw_path.stat().st_size
    if input_bytes > limit:
        raise ValueError(f"raw volume exceeds compression limit ({limit} bytes)")
    import zstandard

    partial = zst_path.with_name(f".{zst_path.name}.part")
    partial.unlink(missing_ok=True)
    try:
        compressor = zstandard.ZstdCompressor(level=19, threads=0)
        with raw_path.open("rb") as source, partial.open("xb") as destination:
            _ = compressor.copy_stream(
                source,
                destination,
                read_size=1024 * 1024,
                write_size=1024 * 1024,
            )
        os.replace(partial, zst_path)
    finally:
        partial.unlink(missing_ok=True)
