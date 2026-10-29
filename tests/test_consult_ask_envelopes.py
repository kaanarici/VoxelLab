from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from ask_envelopes import EnvelopeValidationError, normalize_ask_result, normalize_consult_result

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "contract" / "ask-envelopes.json").read_text())
NORMALIZERS: dict[str, Callable[[Any], dict[str, Any]]] = {
    "ask-result": normalize_ask_result,
    "consult-result": normalize_consult_result,
}
VALID_CASES = [pytest.param(case, id=case["id"]) for case in FIXTURE["valid"]]
INVALID_CASES = [pytest.param(case, id=case["id"]) for case in FIXTURE["invalid"]]

@pytest.mark.parametrize("case", VALID_CASES)
def test_every_shared_valid_envelope_normalizes_to_the_shared_expectation(case: dict) -> None:
    assert NORMALIZERS[case["kind"]](case["input"]) == case["expected"]

@pytest.mark.parametrize("case", INVALID_CASES)
def test_every_shared_invalid_envelope_fails_with_the_shared_reason(case: dict) -> None:
    with pytest.raises(EnvelopeValidationError) as exc_info:
        _ = NORMALIZERS[case["kind"]](case["input"])

    assert exc_info.value.envelope == case["kind"]
    assert exc_info.value.reason == case["reason"]
