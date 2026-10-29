"""Byte-stream doubles used to prove bounded reads and writes."""

from __future__ import annotations

import io

class RecordingReader(io.BytesIO):
    """Request/response body that records the size of every read."""

    def __init__(self, payload: bytes = b"") -> None:
        super().__init__(payload)
        self.read_sizes: list[int | None] = []

    def read(self, size: int | None = -1) -> bytes:
        self.read_sizes.append(size)
        return super().read(size)

class RecordingWriter(io.BytesIO):
    """Response body that records the size of every write."""

    def __init__(self) -> None:
        super().__init__()
        self.write_sizes: list[int] = []

    def write(self, data) -> int:
        self.write_sizes.append(len(data))
        return super().write(data)

class FakeHeaders(dict):
    """urllib-style header mapping with the content-type accessor callers use."""

    def __init__(self, values: dict[str, str] | None = None, content_type: str = "application/octet-stream") -> None:
        super().__init__(values or {})
        self.content_type = content_type

    def get_content_type(self) -> str:
        return self.content_type

class FakeHTTPResponse:
    """urlopen() double that records read sizes and works as a context manager."""

    def __init__(
        self,
        payload: bytes,
        *,
        status: int = 200,
        headers: dict[str, str] | None = None,
        content_type: str = "application/octet-stream",
    ) -> None:
        self.body = io.BytesIO(payload)
        self.status = status
        self.headers = FakeHeaders(headers, content_type)
        self.read_sizes: list[int] = []

    def __enter__(self) -> "FakeHTTPResponse":
        return self

    def __exit__(self, *_args) -> bool:
        return False

    def read(self, size: int = -1) -> bytes:
        self.read_sizes.append(size)
        return self.body.read(size)
