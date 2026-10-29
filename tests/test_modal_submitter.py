from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
from types import SimpleNamespace

import pytest

from modal_validation import MAX_UPLOAD_ITEMS
from scripts.submit_modal_study import (
    candidate_files,
    chunks,
    get_json,
    modal_endpoint,
    normalize_series_entry,
    post_json,
    put_file,
    submit_preflight_errors,
    start_processing_payload,
    submit,
    trusted_upload_origins,
    upload_content_type,
    upload_items,
    validate_upload_url,
)

from tests.helpers.python.streams import FakeHTTPResponse

def write_config(tmp_path: Path, **values) -> Path:
    config = tmp_path / "config.json"
    _ = config.write_text(json.dumps({"modalWebhookBase": "", "r2PublicUrl": "", **values}))
    return config

def submit_args(source: Path, config: Path, **overrides) -> SimpleNamespace:
    """CLI arguments as argparse would hand them to `submit`."""
    args = {
        "config": config,
        "modal_base": "",
        "r2_public_url": "",
        "trusted_upload_origin": [],
        "source": source,
        "job_id": "job123",
        "modality": "auto",
        "processing_mode": "standard",
        "input_kind": "",
        "skip_upload": True,
        "batch_size": 450,
        "upload_workers": 8,
        "progress_every": 25,
        "poll_seconds": 10,
        "max_wait_seconds": 1,
    }
    args.update(overrides)
    return SimpleNamespace(**args)

def offline_submit(monkeypatch, env: dict | None = None) -> list:
    """Load env from the fake dotenv and fail loudly if the CLI reaches the network."""
    network_calls: list = []
    monkeypatch.setattr("scripts.submit_modal_study.load_dotenv", lambda _path=None: dict(env or {}))
    monkeypatch.setattr(
        "scripts.submit_modal_study.post_json",
        lambda *args, **_kwargs: network_calls.append(args) or (_ for _ in ()).throw(AssertionError("network")),
    )
    return network_calls

def test_modal_endpoints_are_derived_from_the_app_prefix() -> None:
    assert modal_endpoint("https://example-org--medical-imaging-pipeline", "get_upload_urls") == (
        "https://example-org--medical-imaging-pipeline-get-upload-urls.modal.run"
    )

def test_modal_endpoints_accept_an_existing_function_url() -> None:
    base = "https://example-org--medical-imaging-pipeline-check-status.modal.run"

    assert modal_endpoint(base, "start_processing").endswith("-start-processing.modal.run")

def test_candidate_files_keep_dicom_and_the_source_manifest(tmp_path: Path) -> None:
    for name in ("1.dcm", "2.jpg", "voxellab.source.json", ".DS_Store"):
        _ = (tmp_path / name).write_bytes(b"x")

    assert [path.name for path in candidate_files(tmp_path)] == ["1.dcm", "voxellab.source.json"]

def test_candidate_files_take_only_the_top_level_source_manifest(tmp_path: Path) -> None:
    nested = tmp_path / "study" / "series"
    nested.mkdir(parents=True)
    _ = (nested / "IM0001").write_bytes(b"x")
    _ = (nested / "voxellab.source.json").write_text("{}")
    _ = (tmp_path / "voxellab.source.json").write_text("{}")

    assert [path.relative_to(tmp_path) for path in candidate_files(tmp_path)] == [
        Path("study/series/IM0001"),
        Path("voxellab.source.json"),
    ]

def test_candidate_files_skip_hidden_and_macosx_trees(tmp_path: Path) -> None:
    for folder, name in ((tmp_path / "study", "IM0001"), (tmp_path / "__MACOSX" / "study", "IM0002"), (tmp_path / ".hidden" / "study", "IM0003")):
        folder.mkdir(parents=True)
        _ = (folder / name).write_bytes(b"x")

    assert [path.relative_to(tmp_path) for path in candidate_files(tmp_path)] == [Path("study/IM0001")]

def test_uploads_are_batched_and_given_unique_ids() -> None:
    assert chunks([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]]
    assert upload_items([Path("/a/IM0001"), Path("/b/IM0001")], start_index=7) == [
        {"upload_id": "f000007", "filename": "IM0001", "path": Path("/a/IM0001")},
        {"upload_id": "f000008", "filename": "IM0001", "path": Path("/b/IM0001")},
    ]

def test_upload_content_types_match_the_presign_contract() -> None:
    assert upload_content_type(Path("/tmp/scan.dcm")) == "application/dicom"
    assert upload_content_type(Path("/tmp/voxellab.source.json")) == "application/json"

def test_posted_requests_cap_the_modal_response_body(monkeypatch) -> None:
    response = FakeHTTPResponse(b'{"status":"started"}')
    seen = {}

    def fake_urlopen(req, timeout=0):
        seen.update({
            "method": req.get_method(),
            "timeout": timeout,
            "content_type": req.get_header("Content-type"),
        })
        return response

    monkeypatch.setattr("scripts.submit_modal_study.urllib.request.urlopen", fake_urlopen)

    with pytest.raises(RuntimeError, match="exceeds 5 bytes"):
        _ = post_json("https://modal.example/start", {"job_id": "job123"}, timeout=17, max_bytes=5)

    assert seen == {"method": "POST", "timeout": 17, "content_type": "application/json"}
    assert response.read_sizes == [6]

