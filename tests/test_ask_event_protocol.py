from __future__ import annotations

import json
from pathlib import Path

import pytest

from ask_event_protocol import AskEventProtocolError, normalize_ask_event, version_ask_event


FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "contract" / "ask-events-v1.json").read_text(encoding="utf-8")
)


def test_ask_event_v1_fixture_valid_cases_match_python_normalizer() -> None:
    for item in FIXTURE["valid"]:
        assert normalize_ask_event(item["input"]) == item["input"], item["id"]


def test_ask_event_v1_fixture_invalid_cases_have_shared_reasons() -> None:
    for item in FIXTURE["invalid"]:
        with pytest.raises(AskEventProtocolError) as exc_info:
            _ = normalize_ask_event(item["input"])
        assert exc_info.value.reason == item["reason"], item["id"]


def test_emitter_versions_every_current_ask_event_variant() -> None:
    for item in FIXTURE["valid"]:
        unversioned = {
            key: value
            for key, value in item["input"].items()
            if key not in {"protocol", "version"}
        }
        assert version_ask_event(unversioned) == item["input"], item["id"]
