from __future__ import annotations

import io
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

import modal_webhooks
from modal_webhooks import check_status, configure_webhooks, get_upload_urls, start_processing

from tests.helpers.python.streams import RecordingReader

FIXTURES = Path(__file__).parent / "fixtures" / "modal_webhooks"
COMPLETE_JOB = {
    "results/abcdef12/status.json": '{"status":"complete"}',
    "results/abcdef12/series.json": '{"slug":"cloud_abcdef12"}',
}

@pytest.fixture(autouse=True)
def webhook_runtime(monkeypatch):
    """Restore the module-level webhook wiring so each test configures its own."""
    monkeypatch.setenv("MODAL_AUTH_TOKEN", "secret-token")
    previous = dict(modal_webhooks._context)
    yield
    modal_webhooks._context.clear()
    modal_webhooks._context.update(previous)

class FakeS3Error(Exception):
    def __init__(self, code: str, status: int):
        super().__init__(code)
        self.response = {
            "Error": {"Code": code},
            "ResponseMetadata": {"HTTPStatusCode": status},
        }

class FakeS3:
    """R2 double that records every call and can fail a chosen operation."""

    def __init__(
        self,
        objects: dict[str, str] | None = None,
        *,
        put_error=None,
        get_error=None,
        expiry_delta: int = 0,
        echo_content_type: bool = False,
    ):
        self.objects: dict[str, str] = dict(objects or {})
        self.put_error = put_error
        self.get_error = get_error
        self.expiry_delta = expiry_delta
        self.echo_content_type = echo_content_type
        self.buckets: list[str] = []
        self.presigned: list[dict] = []

    def put_object(self, Bucket, Key, Body, ContentType, **_conditions):
        self.buckets.append(Bucket)
        if self.put_error is not None:
            raise self.put_error
        self.objects[Key] = Body
        return {"ETag": '"v1"'}

    def get_object(self, Bucket=None, Key=None, **_kwargs):
        self.buckets.append(Bucket)
        if self.get_error is not None:
            raise self.get_error
        value = self.objects[Key]
        return {"Body": value if isinstance(value, io.IOBase) else io.BytesIO(value.encode())}

    def generate_presigned_url(self, _name, Params, ExpiresIn):
        self.presigned.append({"Params": Params, "ExpiresIn": ExpiresIn})
        expires = ExpiresIn + self.expiry_delta
        url = f"https://uploads.example/{Params['Key']}?expires={expires}"
        return f"{url}&content_type={Params['ContentType']}" if self.echo_content_type else url

class ConditionalFakeS3:
    """R2 double honouring the conditional writes that guard the start claim."""

    def __init__(self):
        self.objects: dict[str, str] = {}
        self.etags: dict[str, str] = {}
        self._version = 0
        self._lock = threading.Lock()

    def put_object(self, Bucket, Key, Body, ContentType, IfNoneMatch=None, IfMatch=None):
        with self._lock:
            if IfNoneMatch == "*" and Key in self.objects:
                raise FakeS3Error("PreconditionFailed", 412)
            if IfMatch is not None and self.etags.get(Key) != IfMatch:
                raise FakeS3Error("PreconditionFailed", 412)
            self._version += 1
            etag = f"v{self._version}"
            self.objects[Key] = Body
            self.etags[Key] = etag
            return {"ETag": f'"{etag}"'}

    def get_object(self, Bucket, Key):
        with self._lock:
            if Key not in self.objects:
                raise FakeS3Error("NoSuchKey", 404)
            return {
                "Body": io.BytesIO(self.objects[Key].encode()),
                "ETag": f'"{self.etags[Key]}"',
            }

class FakeProcess:
    def __init__(self, error: Exception | None = None, *, fail_once: bool = False):
        self.calls: list[tuple] = []
        self.error = error
        self.fail_once = fail_once
        self._lock = threading.Lock()

    def spawn(self, *args):
        with self._lock:
            self.calls.append(args)
            if self.error is not None and (not self.fail_once or len(self.calls) == 1):
                raise self.error

def configure(s3, process=None, **overrides) -> FakeProcess:
    """Wire the webhooks to a double and return the process spawner they use."""
    process = process if process is not None else FakeProcess()
    configure_webhooks(
        upload_bucket="scan-inputs",
        results_bucket="scan-data",
        get_r2_client=lambda: s3,
        process_study=process,
        **overrides,
    )
    return process

def start_payload(**overrides) -> dict:
    payload = {
        "job_id": "abcdef12",
        "token": "secret-token",
        "modality": "CT",
        "processing_mode": "standard",
        "input_kind": "dicom_volume_stack",
        "total_upload_bytes": 1024,
    }
    payload.update(overrides)
    return payload

def upload_payload(*items: dict) -> dict:
    return {
        "job_id": "abcdef12",
        "token": "secret-token",
        "items": list(items or [{"upload_id": "f000001", "filename": "IM0001", "size_bytes": 10}]),
    }

