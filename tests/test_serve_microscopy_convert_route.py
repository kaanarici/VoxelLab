from __future__ import annotations

from pathlib import Path
import sys
import types

import pytest

import serve
from microscopy_convert import SUPPORTED_EXTENSIONS

from tests.helpers.python.serve_http import capture_stream_response, make_handler
from tests.helpers.python.streams import RecordingReader

def convert_handler(body: bytes = b"") -> tuple[serve.Handler, dict]:
    handler, captured = make_handler("/api/microscopy/convert", body=body)
    handler._enforce_rate_limit = lambda _path: None
    return handler, captured

def fake_converter(monkeypatch, **members) -> None:
    monkeypatch.setitem(sys.modules, "microscopy_convert", types.SimpleNamespace(**members))

def raising_converter(error: Exception):
    def convert(_input_path: str, _output_path: str):
        raise error

    return convert

def test_convert_route_offers_exactly_the_supported_reader_formats() -> None:
    assert serve.SUPPORTED_CONVERT_EXTENSIONS == SUPPORTED_EXTENSIONS

def test_upload_is_streamed_to_a_temporary_file_and_cleaned_up(monkeypatch) -> None:
    raw = b"0123456789"
    handler, captured = convert_handler()
    handler.rfile = RecordingReader(raw)
    writer = capture_stream_response(handler, captured)
    written_paths: dict[str, Path] = {}

    def convert(input_path: str, output_path: str):
        written_paths["input"] = Path(input_path)
        written_paths["output"] = Path(output_path)
        assert Path(input_path).read_bytes() == raw
        _ = Path(output_path).write_bytes(b"ome-tiff!!")
        return types.SimpleNamespace(
            output_path=output_path,
            warnings=["CZI contains 2 scenes; only the first scene was imported."],
        )

    monkeypatch.setattr(serve, "CONVERT_STREAM_CHUNK_BYTES", 4)
    fake_converter(monkeypatch, convert_to_ome_tiff_with_result=convert)

    handler._convert_microscopy_upload(".czi", len(raw))

    assert handler.rfile.read_sizes == [4, 4, 2]
    assert captured == {
        "headers": [
            ("Content-Type", "image/tiff"),
            ("X-VoxelLab-Convert-Warnings", '["CZI contains 2 scenes; only the first scene was imported."]'),
            ("Content-Length", "10"),
        ],
        "code": 200,
        "ended": True,
    }
    assert writer.write_sizes == [4, 4, 2]
    assert writer.getvalue() == b"ome-tiff!!"
    assert not written_paths["input"].exists()
    assert not written_paths["output"].exists()

def test_a_conversion_without_warnings_omits_the_warning_header(monkeypatch) -> None:
    raw = b"0123"
    handler, captured = convert_handler(raw)
    writer = capture_stream_response(handler, captured)

    def convert(_input_path: str, output_path: str):
        _ = Path(output_path).write_bytes(b"ome")
        return types.SimpleNamespace(output_path=output_path, warnings=[])

    fake_converter(monkeypatch, convert_to_ome_tiff_with_result=convert)

    handler._convert_microscopy_upload(".czi", len(raw))

    assert captured["headers"] == [("Content-Type", "image/tiff"), ("Content-Length", "3")]
    assert writer.getvalue() == b"ome"

def test_split_conversion_returns_every_scene_as_a_bounded_multipart_body(monkeypatch) -> None:
    raw = b"native-czi"
    handler, captured = convert_handler(raw)
    writer = capture_stream_response(handler, captured)
    written_paths: list[Path] = []

    def convert_parts(input_path: str, output_prefix: str, source_name: str):
        assert Path(input_path).read_bytes() == raw
        assert source_name == "sample.czi"
        results = []
        for index, value in enumerate((b"II*\x00scene-one", b"II*\x00scene-two"), start=1):
            output_path = Path(f"{output_prefix}.{index}")
            _ = output_path.write_bytes(value)
            written_paths.append(output_path)
            results.append(types.SimpleNamespace(
                output_path=str(output_path),
                warnings=[f"Scene {index} provenance"],
                part_id=f"czi-scene-{index - 1}",
                file_name=f"sample--scene-{index:03d}.ome.tiff",
            ))
        return results

    fake_converter(monkeypatch, convert_to_ome_tiff_parts=convert_parts)
    monkeypatch.setattr(serve, "CONVERT_STREAM_CHUNK_BYTES", 4)

    handler._convert_microscopy_upload(".czi", len(raw), split=True, source_name="sample.czi")

    headers = dict(captured["headers"])
    payload = writer.getvalue()
    assert captured["code"] == 200
    assert captured["ended"] is True
    assert headers["Content-Type"].startswith('multipart/mixed; boundary="voxellab-')
    assert headers["X-VoxelLab-Convert-Parts"] == "2"
    assert int(headers["Content-Length"]) == len(payload)
    assert payload.count(b"Content-Type: image/tiff") == 2
    assert b'filename="sample--scene-001.ome.tiff"' in payload
    assert b'filename="sample--scene-002.ome.tiff"' in payload
    assert b"X-VoxelLab-Convert-Part: czi-scene-0" in payload
    assert b"II*\x00scene-one" in payload and b"II*\x00scene-two" in payload
    assert all(not path.exists() for path in written_paths)

