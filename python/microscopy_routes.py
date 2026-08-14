from __future__ import annotations

import json
import os
import secrets
import tempfile
import traceback


MAX_CONVERT_BODY_BYTES = 256 * 1024 * 1024
CONVERT_STREAM_CHUNK_BYTES = 1024 * 1024
MAX_CONVERT_WARNING_COUNT = 16
MAX_CONVERT_WARNING_CHARS = 512


def _safe_conversion_error(reason: str, fallback: str) -> str:
    messages = {
        "converter_not_configured": "microscopy converter is not configured",
        "converter_path_not_absolute": "microscopy converter path must be absolute",
        "converter_path_missing": "microscopy converter path does not exist",
        "converter_path_not_executable": "microscopy converter path is not executable",
        "optional_python_reader_missing": "optional microscopy reader is not installed",
        "external_process_failure": "external microscopy converter failed",
        "unsupported_format": "unsupported microscopy format",
        "external_converter_multiscene_unsupported": "external microscopy converters do not support split-mode",
        "unsupported_multiseries_axis": "microscopy file contains an unsupported multi-series axis",
        "too_many_native_series": "microscopy file contains too many independent series",
        "conversion_resource_limit": "microscopy conversion exceeds the resource limit",
    }
    return messages.get(str(reason or ""), fallback)


def _bounded_warnings(warnings) -> list[str]:
    return [
        str(item).strip()[:MAX_CONVERT_WARNING_CHARS]
        for item in (warnings or [])
        if str(item).strip()
    ][:MAX_CONVERT_WARNING_COUNT]


def _warning_header(warnings) -> str:
    return json.dumps(_bounded_warnings(warnings), separators=(",", ":"))


def _write_response_bytes(handler, data: bytes) -> bool:
    try:
        _ = handler.wfile.write(data)
        return True
    except (BrokenPipeError, ConnectionResetError):
        return False


def _stream_file(handler, path: str, chunk_bytes: int) -> bool:
    with open(path, "rb") as source:
        while True:
            chunk = source.read(chunk_bytes)
            if not chunk:
                return True
            if not _write_response_bytes(handler, chunk):
                return False


def _multipart_preamble(boundary: str, result) -> bytes:
    lines = [
        f"--{boundary}",
        "Content-Type: image/tiff",
        f'Content-Disposition: attachment; filename="{result.file_name}"',
        f"X-VoxelLab-Convert-Part: {result.part_id}",
    ]
    warnings = _bounded_warnings(result.warnings)
    if warnings:
        lines.append(f"X-VoxelLab-Convert-Warnings: {_warning_header(warnings)}")
    return ("\r\n".join(lines) + "\r\n\r\n").encode("ascii")


def _multipart_content_length(results, boundary: str) -> int:
    closing_boundary = f"--{boundary}--\r\n".encode("ascii")
    return len(closing_boundary) + sum(
        len(_multipart_preamble(boundary, result)) + os.path.getsize(result.output_path) + 2
        for result in results
    )


def _stream_multipart(handler, results, boundary: str, chunk_bytes: int) -> None:
    for result in results:
        if not _write_response_bytes(handler, _multipart_preamble(boundary, result)):
            return
        if not _stream_file(handler, result.output_path, chunk_bytes):
            return
        if not _write_response_bytes(handler, b"\r\n"):
            return
    _ = _write_response_bytes(handler, f"--{boundary}--\r\n".encode("ascii"))


def write_request_body_to_temp(handler, ext: str, length: int, chunk_bytes: int) -> str:
    temp_path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as fin:
            temp_path = fin.name
            remaining = length
            while remaining > 0:
                chunk = handler.rfile.read(min(chunk_bytes, remaining))
                if not chunk:
                    raise ValueError("request body ended before Content-Length bytes were received")
                _ = fin.write(chunk)
                remaining -= len(chunk)
            return temp_path
    except Exception:
        if temp_path and os.path.exists(temp_path):
            os.unlink(temp_path)
        raise


