"""Shared Modal processing contract for cloud jobs and submitters."""

from __future__ import annotations

from urllib.parse import urlparse

# Maps a logical webhook name to its Modal function URL suffix. The browser
# (js/cloud.js MODAL_FUNCTIONS) mirrors this by necessity; keep them in sync.
MODAL_FUNCTIONS = {
    "get_upload_urls": "get-upload-urls",
    "start_processing": "start-processing",
    "check_status": "check-status",
}


def modal_endpoint(base: str, function_name: str) -> str:
    """Resolve a Modal function URL from any sibling webhook base, swapping the
    trailing `-<suffix>.modal.run` for the requested function's suffix."""
    suffix = MODAL_FUNCTIONS[function_name]
    raw = base.rstrip("/")
    host = urlparse(raw).netloc or urlparse(raw).path
    if host.endswith(".modal.run"):
        host = host.removesuffix(".modal.run")
    for known in MODAL_FUNCTIONS.values():
        if host.endswith(f"-{known}"):
            host = host[: -(len(known) + 1)]
            break
    return f"https://{host}-{suffix}.modal.run"


PROCESSING_MODE_DEFAULT_INPUT_KIND = {
    "standard": "dicom_volume_stack",
    "projection_set_reconstruction": "calibrated_projection_set",
    "ultrasound_scan_conversion": "calibrated_ultrasound_source",
}
PROCESSING_MODES = tuple(PROCESSING_MODE_DEFAULT_INPUT_KIND.keys())
INPUT_KINDS = tuple(dict.fromkeys(PROCESSING_MODE_DEFAULT_INPUT_KIND.values()))


def default_input_kind(processing_mode: str = "standard") -> str:
    return PROCESSING_MODE_DEFAULT_INPUT_KIND.get(processing_mode, "")


def validate_processing_mode(mode: object) -> str:
    """Return a supported processing mode or an empty string when invalid."""
    if mode in {None, ""}:
        return "standard"
    if not isinstance(mode, str) or mode not in PROCESSING_MODE_DEFAULT_INPUT_KIND:
        return ""
    return mode


def validate_input_kind(kind: object, processing_mode: str = "standard") -> str:
    """Return the input kind expected by the selected processing mode."""
    default = default_input_kind(processing_mode)
    if kind in {None, ""}:
        return default
    if not isinstance(kind, str) or kind not in INPUT_KINDS:
        return ""
    return kind
