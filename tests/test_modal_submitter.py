from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
from pathlib import Path
import threading

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


class ReadTrackingResponse:
    def __init__(self, payload: bytes):
        self.payload = io.BytesIO(payload)
        self.read_sizes: list[int] = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, size: int = -1) -> bytes:
        self.read_sizes.append(size)
        return self.payload.read(size)


def test_modal_endpoint_derives_function_urls_from_app_prefix() -> None:
    url = modal_endpoint("https://example-org--medical-imaging-pipeline", "get_upload_urls")

    assert url == "https://example-org--medical-imaging-pipeline-get-upload-urls.modal.run"


def test_modal_endpoint_accepts_existing_function_url() -> None:
    base = "https://example-org--medical-imaging-pipeline-check-status.modal.run"

    assert modal_endpoint(base, "start_processing").endswith("-start-processing.modal.run")


def test_candidate_files_skip_sidecars(tmp_path: Path) -> None:
    _ = (tmp_path / "1.dcm").write_bytes(b"x")
    _ = (tmp_path / "2.jpg").write_bytes(b"x")
    _ = (tmp_path / "voxellab.source.json").write_text("{}")
    _ = (tmp_path / ".DS_Store").write_bytes(b"x")

    assert [path.name for path in candidate_files(tmp_path)] == ["1.dcm", "voxellab.source.json"]


def test_candidate_files_include_nested_dicom_without_nested_manifests(tmp_path: Path) -> None:
    nested = tmp_path / "study" / "series"
    nested.mkdir(parents=True)
    _ = (nested / "IM0001").write_bytes(b"x")
    _ = (nested / "voxellab.source.json").write_text("{}")
    _ = (tmp_path / "voxellab.source.json").write_text("{}")

    assert [path.relative_to(tmp_path) for path in candidate_files(tmp_path)] == [
        Path("study/series/IM0001"),
        Path("voxellab.source.json"),
    ]


def test_candidate_files_skip_hidden_and_macosx_tree_entries(tmp_path: Path) -> None:
    visible = tmp_path / "study"
    macosx = tmp_path / "__MACOSX" / "study"
    hidden = tmp_path / ".hidden" / "study"
    visible.mkdir()
    macosx.mkdir(parents=True)
    hidden.mkdir(parents=True)
    _ = (visible / "IM0001").write_bytes(b"x")
    _ = (macosx / "IM0002").write_bytes(b"x")
    _ = (hidden / "IM0003").write_bytes(b"x")

    assert [path.relative_to(tmp_path) for path in candidate_files(tmp_path)] == [Path("study/IM0001")]


def test_chunks_batches_values() -> None:
    assert chunks([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]]


def test_upload_items_assign_unique_ids_for_duplicate_basenames() -> None:
    items = upload_items([Path("/a/IM0001"), Path("/b/IM0001")], start_index=7)

    assert items == [
        {"upload_id": "f000007", "filename": "IM0001", "path": Path("/a/IM0001")},
        {"upload_id": "f000008", "filename": "IM0001", "path": Path("/b/IM0001")},
    ]


def test_upload_content_type_matches_presign_contract() -> None:
    assert upload_content_type(Path("/tmp/scan.dcm")) == "application/dicom"
    assert upload_content_type(Path("/tmp/voxellab.source.json")) == "application/json"


def test_post_json_caps_modal_response_body(monkeypatch) -> None:
    response = ReadTrackingResponse(b'{"status":"started"}')
    seen = {}

    def fake_urlopen(req, timeout=0):
        seen["method"] = req.get_method()
        seen["timeout"] = timeout
        seen["content_type"] = req.get_header("Content-type")
        return response

    monkeypatch.setattr("scripts.submit_modal_study.urllib.request.urlopen", fake_urlopen)

    with pytest.raises(RuntimeError, match="exceeds 5 bytes"):
        _ = post_json("https://modal.example/start", {"job_id": "job123"}, timeout=17, max_bytes=5)

    assert seen == {"method": "POST", "timeout": 17, "content_type": "application/json"}
    assert response.read_sizes == [6]


