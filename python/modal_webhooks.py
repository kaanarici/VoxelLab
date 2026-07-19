from __future__ import annotations

import json
import traceback

from modal_validation import (
    auth_error,
    input_kind_error,
    normalize_upload_items,
    validate_presigned_upload_url,
    validate_total_upload_bytes,
    upload_object_name,
    validate_input_kind,
    validate_job_id,
    validate_modality,
    validate_processing_mode,
)

_context = {
    "bucket": "",
    "get_r2_client": None,
    "process_study": None,
    "upload_expiry_seconds": 3600,
    "max_upload_bytes": 2 * 1024 * 1024 * 1024,
}
MAX_RESULT_JSON_BYTES = 1024 * 1024


def configure_webhooks(
    *,
    bucket: str,
    get_r2_client,
    process_study,
    upload_expiry_seconds: int = 3600,
    max_upload_bytes: int = 2 * 1024 * 1024 * 1024,
) -> None:
    _context["bucket"] = bucket
    _context["get_r2_client"] = get_r2_client
    _context["process_study"] = process_study
    _context["upload_expiry_seconds"] = min(int(upload_expiry_seconds or 900), 900)
    _context["max_upload_bytes"] = max(int(max_upload_bytes or 0), 0)


def _status_not_found(exc: Exception) -> bool:
    code = getattr(exc, "response", {}).get("Error", {}).get("Code", "")
    status = getattr(exc, "response", {}).get("ResponseMetadata", {}).get("HTTPStatusCode")
    return isinstance(exc, KeyError) or code in {"404", "NoSuchKey", "NotFound"} or status == 404


def _precondition_failed(exc: Exception) -> bool:
    code = getattr(exc, "response", {}).get("Error", {}).get("Code", "")
    status = getattr(exc, "response", {}).get("ResponseMetadata", {}).get("HTTPStatusCode")
    return code in {"409", "412", "ConditionalRequestConflict", "PreconditionFailed"} or status in {409, 412}


def _read_result_json(body, label: str) -> dict:
    raw = body.read(MAX_RESULT_JSON_BYTES + 1)
    if len(raw) > MAX_RESULT_JSON_BYTES:
        raise ValueError(f"{label} JSON exceeds {MAX_RESULT_JSON_BYTES} bytes")
    return json.loads(raw)


def _existing_job_status(s3, key: str) -> tuple[dict, str]:
    resp = s3.get_object(Bucket=_context["bucket"], Key=key)
    if "Body" not in resp:
        raise RuntimeError("status response has no body")
    try:
        status = _read_result_json(resp["Body"], "status")
    except (json.JSONDecodeError, ValueError):
        status = {"status": "unknown"}
    return status, str(resp.get("ETag", "") or "").strip('"')


def _put_processing_claim(s3, key: str) -> str:
    response = s3.put_object(
        Bucket=_context["bucket"],
        Key=key,
        Body=json.dumps({"status": "processing"}),
        ContentType="application/json",
        IfNoneMatch="*",
    )
    return str((response or {}).get("ETag", "") or "").strip('"')


def _mark_dispatch_unknown(s3, key: str, claim_etag: str, detail: str) -> None:
    condition = {"IfMatch": claim_etag} if claim_etag else {}
    s3.put_object(
        Bucket=_context["bucket"],
        Key=key,
        Body=json.dumps({"status": "dispatch_unknown", "error": "spawn_failed", "detail": detail}),
        ContentType="application/json",
        **condition,
    )


