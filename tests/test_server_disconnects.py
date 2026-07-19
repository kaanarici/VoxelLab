from __future__ import annotations

import io

import serve


class DisconnectedWriter(io.BytesIO):
    def write(self, _data: object) -> int:
        raise BrokenPipeError("client disconnected")


def test_static_response_disconnect_does_not_escape_handler() -> None:
    handler = object.__new__(serve.Handler)

    handler.copyfile(io.BytesIO(b"response body"), DisconnectedWriter())