def test_polled_requests_cap_the_modal_response_body(monkeypatch) -> None:
    response = FakeHTTPResponse(b'{"status":"complete"}')
    monkeypatch.setattr("scripts.submit_modal_study.urllib.request.urlopen", lambda *_args, **_kwargs: response)

    with pytest.raises(RuntimeError, match="exceeds 5 bytes"):
        _ = get_json("https://modal.example/status", max_bytes=5)

    assert response.read_sizes == [6]

def test_uploads_stream_the_file_instead_of_buffering_it(monkeypatch, tmp_path: Path) -> None:
    source = tmp_path / "scan.dcm"
    _ = source.write_bytes(b"dicom-bytes")
    seen = {}

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def fake_urlopen(req, timeout=0):
        seen.update({
            "timeout": timeout,
            "method": req.get_method(),
            "content_type": req.get_header("Content-type"),
            "content_length": req.get_header("Content-length"),
            "data_is_bytes": isinstance(req.data, bytes),
            "body": req.data.read(),
            "closed_during_request": req.data.closed,
        })
        return Response()

    monkeypatch.setattr("scripts.submit_modal_study.urllib.request.urlopen", fake_urlopen)

    put_file("https://upload.example/scan.dcm", source, timeout=17)

    assert seen == {
        "timeout": 17,
        "method": "PUT",
        "content_type": "application/dicom",
        "content_length": str(len(b"dicom-bytes")),
        "data_is_bytes": False,
        "body": b"dicom-bytes",
        "closed_during_request": False,
    }

def test_uploads_reach_a_real_http_server_with_the_declared_length(tmp_path: Path) -> None:
    seen = {}

    class UploadHandler(BaseHTTPRequestHandler):
        def do_PUT(self):
            length = int(self.headers.get("Content-Length") or "0")
            seen.update({
                "method": self.command,
                "content_type": self.headers.get("Content-Type"),
                "content_length": self.headers.get("Content-Length"),
                "body": self.rfile.read(length),
            })
            self.send_response(200)
            self.end_headers()

        def log_message(self, format, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), UploadHandler)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        source = tmp_path / "scan.dcm"
        _ = source.write_bytes(b"dicom-bytes")

        put_file(f"http://127.0.0.1:{server.server_port}/upload", source, timeout=5)
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()

    assert seen == {
        "method": "PUT",
        "content_type": "application/dicom",
        "content_length": str(len(b"dicom-bytes")),
        "body": b"dicom-bytes",
    }

@pytest.mark.parametrize(
    ("processing_mode", "input_kind", "total_bytes"),
    [
        ("projection_set_reconstruction", "calibrated_projection_set", 4096),
        ("ultrasound_scan_conversion", "calibrated_ultrasound_source", 2048),
        ("rigid_registration", "dicom_registration_pair", 8192),
    ],
)
def test_start_processing_payload_carries_the_mode_specific_contract(
    processing_mode: str, input_kind: str, total_bytes: int
) -> None:
    assert start_processing_payload("job123", "auto", processing_mode, input_kind, total_bytes) == {
        "job_id": "job123",
        "modality": "auto",
        "processing_mode": processing_mode,
        "input_kind": input_kind,
        "total_upload_bytes": total_bytes,
    }

def test_result_entries_are_backfilled_with_public_urls() -> None:
    entry = normalize_series_entry({"slug": "cloud_job123", "hasRaw": True}, "https://r2.example")

    assert entry is not None
    assert entry["slug"] == "cloud_job123"
    assert entry["hasRaw"] is True
    assert entry["hasBrain"] is False
    assert entry["hasSeg"] is False
    assert entry["sliceUrlBase"] == "https://r2.example/data/cloud_job123"
    assert entry["rawUrl"] == "https://r2.example/cloud_job123.raw.zst"

def test_result_entries_backfill_region_urls_when_regions_exist() -> None:
    entry = normalize_series_entry({"slug": "cloud_job123", "hasRegions": True}, "https://r2.example")

    assert entry["regionUrlBase"] == "https://r2.example/data/cloud_job123_regions"
    assert entry["regionMetaUrl"] == "https://r2.example/data/cloud_job123_regions.json"

def test_upload_urls_outside_the_trusted_origins_are_refused() -> None:
    with pytest.raises(RuntimeError, match="trusted origins"):
        _ = validate_upload_url("https://evil.example/upload", ["https://r2.example"])

def test_trusted_origins_merge_the_r2_endpoint_with_explicit_hosts() -> None:
    endpoint = "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"

    assert trusted_upload_origins(endpoint, ["https://upload.example", endpoint]) == [
        endpoint,
        "https://upload.example",
    ]

def test_projection_sources_need_a_calibration_manifest(tmp_path: Path) -> None:
    _ = (tmp_path / "IM0001").write_bytes(b"x")

    errors = submit_preflight_errors(tmp_path, "projection_set_reconstruction", False)

    assert any("missing calibration manifest" in error for error in errors)

