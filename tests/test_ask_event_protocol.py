from __future__ import annotations

import json
from pathlib import Path

import pytest

from ask_event_protocol import AskEventProtocolError, normalize_ask_event, version_ask_event

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "contract" / "ask-events-v1.json").read_text(encoding="utf-8")
)
VALID_CASES = [pytest.param(case, id=case["id"]) for case in FIXTURE["valid"]]
INVALID_CASES = [pytest.param(case, id=case["id"]) for case in FIXTURE["invalid"]]

@pytest.mark.parametrize("case", VALID_CASES)
def test_every_shared_valid_event_passes_the_python_normalizer(case: dict) -> None:
    assert normalize_ask_event(case["input"]) == case["input"]

@pytest.mark.parametrize("case", INVALID_CASES)
def test_every_shared_invalid_event_fails_with_the_shared_reason(case: dict) -> None:
    with pytest.raises(AskEventProtocolError) as exc_info:
        _ = normalize_ask_event(case["input"])

    assert exc_info.value.reason == case["reason"]

@pytest.mark.parametrize("case", VALID_CASES)
def test_the_emitter_versions_every_current_event_variant(case: dict) -> None:
    unversioned = {
        key: value
        for key, value in case["input"].items()
        if key not in {"protocol", "version"}
    }

    assert version_ask_event(unversioned) == case["input"]
