from __future__ import annotations

import io
import json
from pathlib import Path

import modal_webhooks
from modal_webhooks import check_status, configure_webhooks, get_upload_urls, start_processing

FIXTURES = Path(__file__).parent / "fixtures" / "modal_webhooks"


class TrackingBody(io.BytesIO):
    def __init__(self, payload: bytes):
        super().__init__(payload)
        self.read_sizes: list[int | None] = []

    def read(self, size: int | None = -1) -> bytes:
        self.read_sizes.append(size)
        return super().read(size)


def test_modal_webhooks_start_status_and_upload_urls(monkeypatch):
    monkeypatch.setenv("MODAL_AUTH_TOKEN", "secret-token")

    class FakeS3:
        def __init__(self):
            self.objects = {}

        def put_object(self, Bucket, Key, Body, ContentType):
            self.objects[Key] = Body

        def get_object(self, Bucket, Key):
            return {"Body": io.BytesIO(self.objects[Key].encode() if isinstance(self.objects[Key], str) else self.objects[Key])}

        def generate_presigned_url(self, _name, Params, ExpiresIn):
            return f"https://uploads.example/{Params['Key']}?expires={ExpiresIn}"

    class FakeProcess:
        def __init__(self):
            self.calls = []

        def spawn(self, *args):
            self.calls.append(args)

    s3 = FakeS3()
    process = FakeProcess()
    configure_webhooks(
        bucket="scan-data",
        get_r2_client=lambda: s3,
        process_study=process,
        upload_expiry_seconds=3600,
        max_upload_bytes=2 * 1024 * 1024 * 1024,
    )

    started = start_processing({
        "job_id": "abcdef12",
        "token": "secret-token",
        "modality": "CT",
        "processing_mode": "standard",
        "input_kind": "dicom_volume_stack",
        "total_upload_bytes": 1024,
    })
    s3.objects["results/abcdef12/status.json"] = '{"status":"complete"}'
    s3.objects["results/abcdef12/series.json"] = '{"slug":"cloud_abcdef12"}'
    status = check_status({"job_id": "abcdef12", "token": "secret-token"})
    urls = get_upload_urls({
        "job_id": "abcdef12",
        "token": "secret-token",
        "items": [{"upload_id": "f000001", "filename": "IM0001"}],
    })

    assert started == {"status": "started", "job_id": "abcdef12"}
    assert process.calls == [("abcdef12", "CT", "standard", "dicom_volume_stack")]
    assert status["series_entry"]["slug"] == "cloud_abcdef12"
    assert "f000001" in urls["urls"]
    assert urls["uploadExpirySeconds"] == 900


def test_modal_webhook_responses_match_snapshots(monkeypatch):
    monkeypatch.setenv("MODAL_AUTH_TOKEN", "secret-token")

    class FakeS3:
        def __init__(self):
            self.objects = {
                "results/abcdef12/status.json": '{"status":"complete"}',
                "results/abcdef12/series.json": '{"slug":"cloud_abcdef12"}',
            }

        def put_object(self, Bucket, Key, Body, ContentType):
            self.objects[Key] = Body

        def get_object(self, Bucket, Key):
            return {"Body": io.BytesIO(self.objects[Key].encode() if isinstance(self.objects[Key], str) else self.objects[Key])}

        def generate_presigned_url(self, _name, Params, ExpiresIn):
            return f"https://uploads.example/{Params['Key']}?expires={ExpiresIn}"

    class FakeProcess:
        def spawn(self, *args):
            return args

    def load_payload(factory):
        s3 = FakeS3()
        configure_webhooks(
            bucket="scan-data",
            get_r2_client=lambda: s3,
            process_study=FakeProcess(),
            upload_expiry_seconds=3600,
            max_upload_bytes=2 * 1024 * 1024 * 1024,
        )
        return factory()

    cases = {
        "start_processing.json": load_payload(lambda: start_processing({
            "job_id": "abcdef12",
            "token": "secret-token",
            "modality": "CT",
            "processing_mode": "standard",
            "input_kind": "dicom_volume_stack",
            "total_upload_bytes": 1024,
        })),
        "check_status.json": load_payload(lambda: check_status({"job_id": "abcdef12", "token": "secret-token"})),
        "get_upload_urls.json": load_payload(lambda: get_upload_urls({
            "job_id": "abcdef12",
            "token": "secret-token",
            "items": [{"upload_id": "f000001", "filename": "IM0001"}],
        })),
    }

    for fixture_name, payload in cases.items():
        assert payload == json.loads((FIXTURES / fixture_name).read_text())


