from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from ask_envelopes import EnvelopeValidationError, normalize_ask_result, normalize_consult_result

FIXTURE = Path(__file__).parent / "fixtures" / "contract" / "ask-envelopes.json"

NORMALIZERS: dict[str, Callable[[Any], dict[str, Any]]] = {
    "ask-result": normalize_ask_result,
    "consult-result": normalize_consult_result,
}


def load_fixture() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text())


def test_ask_consult_envelope_fixture_valid_cases_match_python_normalizers() -> None:
    fixture = load_fixture()

    for case in fixture["valid"]:
        assert NORMALIZERS[case["kind"]](case["input"]) == case["expected"], case["id"]


def test_ask_consult_envelope_fixture_invalid_cases_have_named_python_reasons() -> None:
    fixture = load_fixture()

    for case in fixture["invalid"]:
        with pytest.raises(EnvelopeValidationError) as excinfo:
            _ = NORMALIZERS[case["kind"]](case["input"])
        assert excinfo.value.envelope == case["kind"], case["id"]
        assert excinfo.value.reason == case["reason"], case["id"]
