from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from cloud_series import apply_public_series_urls
from series_contract import GEOMETRY_CAPABILITY, validate_manifest_data, validate_series

FIXTURES = Path(__file__).parent / "fixtures" / "contract"


def load_fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text())


def test_geometry_kind_fixture_matches_python_contract() -> None:
    fixture = load_fixture("geometry-kinds.json")
    expected = {item["kind"]: item["capability"] for item in fixture["cases"]}

    assert GEOMETRY_CAPABILITY == expected
    for item in fixture["cases"]:
        series = item["series"]
        assert series["geometryKind"] == item["kind"]
        assert series["reconstructionCapability"] == item["capability"]
        assert series["renderability"] == item["renderability"]
        assert validate_series(series, 0) == []


def test_microscopy_stack_manifest_validates() -> None:
    fixture = load_fixture("geometry-kinds.json")
    microscopy_series = next(item["series"] for item in fixture["cases"] if item["kind"] == "microscopyStack")

    assert validate_manifest_data({"patient": "fixture", "studyDate": "2026-06-12", "series": [microscopy_series]}) == []


def test_public_series_url_fixture_matches_python_backfill_implementation() -> None:
    fixture = load_fixture("public-series-urls.json")

    for item in fixture["cases"]:
        assert apply_public_series_urls(item["input"], item["publicBase"]) == item["expected"]