def start_processing(item: dict) -> dict:
    job_id = validate_job_id(item.get("job_id", ""))
    modality = validate_modality(item.get("modality", "auto"))
    processing_mode = validate_processing_mode(item.get("processing_mode", "standard"))
    input_kind = validate_input_kind(item.get("input_kind", ""), processing_mode)
    total_upload_bytes = validate_total_upload_bytes(item.get("total_upload_bytes"))
    auth = auth_error(item.get("token", ""))
    if not job_id:
        return {"status": "error", "error": "invalid job_id"}
    if auth:
        return {"status": "error", "error": auth}
    if not modality:
        return {"status": "error", "error": "invalid modality"}
    if not processing_mode:
        return {"status": "error", "error": "invalid processing_mode"}
    if not input_kind:
        return {"status": "error", "error": input_kind_error(item.get("input_kind", ""), processing_mode)}
    if total_upload_bytes is None:
        return {"status": "error", "error": "invalid total_upload_bytes"}
    if _context["max_upload_bytes"] and total_upload_bytes > _context["max_upload_bytes"]:
        return {
            "status": "error",
            "error": f"total upload size exceeds limit ({_context['max_upload_bytes']} bytes)",
            "maxUploadBytes": _context["max_upload_bytes"],
        }
    s3 = _context["get_r2_client"]()
    key = f"results/{job_id}/status.json"
    claim_etag = ""
    try:
        claim_etag = _put_processing_claim(s3, key)
    except Exception as exc:
        if not _precondition_failed(exc):
            traceback.print_exc()
            return {"status": "error", "error": "claim_unavailable", "detail": str(exc)}
        try:
            existing, _existing_etag = _existing_job_status(s3, key)
        except Exception as read_exc:
            traceback.print_exc()
            error = "claim_missing" if _status_not_found(read_exc) else "claim_status_unavailable"
            return {"status": "error", "error": error, "detail": str(read_exc)}
        job_status = existing.get("status")
        if job_status == "dispatch_unknown":
            return {
                "status": "error",
                "error": "dispatch_unknown",
                "detail": str(existing.get("detail") or "processing dispatch could not be confirmed"),
                "retryable": False,
            }
        if job_status not in {"processing", "complete", "partial", "error"}:
            return {
                "status": "error",
                "error": "claim_status_invalid",
                "detail": f"existing claim has invalid status: {job_status}",
                "retryable": False,
            }
        return {
            "status": "started",
            "job_id": job_id,
            "jobStatus": job_status,
            "alreadyStarted": True,
        }
    try:
        _context["process_study"].spawn(job_id, modality, processing_mode, input_kind)
    except Exception as exc:
        traceback.print_exc()
        try:
            _mark_dispatch_unknown(s3, key, claim_etag, str(exc))
        except Exception as status_exc:
            traceback.print_exc()
            return {
                "status": "error",
                "error": "spawn_failed_status_unavailable",
                "detail": str(status_exc),
                "retryable": False,
            }
        return {"status": "error", "error": "dispatch_unknown", "detail": str(exc), "retryable": False}
    return {"status": "started", "job_id": job_id}


def check_status(item: dict) -> dict:
    job_id = validate_job_id(item.get("job_id", ""))
    auth = auth_error(item.get("token", ""))
    if not job_id:
        return {"status": "error", "error": "invalid job_id"}
    if auth:
        return {"status": "error", "error": auth}
    s3 = _context["get_r2_client"]()
    try:
        resp = s3.get_object(Bucket=_context["bucket"], Key=f"results/{job_id}/status.json")
        try:
            status = _read_result_json(resp["Body"], "status")
        except (json.JSONDecodeError, ValueError) as exc:
            traceback.print_exc()
            return {"status": "error", "error": "status_parse_failed", "detail": str(exc)}
        if status.get("status") in {"complete", "partial"}:
            try:
                result = s3.get_object(Bucket=_context["bucket"], Key=f"results/{job_id}/series.json")
                status["series_entry"] = _read_result_json(result["Body"], "series_entry")
            except (json.JSONDecodeError, ValueError) as exc:
                traceback.print_exc()
                return {"status": "error", "error": "series_entry_parse_failed", "detail": str(exc)}
            except Exception as exc:
                traceback.print_exc()
                return {"status": "error", "error": "series_entry_unavailable", "detail": str(exc)}
            try:
                projection = s3.get_object(Bucket=_context["bucket"], Key=f"results/{job_id}/projection_set.json")
                status["projection_set_entry"] = _read_result_json(projection["Body"], "projection_set_entry")
            except Exception:
                pass
        return status
    except Exception as exc:
        if _status_not_found(exc):
            return {"status": "processing"}
        traceback.print_exc()
        return {"status": "error", "error": "status_unavailable", "detail": str(exc)}


def get_upload_urls(item: dict) -> dict:
    job_id = validate_job_id(item.get("job_id", ""))
    auth = auth_error(item.get("token", ""))
    if not job_id:
        return {"status": "error", "error": "invalid job_id"}
    if auth:
        return {"status": "error", "error": auth}
    upload_items, error = normalize_upload_items(item)
    if error:
        return {"status": "error", "error": error}

    s3 = _context["get_r2_client"]()
    urls = {}
    for upload_item in upload_items:
        key = f"uploads/{job_id}/{upload_object_name(upload_item['upload_id'], upload_item['filename'])}"
        url = s3.generate_presigned_url(
            "put_object",
            Params={"Bucket": _context["bucket"], "Key": key, "ContentType": upload_item["content_type"]},
            ExpiresIn=_context["upload_expiry_seconds"],
        )
        if not validate_presigned_upload_url(url, max_seconds=900, fallback_seconds=_context["upload_expiry_seconds"]):
            return {"status": "error", "error": "upload URL expiry exceeds 15 minute limit"}
        urls[upload_item["upload_id"]] = url
    return {"urls": urls, "uploadExpirySeconds": _context["upload_expiry_seconds"]}