def test_split_conversion_of_a_single_unit_stays_a_plain_tiff(monkeypatch) -> None:
    raw = b"native-nd2"
    handler, captured = convert_handler(raw)
    writer = capture_stream_response(handler, captured)
    written_path: Path | None = None

    def convert_parts(_input_path: str, output_prefix: str, _source_name: str):
        nonlocal written_path
        written_path = Path(f"{output_prefix}.1")
        _ = written_path.write_bytes(b"II*\x00one-position")
        return [types.SimpleNamespace(
            output_path=str(written_path),
            warnings=["ND2 native position 1"],
            part_id="nd2-position-0",
            file_name="sample--position-001.ome.tiff",
        )]

    fake_converter(monkeypatch, convert_to_ome_tiff_parts=convert_parts)

    handler._convert_microscopy_upload(".nd2", len(raw), split=True, source_name="sample.nd2")

    assert captured["code"] == 200
    assert captured["headers"] == [
        ("Content-Type", "image/tiff"),
        ("Content-Disposition", 'attachment; filename="sample--position-001.ome.tiff"'),
        ("X-VoxelLab-Convert-Part", "nd2-position-0"),
        ("X-VoxelLab-Convert-Warnings", '["ND2 native position 1"]'),
        ("Content-Length", "16"),
    ]
    assert writer.getvalue() == b"II*\x00one-position"
    assert written_path is not None and not written_path.exists()

def test_a_body_shorter_than_content_length_is_rejected(monkeypatch) -> None:
    handler, captured = convert_handler(b"short")
    monkeypatch.setattr(serve, "CONVERT_STREAM_CHUNK_BYTES", 4)
    fake_converter(
        monkeypatch,
        convert_to_ome_tiff_with_result=lambda _input_path, output_path: types.SimpleNamespace(
            output_path=output_path,
            warnings=[],
        ),
    )

    handler._convert_microscopy_upload(".czi", 6)

    assert captured["code"] == 400
    assert "Content-Length" in captured["body"]["error"]

@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (
            type("MissingConverter", (ImportError,), {"reason": "converter_path_missing"})(
                "VOXELLAB_BFCONVERT path does not exist"
            ),
            {
                "code": 501,
                "body": {
                    "error": "microscopy converter path does not exist",
                    "reason": "converter_path_missing",
                },
            },
        ),
        (
            type("FailedConverter", (RuntimeError,), {"reason": "external_process_failure"})(
                "token=super-secret /Users/alice/private/input.czi"
            ),
            {
                "code": 500,
                "body": {
                    "error": "external microscopy converter failed",
                    "reason": "external_process_failure",
                },
            },
        ),
    ],
    ids=["converter-missing", "external-process-failed"],
)
def test_converter_failures_return_a_stable_reason_without_local_detail(monkeypatch, error: Exception, expected: dict) -> None:
    handler, captured = convert_handler(b"input")
    fake_converter(monkeypatch, convert_to_ome_tiff_with_result=raising_converter(error))

    handler._convert_microscopy_upload(".czi", 5)

    assert captured == expected
    assert "super-secret" not in str(captured)
    assert "/Users/alice" not in str(captured)

def test_an_unsupported_format_is_rejected_with_a_stable_reason() -> None:
    handler, captured = convert_handler()

    serve._microscopy_routes.handle_convert_post(handler, {"name": ["cells.png"]}, SUPPORTED_EXTENSIONS, 1024)

    assert captured == {
        "code": 400,
        "body": {"error": "unsupported microscopy format", "reason": "unsupported_format"},
    }

def test_split_mode_is_opt_in_per_request() -> None:
    calls = []
    for query in ({"name": ["cells.czi"], "mode": ["split"]}, {"name": ["cells.czi"]}):
        handler, _captured = make_handler(
            "/api/microscopy/convert",
            headers={"Content-Length": "5"},
            body=b"input",
        )
        handler._enforce_rate_limit = lambda _path: None
        handler._convert_microscopy_upload = lambda ext, length, **kwargs: calls.append((ext, length, kwargs))
        serve._microscopy_routes.handle_convert_post(handler, query, SUPPORTED_EXTENSIONS, 1024)

    assert calls == [
        (".czi", 5, {"split": True, "source_name": "cells.czi"}),
        (".czi", 5, {"split": False, "source_name": "cells.czi"}),
    ]
