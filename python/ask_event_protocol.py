"""Versioned Ask stream event contract."""

from __future__ import annotations

from typing import Any, NoReturn

from ask_envelopes import EnvelopeValidationError, normalize_ask_result

ASK_EVENT_PROTOCOL = "voxellab.ask-event"
ASK_EVENT_VERSION = 1
BASE_FIELDS = {"protocol", "version", "type"}
TOOL_KINDS = {"read", "inspect", "measure", "voxel", "other"}
TOOL_STATES = {"running", "done", "error"}


class AskEventProtocolError(ValueError):
    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(f"ask-event:{reason}")


def _fail(reason: str) -> NoReturn:
    raise AskEventProtocolError(reason)


def _object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail("not_object")
    return value


def _allowed(payload: dict[str, Any], allowed: set[str]) -> None:
    for key in payload:
        if key not in allowed:
            _fail(f"unexpected_field:{key}")


def _string(payload: dict[str, Any], key: str, *, allow_empty: bool = False) -> str:
    if key not in payload:
        _fail(f"{key}_missing")
    value = payload[key]
    if not isinstance(value, str):
        _fail(f"{key}_not_string")
    if not allow_empty and not value:
        _fail(f"{key}_empty")
    return value


def normalize_ask_event(value: Any) -> dict[str, Any]:
    payload = _object(value)
    protocol = _string(payload, "protocol")
    if protocol != ASK_EVENT_PROTOCOL:
        _fail("unsupported_protocol")
    if "version" not in payload:
        _fail("version_missing")
    version = payload["version"]
    if not isinstance(version, int) or isinstance(version, bool):
        _fail("version_not_integer")
    if version != ASK_EVENT_VERSION:
        _fail(f"unsupported_version:{version}")
    event_type = _string(payload, "type")
    base = {"protocol": protocol, "version": ASK_EVENT_VERSION, "type": event_type}

    if event_type == "phase":
        _allowed(payload, BASE_FIELDS | {"value"})
        phase = _string(payload, "value")
        if phase != "composing":
            _fail(f"unsupported_phase:{phase}")
        return {**base, "value": phase}
    if event_type == "tool":
        tool_id = _string(payload, "id")
        state = _string(payload, "state")
        if state not in TOOL_STATES:
            _fail(f"unsupported_tool_state:{state}")
        if state != "running":
            _allowed(payload, BASE_FIELDS | {"id", "state"})
            return {**base, "id": tool_id, "state": state}
        _allowed(payload, BASE_FIELDS | {"id", "state", "kind", "label", "detail"})
        kind = _string(payload, "kind")
        if kind not in TOOL_KINDS:
            _fail(f"unsupported_tool_kind:{kind}")
        return {
            **base,
            "id": tool_id,
            "state": state,
            "kind": kind,
            "label": _string(payload, "label"),
            "detail": _string(payload, "detail", allow_empty=True),
        }
    if event_type == "delta":
        _allowed(payload, BASE_FIELDS | {"text"})
        return {**base, "text": _string(payload, "text", allow_empty=True)}
    if event_type == "tool_output":
        _allowed(payload, BASE_FIELDS | {"id", "text"})
        return {
            **base,
            "id": _string(payload, "id"),
            "text": _string(payload, "text", allow_empty=True),
        }
    if event_type == "result":
        _allowed(payload, BASE_FIELDS | {"result"})
        try:
            result = normalize_ask_result(payload.get("result"))
        except EnvelopeValidationError as exc:
            _fail(f"result:{exc.reason}")
        return {**base, "result": result}
    if event_type == "error":
        _allowed(payload, BASE_FIELDS | {"error"})
        return {**base, "error": _string(payload, "error", allow_empty=True)}
    if event_type == "done":
        _allowed(payload, BASE_FIELDS)
        return base
    _fail(f"unsupported_type:{event_type}")


def version_ask_event(event: Any) -> dict[str, Any]:
    payload = _object(event)
    return normalize_ask_event({"protocol": ASK_EVENT_PROTOCOL, "version": ASK_EVENT_VERSION, **payload})