def test_get_json_caps_modal_response_body(monkeypatch) -> None:
    response = ReadTrackingResponse(b'{"status":"complete"}')
    monkeypatch.setattr("scripts.submit_modal_study.urllib.request.urlopen", lambda *_args, **_kwargs: response)

    with pytest.raises(RuntimeError, match="exceeds 5 bytes"):
        _ = get_json("https://modal.example/status", max_bytes=5)

    assert response.read_sizes == [6]


def test_put_file_streams_body_with_content_length(monkeypatch, tmp_path: Path) -> None:
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
        seen["timeout"] = timeout
        seen["method"] = req.get_method()
        seen["content_type"] = req.get_header("Content-type")
        seen["content_length"] = req.get_header("Content-length")
        seen["data_is_bytes"] = isinstance(req.data, bytes)
        seen["body"] = req.data.read()
        seen["closed_during_request"] = req.data.closed
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


def test_put_file_sends_streamed_body_to_http_server(tmp_path: Path) -> None:
    seen = {}

    class UploadHandler(BaseHTTPRequestHandler):
        def do_PUT(self):
            length = int(self.headers.get("Content-Length") or "0")
            seen["method"] = self.command
            seen["content_type"] = self.headers.get("Content-Type")
            seen["content_length"] = self.headers.get("Content-Length")
            seen["body"] = self.rfile.read(length)
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


def test_start_processing_payload_includes_projection_reconstruction_contract() -> None:
    assert start_processing_payload(
        "job123",
        "auto",
        "projection_set_reconstruction",
        "calibrated_projection_set",
        4096,
    ) == {
        "job_id": "job123",
        "modality": "auto",
        "processing_mode": "projection_set_reconstruction",
        "input_kind": "calibrated_projection_set",
        "total_upload_bytes": 4096,
    }


def test_start_processing_payload_includes_ultrasound_scan_conversion_contract() -> None:
    assert start_processing_payload(
        "job123",
        "auto",
        "ultrasound_scan_conversion",
        "calibrated_ultrasound_source",
        2048,
    ) == {
        "job_id": "job123",
        "modality": "auto",
        "processing_mode": "ultrasound_scan_conversion",
        "input_kind": "calibrated_ultrasound_source",
        "total_upload_bytes": 2048,
    }


def test_start_processing_payload_includes_registration_contract() -> None:
    assert start_processing_payload(
        "job123",
        "auto",
        "rigid_registration",
        "dicom_registration_pair",
        8192,
    ) == {
        "job_id": "job123",
        "modality": "auto",
        "processing_mode": "rigid_registration",
        "input_kind": "dicom_registration_pair",
        "total_upload_bytes": 8192,
    }


def test_normalize_series_entry_backfills_public_urls() -> None:
    entry = normalize_series_entry({"slug": "cloud_job123", "hasRaw": True}, "https://r2.example")

    assert entry == {
        "slug": "cloud_job123",
        "hasRaw": True,
        "sliceUrlBase": "https://r2.example/data/cloud_job123",
        "rawUrl": "https://r2.example/cloud_job123.raw.zst",
    }


def test_normalize_series_entry_backfills_region_urls() -> None:
    entry = normalize_series_entry({"slug": "cloud_job123", "hasRegions": True}, "https://r2.example")

    assert entry["regionUrlBase"] == "https://r2.example/data/cloud_job123_regions"
    assert entry["regionMetaUrl"] == "https://r2.example/data/cloud_job123_regions.json"


def test_validate_upload_url_rejects_untrusted_origin() -> None:
    with pytest.raises(RuntimeError, match="trusted origins"):
        _ = validate_upload_url("https://evil.example/upload", ["https://r2.example"])


