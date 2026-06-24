from __future__ import annotations

import io
from pathlib import Path

import pytest

import compress_volumes


class TrackingStream(io.BytesIO):
    def __init__(self, payload: bytes):
        super().__init__(payload)
        self.read_sizes: list[int | None] = []

    def read(self, size: int | None = -1) -> bytes:
        self.read_sizes.append(size)
        return super().read(size)


class FakeProcess:
    def __init__(self, payload: bytes, *, stderr: bytes = b"", returncode: int = 0):
        self.stdout = TrackingStream(payload)
        self.stderr = io.BytesIO(stderr)
        self.returncode = returncode
        self.killed = False
        self.waited = False

    def wait(self) -> int:
        self.waited = True
        return self.returncode

    def poll(self) -> int | None:
        return self.returncode if self.waited else None

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9


def test_zstd_verify_streams_decompressed_output(monkeypatch, tmp_path: Path) -> None:
    src = tmp_path / "volume.raw"
    dst = tmp_path / "volume.raw.zst"
    payload = b"abcdefghijkl"
    _ = src.write_bytes(payload)
    _ = dst.write_bytes(b"compressed")
    proc = FakeProcess(payload)

    monkeypatch.setattr(compress_volumes, "VERIFY_CHUNK_BYTES", 4)
    monkeypatch.setattr(compress_volumes.subprocess, "Popen", lambda *_args, **_kwargs: proc)

    compress_volumes.zstd_verify(src, dst)

    assert proc.stdout.read_sizes == [4, 4, 4, 4]
    assert proc.killed is False


def test_zstd_verify_reports_first_streaming_diff(monkeypatch, tmp_path: Path) -> None:
    src = tmp_path / "volume.raw"
    dst = tmp_path / "volume.raw.zst"
    _ = src.write_bytes(b"abcdefghijkl")
    _ = dst.write_bytes(b"compressed")
    proc = FakeProcess(b"abcdEfghijkl")

    monkeypatch.setattr(compress_volumes, "VERIFY_CHUNK_BYTES", 4)
    monkeypatch.setattr(compress_volumes.subprocess, "Popen", lambda *_args, **_kwargs: proc)

    with pytest.raises(RuntimeError, match="first diff at offset 4"):
        compress_volumes.zstd_verify(src, dst)

    assert proc.killed is True


def test_zstd_verify_reports_decompress_failure(monkeypatch, tmp_path: Path) -> None:
    src = tmp_path / "volume.raw"
    dst = tmp_path / "volume.raw.zst"
    _ = src.write_bytes(b"abcd")
    _ = dst.write_bytes(b"compressed")
    proc = FakeProcess(b"", stderr=b"bad frame", returncode=3)

    monkeypatch.setattr(compress_volumes, "VERIFY_CHUNK_BYTES", 4)
    monkeypatch.setattr(compress_volumes.subprocess, "Popen", lambda *_args, **_kwargs: proc)

    with pytest.raises(RuntimeError, match="bad frame"):
        compress_volumes.zstd_verify(src, dst)

    assert proc.killed is False
