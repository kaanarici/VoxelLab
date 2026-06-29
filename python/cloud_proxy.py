from __future__ import annotations

import json
from urllib import request as urlrequest

from modal_contract import modal_endpoint


MAX_MODAL_JSON_BODY_BYTES = 1024 * 1024


def modal_cloud_base(overlay_env) -> str:
    return (overlay_env().get("MODAL_WEBHOOK_BASE") or "").strip()


def modal_auth_token(overlay_env) -> str:
    return (overlay_env().get("MODAL_AUTH_TOKEN") or "").strip()


def modal_proxy_available(modal_cloud_base, modal_auth_token) -> bool:
    return bool(modal_cloud_base() and modal_auth_token())


def proxy_modal_json(
    function_name: str,
    payload: dict,
    timeout: int,
    max_body_bytes: int,
    modal_cloud_base,
    modal_auth_token,
    urlopen,
) -> tuple[int, dict]:
    base = modal_cloud_base()
    token = modal_auth_token()
    if not base or not token:
        return 503, {"error": "cloud processing is not configured"}
    req = urlrequest.Request(
        modal_endpoint(base, function_name),
        data=json.dumps({**payload, "token": token}).encode(),
        method="POST",
    )
    req.add_header("Content-Type", "application/json")
    try:
        with urlopen(req, timeout=timeout) as response:
            raw = response.read(max_body_bytes + 1)
            if len(raw) > max_body_bytes:
                return 502, {"error": "modal response body too large"}
            return response.status, json.loads(raw.decode() or "{}")
    except urlrequest.HTTPError as exc:
        try:
            raw = exc.read(max_body_bytes + 1)
            if len(raw) > max_body_bytes:
                body = {"error": "modal error response body too large"}
            else:
                body = json.loads(raw.decode() or "{}")
        except Exception:
            body = {"error": str(exc)}
        return exc.code, body
    except Exception as exc:
        return 502, {"error": str(exc)}


def valid_cloud_upload_items(items) -> bool:
    if not isinstance(items, list) or not items:
        return False
    for item in items:
        if not isinstance(item, dict):
            return False
        upload_id = str(item.get("upload_id") or "").strip()
        filename = str(item.get("filename") or "").strip()
        if not upload_id or not filename:
            return False
    return True


def validate_cloud_proxy_payload(path: str, payload) -> tuple[int, dict] | None:
    if not isinstance(payload, dict):
        return 400, {"error": "expected JSON object body"}

    if path == "/api/cloud/get_upload_urls":
        if not valid_cloud_upload_items(payload.get("items")):
            return 400, {"error": "expected body {items:[{upload_id, filename}, ...]}"}
        return None

    job_id = str(payload.get("job_id") or "").strip()
    if not job_id:
        return 400, {"error": "missing job_id"}

    if path == "/api/cloud/start_processing":
        total_upload_bytes = payload.get("total_upload_bytes")
        if total_upload_bytes is not None:
            try:
                if int(total_upload_bytes) < 0:
                    raise ValueError()
            except (TypeError, ValueError):
                return 400, {"error": "total_upload_bytes must be a non-negative integer"}
    return None


def handle_cloud_post(handler, path: str, read_json_payload_or_error, validate_cloud_proxy_payload, proxy_modal_json) -> None:
    payload = read_json_payload_or_error()
    if payload is None:
        return
    invalid = validate_cloud_proxy_payload(path, payload)
    if invalid is not None:
        handler._json(*invalid)
        return
    timeout = 120 if path == "/api/cloud/start_processing" else 60
    function_name = path.rsplit("/", 1)[-1]
    code, body = proxy_modal_json(function_name, payload, timeout=timeout)
    handler._json(code, body)
