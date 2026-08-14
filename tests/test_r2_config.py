from __future__ import annotations

from r2_config import (
    normalize_public_r2_url,
    normalize_r2_bucket,
    normalize_r2_endpoint,
    upload_origins,
    validate_r2_bucket_pair,
)
from scripts import check_env


def test_r2_config_accepts_current_default_and_jurisdictional_endpoints() -> None:
    account = "0123456789abcdef0123456789abcdef"

    assert normalize_r2_endpoint(f"https://{account}.r2.cloudflarestorage.com/") == (
        f"https://{account}.r2.cloudflarestorage.com"
    )
    assert normalize_r2_endpoint(f"https://{account}.eu.r2.cloudflarestorage.com") == (
        f"https://{account}.eu.r2.cloudflarestorage.com"
    )
    assert normalize_r2_endpoint(f"https://{account}.fedramp.r2.cloudflarestorage.com") == (
        f"https://{account}.fedramp.r2.cloudflarestorage.com"
    )


def test_r2_config_rejects_credentials_non_cloudflare_hosts_and_endpoint_paths() -> None:
    assert normalize_r2_endpoint("http://account.r2.cloudflarestorage.com") == ""
    assert normalize_r2_endpoint("https://key:secret@account.r2.cloudflarestorage.com") == ""
    assert normalize_r2_endpoint("https://r2.example.com") == ""
    assert normalize_r2_endpoint("https://account.r2.cloudflarestorage.com/bucket") == ""
    assert normalize_r2_bucket("scan-data") == "scan-data"
    assert normalize_r2_bucket("Scan_Data") == ""


def test_r2_upload_origins_derive_s3_origin_without_trusting_public_read_domain() -> None:
    endpoint = "https://account.r2.cloudflarestorage.com"

    assert upload_origins(endpoint, ["https://upload-proxy.example/path"]) == [
        endpoint,
        "https://upload-proxy.example",
    ]
    assert normalize_public_r2_url("https://volumes.example/assets/") == "https://volumes.example/assets"
    assert normalize_public_r2_url("https://user:secret@volumes.example") == ""
    assert normalize_public_r2_url(endpoint) == ""


def test_r2_upload_and_public_result_buckets_must_be_distinct() -> None:
    assert validate_r2_bucket_pair("scan-inputs", "scan-results") == ("scan-inputs", "scan-results")
    for upload, results in (("scan-data", "scan-data"), ("", "scan-results"), ("Scan", "scan-results")):
        try:
            _ = validate_r2_bucket_pair(upload, results)
        except ValueError:
            pass
        else:
            raise AssertionError("expected invalid R2 bucket pair rejection")


def test_r2_only_preflight_checks_both_distinct_buckets_without_modal(monkeypatch) -> None:
    env = {
        "R2_ENDPOINT": "https://account.r2.cloudflarestorage.com",
        "R2_ACCESS_KEY_ID": "access",
        "R2_SECRET_ACCESS_KEY": "secret",
        "R2_UPLOAD_BUCKET": "scan-inputs",
        "R2_RESULTS_BUCKET": "scan-results",
    }
    checked = []

    class Client:
        def head_bucket(self, *, Bucket):
            checked.append(Bucket)

    monkeypatch.setattr(check_env, "merged_env", lambda: env)
    monkeypatch.setattr(check_env, "get_r2_client", lambda _env: Client())

    assert check_env.check_cloud(dry_run=False, r2_only=True) == []
    assert checked == ["scan-inputs", "scan-results"]


def test_r2_preflight_rejects_shared_bucket_before_network(monkeypatch) -> None:
    env = {
        "R2_ENDPOINT": "https://account.r2.cloudflarestorage.com",
        "R2_ACCESS_KEY_ID": "access",
        "R2_SECRET_ACCESS_KEY": "secret",
        "R2_UPLOAD_BUCKET": "scan-data",
        "R2_RESULTS_BUCKET": "scan-data",
    }
    monkeypatch.setattr(check_env, "merged_env", lambda: env)
    monkeypatch.setattr(
        check_env,
        "get_r2_client",
        lambda _env: (_ for _ in ()).throw(AssertionError("network must not run")),
    )

    assert check_env.check_cloud(dry_run=False, r2_only=True) == [
        "R2_UPLOAD_BUCKET must be private and different from R2_RESULTS_BUCKET"
    ]
