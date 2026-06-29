from __future__ import annotations

import os
import tempfile
import traceback


MAX_CONVERT_BODY_BYTES = 256 * 1024 * 1024
CONVERT_STREAM_CHUNK_BYTES = 1024 * 1024


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


def convert_microscopy_upload(handler, ext: str, length: int, write_request_body_to_temp, chunk_bytes: int) -> None:
    in_path = out_path = None
    try:
        from microscopy_convert import convert_to_ome_tiff
        in_path = write_request_body_to_temp(ext, length)
        out_path = f"{in_path}.ome.tiff"
        _ = convert_to_ome_tiff(in_path, out_path)
        with open(out_path, "rb") as fout:
            handler.send_response(200)
            handler.send_header("Content-Type", "image/tiff")
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
        handler._json(501, {"error": str(exc) or "microscopy converter unavailable"})
    except ValueError as exc:
        handler._json(400, {"error": str(exc)})
    except Exception as exc:
        traceback.print_exc()
        handler._json(500, {"error": f"conversion failed: {exc}"})
    finally:
        for path in (in_path, out_path):
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
    ext = os.path.splitext((qs.get("name") or [""])[0])[1].lower()
    if ext not in supported_extensions:
        handler._json(400, {"error": "unsupported microscopy format"})
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
    handler._convert_microscopy_upload(ext, length)
