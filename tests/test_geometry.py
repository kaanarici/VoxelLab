from __future__ import annotations

import json
from pathlib import Path

import pytest

from geometry import (
    affine_lps_from_series,
    build_geometry_record,
    classify_geometry_kind,
    compare_group_key,
    cross3,
    dot3,
    is_orthonormal_image_plane,
    norm3,
    normalize3,
    ipp_projection,
    slice_axis_alignment_from_series,
    slice_normal_from_iop,
    sort_datasets_spatially,
    spacing_from_positions,
)

CONTRACT = json.loads(
    (Path(__file__).parent / "fixtures" / "geometry" / "canonical-cases.json").read_text()
)["sharedContract"]

class FakeDicom:
    def __init__(self, **meta):
        for key, value in meta.items():
            setattr(self, key, value)

def cases(name: str) -> list:
    """Shared geometry cases, reported one test per case."""
    return [pytest.param(case, id=f"{name}-{index}") for index, case in enumerate(CONTRACT[name])]

def approx(actual: float, expected: float, tol: float = 1e-6) -> None:
    assert abs(actual - expected) < tol, f"{actual} != {expected}"

def approx_list(actual: list[float], expected: list[float], tol: float = 1e-6) -> None:
    assert len(actual) == len(expected)
    for index, value in enumerate(actual):
        approx(value, expected[index], tol)

def approx_matrix(actual: list[list[float]], expected: list[list[float]], tol: float = 1e-6) -> None:
    for row in range(len(expected)):
        for column in range(len(expected[row])):
            approx(actual[row][column], expected[row][column], tol)

@pytest.mark.parametrize("case", cases("dot3"))
def test_dot3_matches_the_shared_contract(case: dict) -> None:
    assert dot3(case["a"], case["b"]) == case["expected"]

@pytest.mark.parametrize("case", cases("cross3"))
def test_cross3_matches_the_shared_contract(case: dict) -> None:
    assert cross3(case["a"], case["b"]) == case["expected"]

@pytest.mark.parametrize("case", cases("norm3"))
def test_norm3_matches_the_shared_contract(case: dict) -> None:
    approx(norm3(case["v"]), case["expected"])

@pytest.mark.parametrize("case", cases("normalize3"))
def test_normalize3_matches_the_shared_contract(case: dict) -> None:
    approx_list(normalize3(case["v"]), case["expected"])

@pytest.mark.parametrize("case", cases("sliceNormalFromIOP"))
def test_slice_normals_match_the_shared_contract(case: dict) -> None:
    approx_list(slice_normal_from_iop(case["iop"]), case["expected"])

@pytest.mark.parametrize("case", cases("sliceAxisAlignmentFromSeries"))
def test_slice_axis_alignment_matches_the_shared_contract(case: dict) -> None:
    approx(slice_axis_alignment_from_series(case["series"]), case["expected"])

@pytest.mark.parametrize("case", cases("projectionAlongNormal"))
def test_patient_space_projection_matches_the_shared_contract(case: dict) -> None:
    approx(ipp_projection(FakeDicom(**case["meta"]), case["normal"]), case["expected"])

@pytest.mark.parametrize("case", cases("sortDatasetsSpatially"))
def test_spatial_sorting_matches_the_shared_contract(case: dict) -> None:
    datasets = [FakeDicom(**item) for item in case["datasets"]]

    sorted_datasets = sort_datasets_spatially(datasets)

    assert [item.InstanceNumber for item in sorted_datasets] == case["expectedInstanceOrder"]

@pytest.mark.parametrize("case", cases("sliceSpacingStatsFromPositions"))
def test_slice_spacing_statistics_match_the_shared_contract(case: dict) -> None:
    assert spacing_from_positions(case["positions"], case["normal"]) == case["expected"]

@pytest.mark.parametrize("case", cases("classifyGeometryKind"))
def test_geometry_kind_classification_matches_the_shared_contract(case: dict) -> None:
    assert classify_geometry_kind(case["spacingStats"], case["sliceCount"]) == case["expected"]

@pytest.mark.parametrize("case", cases("affineLpsFromSeries"))
def test_patient_space_affines_match_the_shared_contract(case: dict) -> None:
    approx_matrix(affine_lps_from_series(case["series"]), case["expected"])

@pytest.mark.parametrize("case", cases("compareGroup"))
def test_compare_group_keys_match_the_shared_contract(case: dict) -> None:
    result = compare_group_key(case["series"])

    if "expected" in case:
        assert result == case["expected"]
    else:
        assert result.startswith(case["expectedPrefix"])

@pytest.mark.parametrize("case", cases("isOrthonormalImagePlane"))
def test_image_plane_orthonormality_matches_the_shared_contract(case: dict) -> None:
    assert is_orthonormal_image_plane(case["iop"]) is case["expected"]

@pytest.mark.parametrize("case", cases("buildGeometryRecord"))
def test_geometry_records_match_the_shared_contract(case: dict) -> None:
    slices = [FakeDicom(**meta) for meta in case["input"]["metas"]]
    expected = case["expected"]

    record = build_geometry_record(
        slices,
        width=case["input"]["width"],
        height=case["input"]["height"],
        source=expected["source"],
    )

    assert record["kind"] == expected["kind"]
    assert record["dimensions"] == expected["dimensions"]
    approx(record["spacingMm"]["row"], expected["spacingMm"]["row"])
    approx(record["spacingMm"]["col"], expected["spacingMm"]["col"])
    approx(record["spacingMm"]["slice"], expected["spacingMm"]["slice"])
    assert record["sliceSpacingStatsMm"] == expected["sliceSpacingStatsMm"]
    assert record["slicePositionsDistinct"] == expected["slicePositionsDistinct"]
    assert record["orientation"] == expected["orientation"]
    assert record["firstIPP"] == expected["firstIPP"]
    assert record["lastIPP"] == expected["lastIPP"]
    approx_matrix(record["affineLps"], expected["affineLps"])
    assert record["frameOfReferenceUID"] == expected["frameOfReferenceUID"]
    assert record["frameOfReferenceUIDConsistent"] == expected["frameOfReferenceUIDConsistent"]
    assert record["source"] == expected["source"]