def test_start_processing_spawns_the_job_and_claims_its_status(monkeypatch) -> None:
    s3 = FakeS3()
    process = configure(s3)

    started = start_processing(start_payload())

    assert started == {"status": "started", "job_id": "abcdef12"}
    assert process.calls == [("abcdef12", "CT", "standard", "dicom_volume_stack")]
    assert set(s3.buckets) == {"scan-data"}

def test_check_status_returns_the_series_entry_of_a_complete_job() -> None:
    s3 = FakeS3(COMPLETE_JOB)
    _ = configure(s3)

    status = check_status({"job_id": "abcdef12", "token": "secret-token"})

    assert status["series_entry"]["slug"] == "cloud_abcdef12"
    assert set(s3.buckets) == {"scan-data"}

def test_check_status_hydrates_a_partial_series_entry() -> None:
    _ = configure(FakeS3({
        "results/abcdef12/status.json": '{"status":"partial","slug":"cloud_abcdef12"}',
        "results/abcdef12/series.json": '{"slug":"cloud_abcdef12"}',
    }))

    status = check_status({"job_id": "abcdef12", "token": "secret-token"})

    assert status["status"] == "partial"
    assert status["series_entry"]["slug"] == "cloud_abcdef12"

def test_upload_urls_presign_the_declared_object_key_size_and_expiry() -> None:
    s3 = FakeS3()
    _ = configure(s3, upload_expiry_seconds=3600)

    urls = get_upload_urls(upload_payload())

    assert "f000001" in urls["urls"]
    assert urls["uploadExpirySeconds"] == 900
    assert s3.presigned == [{
        "Params": {
            "Bucket": "scan-inputs",
            "Key": "uploads/abcdef12/f000001__IM0001",
            "ContentType": "application/dicom",
            "ContentLength": 10,
        },
        "ExpiresIn": 900,
    }]

def test_upload_urls_sign_mixed_dicom_and_sidecar_uploads() -> None:
    s3 = FakeS3(echo_content_type=True)
    _ = configure(s3, upload_expiry_seconds=900)

    result = get_upload_urls(upload_payload(
        {"upload_id": "f000001", "filename": "IM0001", "size_bytes": 10},
        {"upload_id": "f000002", "filename": "voxellab.source.json", "size_bytes": 20},
    ))

    assert "content_type=application/dicom" in result["urls"]["f000001"]
    assert "content_type=application/json" in result["urls"]["f000002"]
    assert [call["Params"]["Key"] for call in s3.presigned] == [
        "uploads/abcdef12/f000001__IM0001",
        "uploads/abcdef12/voxellab.source.json",
    ]
    assert [call["Params"]["ContentLength"] for call in s3.presigned] == [10, 20]

def test_upload_urls_reject_items_without_a_declared_size() -> None:
    s3 = FakeS3()
    _ = configure(s3, max_upload_bytes=100)

    result = get_upload_urls(upload_payload({"upload_id": "f000001", "filename": "IM0001"}))

    assert result == {"status": "error", "error": "invalid upload item"}
    assert s3.presigned == []

def test_upload_urls_reject_items_larger_than_the_configured_limit() -> None:
    s3 = FakeS3()
    _ = configure(s3, max_upload_bytes=100)

    result = get_upload_urls(upload_payload({"upload_id": "f000001", "filename": "IM0001", "size_bytes": 101}))

    assert result["status"] == "error"
    assert result["maxUploadBytes"] == 100
    assert s3.presigned == []

def test_upload_urls_reject_a_presigned_url_that_outlives_the_expiry_limit() -> None:
    _ = configure(FakeS3(expiry_delta=1), upload_expiry_seconds=900)

    result = get_upload_urls(upload_payload())

    assert result == {"status": "error", "error": "upload URL expiry exceeds 15 minute limit"}

def test_webhook_responses_match_the_browser_facing_snapshots() -> None:
    cases = {}
    _ = configure(FakeS3())
    cases["start_processing.json"] = start_processing(start_payload())
    _ = configure(FakeS3(COMPLETE_JOB))
    cases["check_status.json"] = check_status({"job_id": "abcdef12", "token": "secret-token"})
    _ = configure(FakeS3(), upload_expiry_seconds=3600)
    cases["get_upload_urls.json"] = get_upload_urls(upload_payload())

    for fixture_name, payload in cases.items():
        assert payload == json.loads((FIXTURES / fixture_name).read_text()), fixture_name

def test_repeated_start_requests_spawn_the_job_once() -> None:
    process = configure(ConditionalFakeS3())

    first = start_processing(start_payload())
    second = start_processing(start_payload())

    assert first == {"status": "started", "job_id": "abcdef12"}
    assert second["status"] == "started"
    assert second["job_id"] == "abcdef12"
    assert second["alreadyStarted"] is True
    assert len(process.calls) == 1

