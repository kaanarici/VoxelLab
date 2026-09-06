from __future__ import annotations

import io
from pathlib import Path
import sys

from modal_io import compress_raw_volume, download_r2_objects, get_r2_client, iter_r2_object_keys, upload_r2_files

def test_modal_io_explicit_empty_environment_does_not_fall_back_to_process_env(monkeypatch) -> None:
    monkeypatch.setenv("R2_ENDPOINT", "https://account.r2.cloudflarestorage.com")
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "process-access")
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "process-secret")

    try:
        _ = get_r2_client({})
    except ValueError as error:
        assert "R2_ENDPOINT" in str(error)
    else:
        raise AssertionError("expected explicit empty environment to fail closed")

def test_modal_io_iter_and_transfer_helpers(tmp_path: Path):
    class FakeS3:
        def __init__(self):
            self.uploads = []
            self.download_conditions = []

        def list_objects_v2(self, **kwargs):
            if "ContinuationToken" not in kwargs:
                return {
                    "Contents": [{
                        "Key": "uploads/job/a.dcm",
                        "Size": len("scan-data:uploads/job/a.dcm"),
                        "ETag": '"etag-a"',
                    }],
                    "NextContinuationToken": "page-2",
                }
            return {
                "Contents": [
                    {"Key": "uploads/job/.DS_Store", "Size": 0, "ETag": '"etag-hidden"'},
                    {
                        "Key": "uploads/job/b.dcm",
                        "Size": len("scan-data:uploads/job/b.dcm"),
                        "ETag": '"etag-b"',
                    },
                ],
            }

        def get_object(self, Bucket, Key, IfMatch):
            assert IfMatch in {'"etag-a"', '"etag-b"'}
            self.download_conditions.append((Key, IfMatch))
            payload = f"{Bucket}:{Key}".encode()
            return {"Body": io.BytesIO(payload), "ContentLength": len(payload)}

        def upload_file(self, filename, bucket, key, ExtraArgs, Config):
            self.uploads.append((Path(filename).name, bucket, key, ExtraArgs["ContentType"]))

    s3 = FakeS3()
    assert list(iter_r2_object_keys(s3, "scan-data", "uploads/job/")) == [
        "uploads/job/a.dcm",
        "uploads/job/.DS_Store",
        "uploads/job/b.dcm",
    ]
    assert download_r2_objects(s3, "scan-data", "uploads/job/", tmp_path, max_workers=2) == 2
    assert sorted(s3.download_conditions) == [
        ("uploads/job/a.dcm", '"etag-a"'),
        ("uploads/job/b.dcm", '"etag-b"'),
    ]

    upload_r2_files(
        s3,
        "scan-data",
        [(tmp_path / "a.dcm", "data/cloud_job/0001.png", "image/png")],
        max_workers=0,
    )
    assert s3.uploads == [("a.dcm", "scan-data", "data/cloud_job/0001.png", "image/png")]

def test_modal_io_rejects_r2_prefix_before_download_when_actual_limits_are_exceeded(tmp_path: Path):
    class FakeS3:
        def __init__(self, objects):
            self.objects = objects
            self.downloads = 0

        def list_objects_v2(self, **_kwargs):
            return {"Contents": self.objects}

        def get_object(self, *_args, **_kwargs):
            self.downloads += 1

    too_many = FakeS3([
        {"Key": "uploads/job/a.dcm", "Size": 1, "ETag": '"a"'},
        {"Key": "uploads/job/b.dcm", "Size": 1, "ETag": '"b"'},
    ])
    try:
        _ = download_r2_objects(
            too_many,
            "scan-data",
            "uploads/job/",
            tmp_path,
            max_workers=2,
            max_files=1,
        )
    except ValueError as error:
        assert "file limit" in str(error)
    else:
        raise AssertionError("expected R2 file limit rejection")
    assert too_many.downloads == 0

    too_large = FakeS3([{"Key": "uploads/job/a.dcm", "Size": 11, "ETag": '"a"'}])
    try:
        _ = download_r2_objects(
            too_large,
            "scan-data",
            "uploads/job/",
            tmp_path,
            max_workers=2,
            max_total_bytes=10,
        )
    except ValueError as error:
        assert "byte limit" in str(error)
    else:
        raise AssertionError("expected R2 byte limit rejection")
    assert too_large.downloads == 0

def test_modal_io_stops_paginated_listing_at_file_limit(tmp_path: Path):
    class FakeS3:
        def __init__(self):
            self.pages = 0

        def list_objects_v2(self, **kwargs):
            self.pages += 1
            index = self.pages
            return {
                "Contents": [{"Key": f"uploads/job/{index}.dcm", "Size": 1, "ETag": f'"{index}"'}],
                "IsTruncated": True,
                "NextContinuationToken": f"page-{index + 1}",
            }

    s3 = FakeS3()
    try:
        _ = download_r2_objects(
            s3,
            "scan-inputs",
            "uploads/job/",
            tmp_path,
            max_workers=1,
            max_files=2,
        )
    except ValueError as error:
        assert "file limit" in str(error)
    else:
        raise AssertionError("expected paginated R2 listing limit rejection")
    assert s3.pages == 3

def test_modal_io_compresses_raw_volume_with_bounded_atomic_python_stream(monkeypatch, tmp_path: Path):
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

def test_modal_io_rejects_raw_volume_over_compression_limit_before_import(monkeypatch, tmp_path: Path):
    source = tmp_path / "volume.raw"
    destination = tmp_path / "volume.raw.zst"
    _ = source.write_bytes(b"0123456789")
    monkeypatch.delitem(sys.modules, "zstandard", raising=False)

    try:
        compress_raw_volume(source, destination, max_input_bytes=9)
    except ValueError as error:
        assert "compression limit" in str(error)
    else:
        raise AssertionError("expected raw compression bound rejection")
    assert not destination.exists()