def convert_microscopy_upload(
    handler,
    ext: str,
    length: int,
    write_request_body_to_temp,
    chunk_bytes: int,
    split: bool = False,
    source_name: str = "",
) -> None:
    in_path = out_path = None
    output_paths = []
    try:
        in_path = write_request_body_to_temp(ext, length)
        out_path = f"{in_path}.ome.tiff"
        if split:
            from microscopy_convert import convert_to_ome_tiff_parts
            results = convert_to_ome_tiff_parts(in_path, out_path, source_name)
            output_paths = [result.output_path for result in results]
            if len(results) == 1:
                result = results[0]
                handler.send_response(200)
                handler.send_header("Content-Type", "image/tiff")
                handler.send_header("Content-Disposition", f'attachment; filename="{result.file_name}"')
                handler.send_header("X-VoxelLab-Convert-Part", result.part_id)
                warnings = _bounded_warnings(result.warnings)
                if warnings:
                    handler.send_header("X-VoxelLab-Convert-Warnings", _warning_header(warnings))
                handler.send_header("Content-Length", str(os.path.getsize(result.output_path)))
                handler.end_headers()
                _ = _stream_file(handler, result.output_path, chunk_bytes)
                return
            boundary = f"voxellab-{secrets.token_hex(16)}"
            handler.send_response(200)
            handler.send_header("Content-Type", f'multipart/mixed; boundary="{boundary}"')
            handler.send_header("X-VoxelLab-Convert-Parts", str(len(results)))
            handler.send_header("Content-Length", str(_multipart_content_length(results, boundary)))
            handler.end_headers()
            _stream_multipart(handler, results, boundary, chunk_bytes)
            return
        from microscopy_convert import convert_to_ome_tiff_with_result
        result = convert_to_ome_tiff_with_result(in_path, out_path)
        with open(out_path, "rb") as fout:
            handler.send_response(200)
            handler.send_header("Content-Type", "image/tiff")
            warnings = [str(item) for item in (result.warnings or []) if str(item).strip()]
            if warnings:
                handler.send_header("X-VoxelLab-Convert-Warnings", json.dumps(warnings, separators=(",", ":")))
            handler.send_header("Content-Length", str(os.path.getsize(out_path)))
            handler.end_headers()
            while True:
                chunk = fout.read(chunk_bytes)
                if not chunk:
                    break
                try:
                    _ = handler.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
    except ImportError as exc:
        reason = str(getattr(exc, "reason", "converter_unavailable"))
        handler._json(501, {
            "error": _safe_conversion_error(reason, "microscopy converter unavailable"),
            "reason": reason,
        })
    except ValueError as exc:
        reason = str(getattr(exc, "reason", "invalid_input"))
        handler._json(400, {"error": _safe_conversion_error(reason, str(exc) or "invalid microscopy input"), "reason": reason})
    except Exception as exc:
        traceback.print_exc()
        reason = str(getattr(exc, "reason", "conversion_failed"))
        handler._json(500, {
            "error": _safe_conversion_error(reason, "microscopy conversion failed"),
            "reason": reason,
        })
    finally:
        for path in (in_path, out_path, *output_paths):
            if path and os.path.exists(path):
                try:
                    os.unlink(path)
                except OSError:
                    pass


def handle_convert_post(
    handler,
    qs: dict,
    supported_extensions,
    max_body_bytes: int,
) -> None:
    limited = handler._enforce_rate_limit("/api/microscopy/convert")
    if limited is not None:
        handler._json(*limited)
        return
    source_name = (qs.get("name") or [""])[0]
    ext = os.path.splitext(source_name)[1].lower()
    if ext not in supported_extensions:
        handler._json(400, {"error": "unsupported microscopy format", "reason": "unsupported_format"})
        return
    try:
        length = int(handler.headers.get("Content-Length") or 0)
    except ValueError:
        length = 0
    if length <= 0:
        handler._json(400, {"error": "empty body"})
        return
    if length > max_body_bytes:
        handler._json(413, {"error": "file too large"})
        return
    mode = str((qs.get("mode") or [""])[0]).strip().lower()
    if mode not in {"", "split"}:
        handler._json(400, {"error": "unsupported microscopy conversion mode", "reason": "unsupported_mode"})
        return
    handler._convert_microscopy_upload(ext, length, split=mode == "split", source_name=source_name)