def test_advanced_preflight_is_skipped_when_no_upload_will_happen(tmp_path: Path) -> None:
    assert submit_preflight_errors(tmp_path, "projection_set_reconstruction", True) == []

@pytest.mark.parametrize(
    ("config", "env", "overrides", "message"),
    [
        ({}, {}, {}, "missing MODAL_WEBHOOK_BASE"),
        ({"modalWebhookBase": "https://modal.example"}, {}, {}, "missing MODAL_AUTH_TOKEN"),
        (
            {"modalWebhookBase": "https://modal.example"},
            {"MODAL_AUTH_TOKEN": "token"},
            {"processing_mode": "projection_set_reconstruction", "input_kind": "dicom_volume_stack"},
            "projection_set_reconstruction requires --input-kind calibrated_projection_set",
        ),
        (
            {"modalWebhookBase": "https://example-org--pipeline"},
            {"MODAL_AUTH_TOKEN": "token"},
            {"upload_workers": 0},
            "--upload-workers must be at least 1",
        ),
        (
            {"modalWebhookBase": "https://example-org--pipeline"},
            {"MODAL_AUTH_TOKEN": "token"},
            {"progress_every": 0},
            "--progress-every must be at least 1",
        ),
        (
            {"modalWebhookBase": "https://example-org--pipeline"},
            {"MODAL_AUTH_TOKEN": "token"},
            {"poll_seconds": 0},
            "--poll-seconds must be at least 1",
        ),
        (
            {"modalWebhookBase": "https://example-org--pipeline"},
            {"MODAL_AUTH_TOKEN": "token"},
            {"max_wait_seconds": 0},
            "--max-wait-seconds must be at least 1",
        ),
    ],
    ids=[
        "missing-webhook-base",
        "missing-auth-token",
        "input-kind-mismatch",
        "upload-workers",
        "progress-every",
        "poll-seconds",
        "max-wait-seconds",
    ],
)
def test_submit_rejects_unusable_configuration_before_any_network_call(
    monkeypatch, tmp_path: Path, config: dict, env: dict, overrides: dict, message: str
) -> None:
    monkeypatch.delenv("MODAL_WEBHOOK_BASE", raising=False)
    monkeypatch.delenv("MODAL_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("R2_PUBLIC_URL", raising=False)
    network_calls = offline_submit(monkeypatch, env)
    args = submit_args(tmp_path, write_config(tmp_path, **config), **overrides)

    with pytest.raises(SystemExit, match=message):
        _ = submit(args)

    assert network_calls == []

def test_submit_requires_a_trusted_upload_origin_before_uploading(monkeypatch, tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _ = (source / "IM0001").write_bytes(b"d")
    network_calls = offline_submit(monkeypatch, {"MODAL_AUTH_TOKEN": "token"})
    args = submit_args(
        source,
        write_config(tmp_path, modalWebhookBase="https://example-org--pipeline"),
        skip_upload=False,
        upload_workers=1,
        poll_seconds=1,
        max_wait_seconds=5,
    )

    with pytest.raises(SystemExit, match="missing trusted R2 S3 upload origin"):
        _ = submit(args)

    assert network_calls == []

def test_submit_caps_upload_batches_to_the_modal_contract(monkeypatch, tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    for index in range(MAX_UPLOAD_ITEMS + 1):
        _ = (source / f"IM{index:06d}").write_bytes(b"d")
    upload_batch_lengths: list[int] = []

    def fake_post_json(url: str, payload: dict, **_kwargs) -> dict:
        if url.endswith("-get-upload-urls.modal.run"):
            upload_batch_lengths.append(len(payload["items"]))
            return {
                "urls": {
                    item["upload_id"]: f"https://r2.example/upload/{item['upload_id']}"
                    for item in payload["items"]
                }
            }
        if url.endswith("-start-processing.modal.run"):
            return {"status": "started"}
        if url.endswith("-check-status.modal.run"):
            return {"status": "complete", "series_entry": {"slug": "cloud_job123"}}
        raise AssertionError(url)

    monkeypatch.setattr("scripts.submit_modal_study.load_dotenv", lambda _path=None: {"MODAL_AUTH_TOKEN": "token"})
    monkeypatch.setattr("scripts.submit_modal_study.post_json", fake_post_json)
    monkeypatch.setattr("scripts.submit_modal_study.put_file", lambda *_args, **_kwargs: None)
    args = submit_args(
        source,
        write_config(
            tmp_path,
            modalWebhookBase="https://example-org--pipeline",
            r2PublicUrl="https://r2.example",
            trustedUploadOrigins=["https://r2.example"],
        ),
        skip_upload=False,
        batch_size=MAX_UPLOAD_ITEMS + 99,
        upload_workers=1,
        progress_every=999,
        poll_seconds=1,
        max_wait_seconds=5,
    )

    result = submit(args)

    assert upload_batch_lengths == [MAX_UPLOAD_ITEMS, 1]
    assert result["series_entry"]["sliceUrlBase"] == "https://r2.example/data/cloud_job123"
