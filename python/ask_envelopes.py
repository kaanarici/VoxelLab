"""Ask/consult envelope validators shared by producer tests."""

from __future__ import annotations

from typing import Any


class EnvelopeValidationError(ValueError):
    def __init__(self, envelope: str, reason: str) -> None:
        self.envelope = envelope
        self.reason = reason
        super().__init__(f"{envelope}:{reason}")


def _object(value: Any, envelope: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise EnvelopeValidationError(envelope, "not_object")
    return value


def _unexpected(payload: dict[str, Any], allowed: set[str], envelope: str) -> None:
    for key in payload:
        if key not in allowed:
            raise EnvelopeValidationError(envelope, f"unexpected_field:{key}")


def _string(payload: dict[str, Any], key: str, envelope: str, *, allow_empty: bool = False) -> str:
    if key not in payload:
        raise EnvelopeValidationError(envelope, f"{key}_missing")
    value = payload[key]
    if not isinstance(value, str):
        raise EnvelopeValidationError(envelope, f"{key}_not_string")
    if not allow_empty and not value:
        raise EnvelopeValidationError(envelope, f"{key}_empty")
    return value


def _bool(payload: dict[str, Any], key: str, envelope: str) -> bool:
    if key not in payload:
        raise EnvelopeValidationError(envelope, f"{key}_missing")
    value = payload[key]
    if not isinstance(value, bool):
        raise EnvelopeValidationError(envelope, f"{key}_not_boolean")
    return value


def _nonnegative_int(payload: dict[str, Any], key: str, envelope: str) -> int:
    if key not in payload:
        raise EnvelopeValidationError(envelope, f"{key}_missing")
    value = payload[key]
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise EnvelopeValidationError(envelope, f"{key}_not_nonnegative_integer")
    return value


def _region(payload: dict[str, Any], envelope: str) -> list[int] | None:
    if "region" not in payload:
        return None
    value = payload["region"]
    if not isinstance(value, list) or len(value) != 4:
        raise EnvelopeValidationError(envelope, "region_not_bounds")
    bounds = []
    for item in value:
        if not isinstance(item, int) or isinstance(item, bool) or item < 0:
            raise EnvelopeValidationError(envelope, "region_not_bounds")
        bounds.append(item)
    if bounds[0] > bounds[2] or bounds[1] > bounds[3]:
        raise EnvelopeValidationError(envelope, "region_inverted")
    return bounds


def _steps(payload: dict[str, Any], envelope: str) -> list[dict[str, str]] | None:
    """Optional self-reported agent actions: a list of {kind, label, detail}."""
    if "steps" not in payload:
        return None
    value = payload["steps"]
    if not isinstance(value, list):
        raise EnvelopeValidationError(envelope, "steps_not_array")
    steps: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            raise EnvelopeValidationError(envelope, "step_not_object")
        kind, label, detail = item.get("kind"), item.get("label"), item.get("detail", "")
        if not isinstance(kind, str) or not isinstance(label, str) or not isinstance(detail, str):
            raise EnvelopeValidationError(envelope, "step_field_not_string")
        steps.append({"kind": kind, "label": label, "detail": detail})
    return steps


def _normalize_ask_fields(payload: dict[str, Any], envelope: str) -> dict[str, Any]:
    normalized: dict[str, Any] = {
        "key": _string(payload, "key", envelope),
        "slice": _nonnegative_int(payload, "slice", envelope),
        "x": _nonnegative_int(payload, "x", envelope),
        "y": _nonnegative_int(payload, "y", envelope),
        "question": _string(payload, "question", envelope),
        "answer": _string(payload, "answer", envelope, allow_empty=True),
        "crop": _string(payload, "crop", envelope),
    }
    region = _region(payload, envelope)
    if region is not None:
        normalized["region"] = region
    if "contextFingerprint" in payload:
        normalized["contextFingerprint"] = _string(payload, "contextFingerprint", envelope)
    steps = _steps(payload, envelope)
    if steps is not None:
        normalized["steps"] = steps
    return normalized


def normalize_ask_entry(value: Any) -> dict[str, Any]:
    envelope = "ask-entry"
    payload = _object(value, envelope)
    _unexpected(payload, {"key", "slice", "x", "y", "question", "answer", "crop", "region", "contextFingerprint", "steps"}, envelope)
    return _normalize_ask_fields(payload, envelope)


def normalize_ask_result(value: Any) -> dict[str, Any]:
    envelope = "ask-result"
    payload = _object(value, envelope)
    _unexpected(
        payload,
        {"cached", "key", "slice", "x", "y", "question", "answer", "crop", "region", "contextFingerprint", "steps"},
        envelope,
    )
    entry_payload = {key: item_value for key, item_value in payload.items() if key != "cached"}
    return {"cached": _bool(payload, "cached", envelope), **_normalize_ask_fields(entry_payload, envelope)}


def _string_array(payload: dict[str, Any], key: str, envelope: str) -> list[str]:
    if key not in payload:
        raise EnvelopeValidationError(envelope, f"{key}_missing")
    value = payload[key]
    if not isinstance(value, list):
        raise EnvelopeValidationError(envelope, f"{key}_not_array")
    normalized = []
    for index, item in enumerate(value):
        if not isinstance(item, str):
            raise EnvelopeValidationError(envelope, f"{key}_{index}_not_string")
        normalized.append(item)
    return normalized


def _normalize_consult_fields(payload: dict[str, Any], envelope: str) -> dict[str, Any]:
    return {
        "disclaimer": _string(payload, "disclaimer", envelope),
        "provider": _string(payload, "provider", envelope),
        "model": _string(payload, "model", envelope),
        "impression": _string(payload, "impression", envelope, allow_empty=True),
        "ask_radiologist": _string_array(payload, "ask_radiologist", envelope),
        "limitations": _string(payload, "limitations", envelope, allow_empty=True),
    }


def normalize_consult_document(value: Any) -> dict[str, Any]:
    envelope = "consult-document"
    payload = _object(value, envelope)
    _unexpected(payload, {"disclaimer", "provider", "model", "impression", "ask_radiologist", "limitations"}, envelope)
    return _normalize_consult_fields(payload, envelope)


def normalize_consult_result(value: Any) -> dict[str, Any]:
    envelope = "consult-result"
    payload = _object(value, envelope)
    _unexpected(payload, {"cached", "disclaimer", "provider", "model", "impression", "ask_radiologist", "limitations"}, envelope)
    document_payload = {key: item_value for key, item_value in payload.items() if key != "cached"}
    return {"cached": _bool(payload, "cached", envelope), **_normalize_consult_fields(document_payload, envelope)}