def test_modal_webhooks_reject_oversized_payload(monkeypatch):
    monkeypatch.setenv("MODAL_AUTH_TOKEN", "secret-token")

    class FakeS3:
        def put_object(self, Bucket, Key, Body, ContentType):
            raise AssertionError("status write should not happen for rejected payloads")

    class FakeProcess:
        def spawn(self, *args):
            raise AssertionError("process should not start for rejected payloads")

    configure_webhooks(
        bucket="scan-data",
        get_r2_client=lambda: FakeS3(),
        process_study=FakeProcess(),
        upload_expiry_seconds=900,
        max_upload_bytes=2048,
    )

    result = start_processing({
        "job_id": "abcdef12",
        "token": "secret-token",
        "modality": "CT",
        "processing_mode": "standard",
        "input_kind": "dicom_volume_stack",
        "total_upload_bytes": 4096,
    })

    assert result == {
        "status": "error",
        "error": "total upload size exceeds limit (2048 bytes)",
        "maxUploadBytes": 2048,
    }


def test_modal_webhooks_reject_overlong_presigned_urls(monkeypatch):
    monkeypatch.setenv("MODAL_AUTH_TOKEN", "secret-token")

    class FakeS3:
        def generate_presigned_url(self, _name, Params, ExpiresIn):
            return f"https://uploads.example/{Params['Key']}?expires={ExpiresIn + 1}"

    configure_webhooks(
        bucket="scan-data",
        get_r2_client=lambda: FakeS3(),
        process_study=object(),
        upload_expiry_seconds=900,
        max_upload_bytes=2 * 1024 * 1024 * 1024,
    )

    result = get_upload_urls({
        "job_id": "abcdef12",
        "token": "secret-token",
        "items": [{"upload_id": "f000001", "filename": "IM0001"}],
    })

    assert result == {"status": "error", "error": "upload URL expiry exceeds 15 minute limit"}


def test_modal_webhooks_sign_mixed_uploads_with_matching_content_types(monkeypatch):
    monkeypatch.setenv("MODAL_AUTH_TOKEN", "secret-token")

    class FakeS3:
        def __init__(self):
            self.calls = []

        def generate_presigned_url(self, _name, Params, ExpiresIn):
            self.calls.append({"Params": Params, "ExpiresIn": ExpiresIn})
            return (
                "https://uploads.example/"
                f"{Params['Key']}?expires={ExpiresIn}&content_type={Params['ContentType']}"
            )

    s3 = FakeS3()
    configure_webhooks(
        bucket="scan-data",
        get_r2_client=lambda: s3,
        process_study=object(),
        upload_expiry_seconds=900,
        max_upload_bytes=2 * 1024 * 1024 * 1024,
    )

    result = get_upload_urls({
        "job_id": "abcdef12",
        "token": "secret-token",
        "items": [
            {"upload_id": "f000001", "filename": "IM0001"},
            {"upload_id": "f000002", "filename": "voxellab.source.json"},
        ],
    })

    assert "f000001" in result["urls"]
    assert "f000002" in result["urls"]
    assert "content_type=application/dicom" in result["urls"]["f000001"]
    assert "content_type=application/json" in result["urls"]["f000002"]
    assert [call["Params"]["ContentType"] for call in s3.calls] == [
        "application/dicom",
        "application/json",
    ]
    assert [call["Params"]["Key"] for call in s3.calls] == [
        "uploads/abcdef12/f000001__IM0001",
        "uploads/abcdef12/voxellab.source.json",
    ]


def test_modal_webhooks_check_status_returns_processing_only_for_missing_status(monkeypatch):
    monkeypatch.setenv("MODAL_AUTH_TOKEN", "secret-token")

    class FakeS3:
        def get_object(self, Bucket, Key):
            raise RuntimeError("boom")

    configure_webhooks(
        bucket="scan-data",
        get_r2_client=lambda: FakeS3(),
        process_study=object(),
        upload_expiry_seconds=900,
        max_upload_bytes=2 * 1024 * 1024 * 1024,
    )

    result = check_status({"job_id": "abcdef12", "token": "secret-token"})

    assert result == {"status": "error", "error": "status_unavailable", "detail": "boom"}


def test_modal_webhooks_check_status_returns_parse_error_for_bad_status_json(monkeypatch):
    monkeypatch.setenv("MODAL_AUTH_TOKEN", "secret-token")

    class FakeS3:
        def get_object(self, Bucket, Key):
            return {"Body": io.BytesIO(b"{not-json")}

    configure_webhooks(
        bucket="scan-data",
        get_r2_client=lambda: FakeS3(),
        process_study=object(),
        upload_expiry_seconds=900,
        max_upload_bytes=2 * 1024 * 1024 * 1024,
    )

    result = check_status({"job_id": "abcdef12", "token": "secret-token"})

    assert result["status"] == "error"
    assert result["error"] == "status_parse_failed"