def test_concurrent_start_requests_spawn_the_job_once() -> None:
    process = configure(ConditionalFakeS3())

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _index: start_processing(start_payload()), range(2)))

    assert [result["status"] for result in results] == ["started", "started"]
    assert sum(bool(result.get("alreadyStarted")) for result in results) == 1
    assert len(process.calls) == 1

def test_a_failed_spawn_fails_closed_and_stays_failed_on_retry() -> None:
    s3 = ConditionalFakeS3()
    process = configure(s3, FakeProcess(RuntimeError("scheduler unavailable"), fail_once=True))

    failed = start_processing(start_payload())
    dispatch_unknown = json.loads(s3.objects["results/abcdef12/status.json"])
    retried = start_processing(start_payload())

    assert failed == {
        "status": "error",
        "error": "dispatch_unknown",
        "detail": "scheduler unavailable",
        "retryable": False,
    }
    assert dispatch_unknown["status"] == "dispatch_unknown"
    assert retried == {
        "status": "error",
        "error": "dispatch_unknown",
        "detail": "processing dispatch could not be confirmed",
        "retryable": False,
    }
    assert len(process.calls) == 1

@pytest.mark.parametrize(
    ("s3", "expected_error"),
    [
        (FakeS3(put_error=FakeS3Error("ServiceUnavailable", 503)), "claim_unavailable"),
        (
            FakeS3(
                put_error=FakeS3Error("PreconditionFailed", 412),
                get_error=FakeS3Error("ServiceUnavailable", 503),
            ),
            "claim_status_unavailable",
        ),
    ],
    ids=["claim-write-failed", "existing-claim-unreadable"],
)
def test_start_processing_never_spawns_when_the_claim_is_unresolved(s3: FakeS3, expected_error: str) -> None:
    process = configure(s3)

    result = start_processing(start_payload())

    assert result["status"] == "error"
    assert result["error"] == expected_error
    assert process.calls == []

@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        (
            start_payload(total_upload_bytes=4096),
            {
                "status": "error",
                "error": "total upload size exceeds limit (2048 bytes)",
                "maxUploadBytes": 2048,
            },
        ),
        (
            start_payload(processing_mode="ultrasound_scan_conversion"),
            {
                "status": "error",
                "error": "ultrasound_scan_conversion requires calibrated_ultrasound_source input_kind",
            },
        ),
    ],
    ids=["oversized-upload", "mode-input-kind-mismatch"],
)
def test_start_processing_rejects_invalid_payloads_before_any_side_effect(payload: dict, expected: dict) -> None:
    s3 = FakeS3()
    process = configure(s3, max_upload_bytes=2048)

    assert start_processing(payload) == expected
    assert s3.objects == {}
    assert process.calls == []

@pytest.mark.parametrize(
    ("s3", "expected_error", "detail"),
    [
        (FakeS3(get_error=RuntimeError("boom")), "status_unavailable", "boom"),
        (FakeS3({"results/abcdef12/status.json": "{not-json"}), "status_parse_failed", None),
        (
            FakeS3({"results/abcdef12/status.json": '{"status":"complete"}'}),
            "series_entry_unavailable",
            None,
        ),
        (
            FakeS3({**COMPLETE_JOB, "results/abcdef12/series.json": "{not-json"}),
            "series_entry_parse_failed",
            None,
        ),
    ],
    ids=["status-unreadable", "status-malformed", "series-entry-missing", "series-entry-malformed"],
)
def test_check_status_reports_named_result_failures(s3: FakeS3, expected_error: str, detail: str | None) -> None:
    _ = configure(s3)

    result = check_status({"job_id": "abcdef12", "token": "secret-token"})

    assert result["status"] == "error"
    assert result["error"] == expected_error
    if detail is not None:
        assert result["detail"] == detail

def test_check_status_reports_processing_while_no_status_object_exists() -> None:
    _ = configure(FakeS3(get_error=FakeS3Error("NoSuchKey", 404)))

    assert check_status({"job_id": "abcdef12", "token": "secret-token"}) == {"status": "processing"}

@pytest.mark.parametrize(
    ("key", "payload", "limit", "label"),
    [
        ("results/abcdef12/status.json", b'{"status":"processing"}', 5, "status"),
        ("results/abcdef12/series.json", b'{"slug":"cloud_abcdef12","extra":"xxxxxxxx"}', 32, "series_entry"),
    ],
    ids=["status-json", "series-json"],
)
def test_check_status_caps_every_result_json_it_reads(monkeypatch, key: str, payload: bytes, limit: int, label: str) -> None:
    body = RecordingReader(payload)
    _ = configure(FakeS3({**COMPLETE_JOB, key: body}))
    monkeypatch.setattr(modal_webhooks, "MAX_RESULT_JSON_BYTES", limit)

    result = check_status({"job_id": "abcdef12", "token": "secret-token"})

    assert result["status"] == "error"
    assert result["error"] == f"{label}_parse_failed"
    assert f"{label} JSON exceeds {limit} bytes" in result["detail"]
    assert body.read_sizes == [limit + 1]