def test_trusted_upload_origins_merge_r2_and_explicit_hosts() -> None:
    assert trusted_upload_origins("https://r2.example/base", ["https://upload.example", "https://r2.example"]) == [
        "https://r2.example",
        "https://upload.example",
    ]


def test_submit_requires_modal_base_when_config_and_env_are_blank(monkeypatch, tmp_path: Path) -> None:
    config = tmp_path / "config.json"
    _ = config.write_text('{"modalWebhookBase": "", "r2PublicUrl": ""}')
    args = type("Args", (), {
        "config": config,
        "modal_base": "",
        "r2_public_url": "",
        "trusted_upload_origin": [],
        "source": tmp_path,
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
    })()

    monkeypatch.delenv("MODAL_WEBHOOK_BASE", raising=False)
    monkeypatch.delenv("MODAL_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("R2_PUBLIC_URL", raising=False)
    monkeypatch.setattr("scripts.submit_modal_study.load_dotenv", lambda _path=None: {})
    with pytest.raises(SystemExit, match="missing MODAL_WEBHOOK_BASE"):
        _ = submit(args)


def test_submit_requires_modal_auth_token_when_base_exists(monkeypatch, tmp_path: Path) -> None:
    config = tmp_path / "config.json"
    _ = config.write_text('{"modalWebhookBase": "https://modal.example", "r2PublicUrl": ""}')
    args = type("Args", (), {
        "config": config,
        "modal_base": "",
        "r2_public_url": "",
        "trusted_upload_origin": [],
        "source": tmp_path,
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
    })()

    monkeypatch.delenv("MODAL_AUTH_TOKEN", raising=False)
    monkeypatch.setattr("scripts.submit_modal_study.load_dotenv", lambda _path=None: {})
    with pytest.raises(SystemExit, match="missing MODAL_AUTH_TOKEN"):
        _ = submit(args)


def test_submit_preflight_errors_validate_projection_sources(tmp_path: Path) -> None:
    _ = (tmp_path / "IM0001").write_bytes(b"x")

    errors = submit_preflight_errors(tmp_path, "projection_set_reconstruction", False)

    assert any("missing calibration manifest" in error for error in errors)


def test_submit_skips_advanced_preflight_when_skip_upload(tmp_path: Path) -> None:
    assert submit_preflight_errors(tmp_path, "projection_set_reconstruction", True) == []


def test_submit_rejects_invalid_input_kind_before_network(monkeypatch, tmp_path: Path) -> None:
    config = tmp_path / "config.json"
    _ = config.write_text('{"modalWebhookBase": "https://modal.example", "r2PublicUrl": ""}')
    args = type("Args", (), {
        "config": config,
        "modal_base": "",
        "r2_public_url": "",
        "trusted_upload_origin": [],
        "source": tmp_path,
        "job_id": "job123",
        "modality": "auto",
        "processing_mode": "projection_set_reconstruction",
        "input_kind": "dicom_volume_stack",
        "skip_upload": True,
        "batch_size": 450,
        "upload_workers": 8,
        "progress_every": 25,
        "poll_seconds": 10,
        "max_wait_seconds": 1,
    })()

    monkeypatch.setattr("scripts.submit_modal_study.load_dotenv", lambda _path=None: {"MODAL_AUTH_TOKEN": "token"})
    with pytest.raises(SystemExit, match="projection_set_reconstruction requires --input-kind calibrated_projection_set"):
        _ = submit(args)


def test_submit_requires_trusted_upload_origin_before_upload(monkeypatch, tmp_path: Path) -> None:
    config = tmp_path / "config.json"
    _ = config.write_text('{"modalWebhookBase": "https://example-org--pipeline", "r2PublicUrl": ""}')
    source = tmp_path / "source"
    source.mkdir()
    _ = (source / "IM0001").write_bytes(b"d")
    args = type("Args", (), {
        "config": config,
        "modal_base": "",
        "r2_public_url": "",
        "trusted_upload_origin": [],
        "source": source,
        "job_id": "job123",
        "modality": "auto",
        "processing_mode": "standard",
        "input_kind": "",
        "skip_upload": False,
        "batch_size": 450,
        "upload_workers": 1,
        "progress_every": 25,
        "poll_seconds": 1,
        "max_wait_seconds": 5,
    })()
    network_calls = []

    def fake_post_json(*_args, **_kwargs) -> dict:
        network_calls.append(_args)
        raise AssertionError("network")

    monkeypatch.setattr("scripts.submit_modal_study.load_dotenv", lambda _path=None: {"MODAL_AUTH_TOKEN": "token"})
    monkeypatch.setattr("scripts.submit_modal_study.post_json", fake_post_json)

    with pytest.raises(SystemExit, match="missing trusted upload origin"):
        _ = submit(args)
    assert network_calls == []


def test_submit_caps_upload_batches_to_modal_contract(monkeypatch, tmp_path: Path) -> None:
    config = tmp_path / "config.json"
    _ = config.write_text('{"modalWebhookBase": "https://example-org--pipeline", "r2PublicUrl": "https://r2.example"}')
    source = tmp_path / "source"
    source.mkdir()
    for index in range(MAX_UPLOAD_ITEMS + 1):
        _ = (source / f"IM{index:06d}").write_bytes(b"d")
    args = type("Args", (), {
        "config": config,
        "modal_base": "",
        "r2_public_url": "",
        "trusted_upload_origin": [],
        "source": source,
        "job_id": "job123",
        "modality": "auto",
        "processing_mode": "standard",
        "input_kind": "",
        "skip_upload": False,
        "batch_size": MAX_UPLOAD_ITEMS + 99,
        "upload_workers": 1,
        "progress_every": 999,
        "poll_seconds": 1,
        "max_wait_seconds": 5,
    })()
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

    result = submit(args)

    assert upload_batch_lengths == [MAX_UPLOAD_ITEMS, 1]
    assert result["series_entry"]["sliceUrlBase"] == "https://r2.example/data/cloud_job123"


def test_submit_rejects_invalid_runtime_knobs_before_network(monkeypatch, tmp_path: Path) -> None:
    config = tmp_path / "config.json"
    _ = config.write_text('{"modalWebhookBase": "https://example-org--pipeline", "r2PublicUrl": ""}')
    args = type("Args", (), {
        "config": config,
        "modal_base": "",
        "r2_public_url": "",
        "trusted_upload_origin": [],
        "source": tmp_path,
        "job_id": "job123",
        "modality": "auto",
        "processing_mode": "standard",
        "input_kind": "",
        "skip_upload": True,
        "batch_size": 450,
        "upload_workers": 0,
        "progress_every": 25,
        "poll_seconds": 10,
        "max_wait_seconds": 5,
    })()
    network_calls = []

    def fake_post_json(*_args, **_kwargs) -> dict:
        network_calls.append(_args)
        raise AssertionError("network")

    monkeypatch.setattr("scripts.submit_modal_study.load_dotenv", lambda _path=None: {"MODAL_AUTH_TOKEN": "token"})
    monkeypatch.setattr("scripts.submit_modal_study.post_json", fake_post_json)

    with pytest.raises(SystemExit, match="--upload-workers must be at least 1"):
        _ = submit(args)

    args.upload_workers = 1
    args.progress_every = 0
    with pytest.raises(SystemExit, match="--progress-every must be at least 1"):
        _ = submit(args)

    args.progress_every = 1
    args.poll_seconds = 0
    with pytest.raises(SystemExit, match="--poll-seconds must be at least 1"):
        _ = submit(args)

    args.poll_seconds = 1
    args.max_wait_seconds = 0
    with pytest.raises(SystemExit, match="--max-wait-seconds must be at least 1"):
        _ = submit(args)
    assert network_calls == []