def test_modal_webhooks_check_status_caps_status_json(monkeypatch):
    monkeypatch.setenv("MODAL_AUTH_TOKEN", "secret-token")
    monkeypatch.setattr(modal_webhooks, "MAX_RESULT_JSON_BYTES", 5)
    body = TrackingBody(b'{"status":"processing"}')

    class FakeS3:
        def get_object(self, Bucket, Key):
            return {"Body": body}

    configure_webhooks(
        bucket="scan-data",
        get_r2_client=lambda: FakeS3(),
        process_study=object(),
        upload_expiry_seconds=900,
        max_upload_bytes=2 * 1024 * 1024 * 1024,
    )

    result = check_status({"job_id": "abcdef12", "token": "secret-token"})

    assert result["status"] == "error"
    assert result["error"] == "status_parse_failed"
    assert "status JSON exceeds 5 bytes" in result["detail"]
    assert body.read_sizes == [6]


def test_modal_webhooks_check_status_rejects_complete_without_series_json(monkeypatch):
    monkeypatch.setenv("MODAL_AUTH_TOKEN", "secret-token")

    class FakeS3:
        def get_object(self, Bucket, Key):
            if Key.endswith("/status.json"):
                return {"Body": io.BytesIO(b'{"status":"complete"}')}
            raise FileNotFoundError(Key)

    configure_webhooks(
        bucket="scan-data",
        get_r2_client=lambda: FakeS3(),
        process_study=object(),
        upload_expiry_seconds=900,
        max_upload_bytes=2 * 1024 * 1024 * 1024,
    )

    result = check_status({"job_id": "abcdef12", "token": "secret-token"})

    assert result["status"] == "error"
    assert result["error"] == "series_entry_unavailable"


def test_modal_webhooks_check_status_rejects_complete_with_bad_series_json(monkeypatch):
    monkeypatch.setenv("MODAL_AUTH_TOKEN", "secret-token")

    class FakeS3:
        def get_object(self, Bucket, Key):
            if Key.endswith("/status.json"):
                return {"Body": io.BytesIO(b'{"status":"complete"}')}
            return {"Body": io.BytesIO(b"{not-json")}

    configure_webhooks(
        bucket="scan-data",
        get_r2_client=lambda: FakeS3(),
        process_study=object(),
        upload_expiry_seconds=900,
        max_upload_bytes=2 * 1024 * 1024 * 1024,
    )

    result = check_status({"job_id": "abcdef12", "token": "secret-token"})

    assert result["status"] == "error"
    assert result["error"] == "series_entry_parse_failed"


def test_modal_webhooks_check_status_caps_series_json(monkeypatch):
    monkeypatch.setenv("MODAL_AUTH_TOKEN", "secret-token")
    monkeypatch.setattr(modal_webhooks, "MAX_RESULT_JSON_BYTES", 32)
    series_body = TrackingBody(b'{"slug":"cloud_abcdef12","extra":"xxxxxxxx"}')

    class FakeS3:
        def get_object(self, Bucket, Key):
            if Key.endswith("/status.json"):
                return {"Body": io.BytesIO(b'{"status":"complete"}')}
            return {"Body": series_body}

    configure_webhooks(
        bucket="scan-data",
        get_r2_client=lambda: FakeS3(),
        process_study=object(),
        upload_expiry_seconds=900,
        max_upload_bytes=2 * 1024 * 1024 * 1024,
    )

    result = check_status({"job_id": "abcdef12", "token": "secret-token"})

    assert result["status"] == "error"
    assert result["error"] == "series_entry_parse_failed"
    assert "series_entry JSON exceeds 32 bytes" in result["detail"]
    assert series_body.read_sizes == [33]


def test_modal_webhooks_check_status_returns_processing_for_missing_key(monkeypatch):
    monkeypatch.setenv("MODAL_AUTH_TOKEN", "secret-token")

    class MissingStatus(Exception):
        def __init__(self):
            self.response = {"Error": {"Code": "NoSuchKey"}}

    class FakeS3:
        def get_object(self, Bucket, Key):
            raise MissingStatus()

    configure_webhooks(
        bucket="scan-data",
        get_r2_client=lambda: FakeS3(),
        process_study=object(),
        upload_expiry_seconds=900,
        max_upload_bytes=2 * 1024 * 1024 * 1024,
    )

    result = check_status({"job_id": "abcdef12", "token": "secret-token"})

    assert result == {"status": "processing"}
