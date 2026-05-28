from __future__ import annotations

import json
from pathlib import Path

from geometry import (
    affine_lps_from_series,
    build_geometry_record,
    classify_geometry_kind,
    compare_group_key,
    cross3,
    dot3,
    norm3,
    normalize3,
    ipp_projection,
    slice_axis_alignment_from_series,
    slice_normal_from_iop,
    sort_datasets_spatially,
    spacing_from_positions,
)

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "geometry" / "canonical-cases.json").read_text())


class FakeDicom:
    def __init__(self, **meta):
        for key, value in meta.items():
            setattr(self, key, value)


def _approx(actual: float, expected: float, tol: float = 1e-6) -> None:
    assert abs(actual - expected) < tol, f"{actual} != {expected}"


def _approx_list(actual: list[float], expected: list[float], tol: float = 1e-6) -> None:
    assert len(actual) == len(expected)
    for index, value in enumerate(actual):
        _approx(value, expected[index], tol)


def _approx_matrix(actual: list[list[float]], expected: list[list[float]], tol: float = 1e-6) -> None:
    for r in range(len(expected)):
        for c in range(len(expected[r])):
            _approx(actual[r][c], expected[r][c], tol)


def _assert_geometry_record(actual: dict, expected: dict) -> None:
    assert actual["kind"] == expected["kind"]
    assert actual["dimensions"] == expected["dimensions"]
    _approx(actual["spacingMm"]["row"], expected["spacingMm"]["row"])
    _approx(actual["spacingMm"]["col"], expected["spacingMm"]["col"])
    _approx(actual["spacingMm"]["slice"], expected["spacingMm"]["slice"])
    assert actual["sliceSpacingStatsMm"] == expected["sliceSpacingStatsMm"]
    assert actual["slicePositionsDistinct"] == expected["slicePositionsDistinct"]
    assert actual["orientation"] == expected["orientation"]
    assert actual["firstIPP"] == expected["firstIPP"]
    assert actual["lastIPP"] == expected["lastIPP"]
    _approx_matrix(actual["affineLps"], expected["affineLps"])
    assert actual["frameOfReferenceUID"] == expected["frameOfReferenceUID"]
    assert actual["frameOfReferenceUIDConsistent"] == expected["frameOfReferenceUIDConsistent"]
    assert actual["source"] == expected["source"]


def test_geometry_contract_dot3() -> None:
    for case in FIXTURE["sharedContract"]["dot3"]:
        assert dot3(case["a"], case["b"]) == case["expected"]


def test_geometry_contract_cross3() -> None:
    for case in FIXTURE["sharedContract"]["cross3"]:
        assert cross3(case["a"], case["b"]) == case["expected"]


def test_geometry_contract_norm3_and_normalize3() -> None:
    for case in FIXTURE["sharedContract"]["norm3"]:
        _approx(norm3(case["v"]), case["expected"])
    for case in FIXTURE["sharedContract"]["normalize3"]:
        _approx_list(normalize3(case["v"]), case["expected"])


def test_geometry_contract_normals_projection_sorting_and_spacing() -> None:
    for case in FIXTURE["sharedContract"]["sliceNormalFromIOP"]:
        _approx_list(slice_normal_from_iop(case["iop"]), case["expected"])
    for case in FIXTURE["sharedContract"]["sliceAxisAlignmentFromSeries"]:
        _approx(slice_axis_alignment_from_series(case["series"]), case["expected"])
    for case in FIXTURE["sharedContract"]["projectionAlongNormal"]:
        _approx(ipp_projection(FakeDicom(**case["meta"]), case["normal"]), case["expected"])
    for case in FIXTURE["sharedContract"]["sortDatasetsSpatially"]:
        datasets = [FakeDicom(**item) for item in case["datasets"]]
        sorted_sets = sort_datasets_spatially(datasets)
        assert [item.InstanceNumber for item in sorted_sets] == case["expectedInstanceOrder"]
    for case in FIXTURE["sharedContract"]["sliceSpacingStatsFromPositions"]:
        assert spacing_from_positions(case["positions"], case["normal"]) == case["expected"]


def test_geometry_contract_kind_affine_and_compare_group() -> None:
    for case in FIXTURE["sharedContract"]["classifyGeometryKind"]:
        assert classify_geometry_kind(case["spacingStats"], case["sliceCount"]) == case["expected"]
    for case in FIXTURE["sharedContract"]["affineLpsFromSeries"]:
        _approx_matrix(affine_lps_from_series(case["series"]), case["expected"])
    for case in FIXTURE["sharedContract"]["compareGroup"]:
        result = compare_group_key(case["series"])
        if "expected" in case:
            assert result == case["expected"]
        else:
            assert result.startswith(case["expectedPrefix"])


def test_geometry_contract_build_geometry_record() -> None:
    for case in FIXTURE["sharedContract"]["buildGeometryRecord"]:
        slices = [FakeDicom(**meta) for meta in case["input"]["metas"]]
        record = build_geometry_record(
            slices,
            width=case["input"]["width"],
            height=case["input"]["height"],
            source=case["expected"]["source"],
        )

        _assert_geometry_record(record, case["expected"])
