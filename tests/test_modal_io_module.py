from __future__ import annotations

import io
from pathlib import Path
import sys

import pytest

from modal_io import compress_raw_volume, download_r2_objects, get_r2_client, iter_r2_object_keys, upload_r2_files

class FakeS3:
    """R2 client double serving one listing page per configured page."""

    def __init__(self, pages: list[list[dict]], *, truncated: bool = False):
        self.pages = pages
        self.truncated = truncated
        self.listed_tokens: list[str | None] = []
        self.downloads: list[tuple[str, str]] = []
        self.uploads: list[tuple[str, str, str, str]] = []

    def list_objects_v2(self, **kwargs):
        token = kwargs.get("ContinuationToken")
        self.listed_tokens.append(token)
        index = len(self.listed_tokens) - 1
        page = self.pages[min(index, len(self.pages) - 1)]
        response: dict = {"Contents": page}
        if index + 1 < len(self.pages) or self.truncated:
            response["IsTruncated"] = True
            response["NextContinuationToken"] = f"page-{index + 2}"
        return response

    def get_object(self, Bucket, Key, IfMatch):
        self.downloads.append((Key, IfMatch))
        payload = f"{Bucket}:{Key}".encode()
        return {"Body": io.BytesIO(payload), "ContentLength": len(payload)}

    def upload_file(self, filename, bucket, key, ExtraArgs, Config):
        self.uploads.append((Path(filename).name, bucket, key, ExtraArgs["ContentType"]))

def object_entry(key: str, size: int | None = None, etag: str | None = None) -> dict:
    return {
        "Key": key,
        "Size": len(f"scan-data:{key}") if size is None else size,
        "ETag": f'"{etag or key}"',
    }

def test_explicit_empty_environment_does_not_fall_back_to_process_env(monkeypatch) -> None:
    monkeypatch.setenv("R2_ENDPOINT", "https://account.r2.cloudflarestorage.com")
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "process-access")
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "process-secret")

    with pytest.raises(ValueError, match="R2_ENDPOINT"):
        _ = get_r2_client({})

def test_object_listing_walks_every_page() -> None:
    s3 = FakeS3([
        [object_entry("uploads/job/a.dcm")],
        [object_entry("uploads/job/.DS_Store", size=0), object_entry("uploads/job/b.dcm")],
    ])

    assert list(iter_r2_object_keys(s3, "scan-data", "uploads/job/")) == [
        "uploads/job/a.dcm",
        "uploads/job/.DS_Store",
        "uploads/job/b.dcm",
    ]

def test_download_skips_hidden_entries_and_pins_each_object_to_its_etag(tmp_path: Path) -> None:
    s3 = FakeS3([
        [object_entry("uploads/job/a.dcm", etag="etag-a")],
        [object_entry("uploads/job/.DS_Store", size=0), object_entry("uploads/job/b.dcm", etag="etag-b")],
    ])

    assert download_r2_objects(s3, "scan-data", "uploads/job/", tmp_path, max_workers=2) == 2
    assert sorted(s3.downloads) == [
        ("uploads/job/a.dcm", '"etag-a"'),
        ("uploads/job/b.dcm", '"etag-b"'),
    ]
    assert sorted(path.name for path in tmp_path.iterdir()) == ["a.dcm", "b.dcm"]

def test_upload_preserves_the_requested_object_keys_and_content_types(tmp_path: Path) -> None:
    s3 = FakeS3([[]])
    _ = (tmp_path / "a.dcm").write_bytes(b"dicom")

    upload_r2_files(
        s3,
        "scan-data",
        [(tmp_path / "a.dcm", "data/cloud_job/0001.png", "image/png")],
        max_workers=0,
    )

    assert s3.uploads == [("a.dcm", "scan-data", "data/cloud_job/0001.png", "image/png")]

@pytest.mark.parametrize(
    ("contents", "limits", "reason"),
    [
        (
            [object_entry("uploads/job/a.dcm", size=1), object_entry("uploads/job/b.dcm", size=1)],
            {"max_files": 1},
            "file limit",
        ),
        ([object_entry("uploads/job/a.dcm", size=11)], {"max_total_bytes": 10}, "byte limit"),
    ],
    ids=["too-many-files", "too-many-bytes"],
)
def test_download_rejects_an_oversized_prefix_before_fetching_anything(
    tmp_path: Path, contents: list[dict], limits: dict, reason: str
) -> None:
    s3 = FakeS3([contents])

    with pytest.raises(ValueError, match=reason):
        _ = download_r2_objects(s3, "scan-data", "uploads/job/", tmp_path, max_workers=2, **limits)

    assert s3.downloads == []

def test_paginated_listing_stops_once_the_file_limit_is_exceeded(tmp_path: Path) -> None:
    s3 = FakeS3([[object_entry(f"uploads/job/{index}.dcm", size=1)] for index in range(9)], truncated=True)

    with pytest.raises(ValueError, match="file limit"):
        _ = download_r2_objects(s3, "scan-inputs", "uploads/job/", tmp_path, max_workers=1, max_files=2)

    assert len(s3.listed_tokens) == 3

def test_raw_volume_compression_streams_atomically_with_bounded_chunks(monkeypatch, tmp_path: Path) -> None:
    source = tmp_path / "volume.raw"
    destination = tmp_path / "volume.raw.zst"
    _ = source.write_bytes(b"voxel-bytes")
    seen = {}

    class Compressor:
        def __init__(self, **kwargs):
            seen["kwargs"] = kwargs

        def copy_stream(self, input_stream, output_stream, **kwargs):
            seen["stream"] = kwargs
            payload = input_stream.read()
            _ = output_stream.write(b"zstd:" + payload)
            return len(payload), len(payload) + 5

    monkeypatch.setitem(sys.modules, "zstandard", type("Zstandard", (), {"ZstdCompressor": Compressor}))

    compress_raw_volume(source, destination, max_input_bytes=1024)

    assert destination.read_bytes() == b"zstd:voxel-bytes"
    assert seen == {
        "kwargs": {"level": 19, "threads": 0},
        "stream": {"read_size": 1024 * 1024, "write_size": 1024 * 1024},
    }
    assert not (tmp_path / ".volume.raw.zst.part").exists()

def test_raw_volume_over_the_compression_limit_is_rejected_before_importing_zstandard(monkeypatch, tmp_path: Path) -> None:
    source = tmp_path / "volume.raw"
    destination = tmp_path / "volume.raw.zst"
    _ = source.write_bytes(b"0123456789")
    monkeypatch.delitem(sys.modules, "zstandard", raising=False)

    with pytest.raises(ValueError, match="compression limit"):
        compress_raw_volume(source, destination, max_input_bytes=9)

    assert not destination.exists()
