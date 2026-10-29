from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from cloud_series import apply_public_series_urls
from series_contract import GEOMETRY_CAPABILITY, validate_manifest_data, validate_series

FIXTURES = Path(__file__).parent / "fixtures" / "contract"

def load_fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text())

GEOMETRY_CASES = load_fixture("geometry-kinds.json")["cases"]
PUBLIC_URL_CASES = load_fixture("public-series-urls.json")["cases"]

def test_every_shared_geometry_kind_has_a_python_capability() -> None:
    assert GEOMETRY_CAPABILITY == {case["kind"]: case["capability"] for case in GEOMETRY_CASES}

@pytest.mark.parametrize("case", [pytest.param(case, id=case["kind"]) for case in GEOMETRY_CASES])
def test_each_shared_geometry_case_validates_with_its_declared_capability(case: dict) -> None:
    series = case["series"]

    assert series["geometryKind"] == case["kind"]
    assert series["reconstructionCapability"] == case["capability"]
    assert series["renderability"] == case["renderability"]
    assert validate_series(series, 0) == []

def test_a_microscopy_stack_validates_as_a_whole_manifest() -> None:
    microscopy_series = next(case["series"] for case in GEOMETRY_CASES if case["kind"] == "microscopyStack")

    assert validate_manifest_data({
        "patient": "fixture",
        "studyDate": "2026-06-12",
        "series": [microscopy_series],
    }) == []

@pytest.mark.parametrize(
    "case",
    [pytest.param(case, id=case.get("id", case["input"].get("slug", "case"))) for case in PUBLIC_URL_CASES],
)
def test_public_series_urls_are_backfilled_exactly_as_the_shared_fixture_expects(case: dict) -> None:
    assert apply_public_series_urls(case["input"], case["publicBase"]) == case["expected"]
