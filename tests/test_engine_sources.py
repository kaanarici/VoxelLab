from __future__ import annotations

import pytest

from engine_sources import (
    normalize_source_manifest,
    projection_manifest_errors,
    projection_summary,
    registration_manifest_errors,
    registration_summary,
    ultrasound_summary,
)

from tests.helpers.python.manifests import projection_source, registration_source

def test_normalize_source_manifest_promotes_geometry_model_and_version() -> None:
    manifest = normalize_source_manifest(
        {
            "sourceKind": "projection",
            "seriesUID": "1.2.series",
            "projection": {
                "geometry": "parallel-beam-stack",
                "anglesDeg": [0, 90],
                "outputShape": [8, 8, 2],
                "outputSpacingMm": [1, 1, 1],
                "firstIPP": [0, 0, 0],
                "orientation": [1, 0, 0, 0, 1, 0],
                "frameOfReferenceUID": "1.2.for",
            },
        }
    )

    assert manifest["sourceRecordVersion"] == 1
    assert manifest["projection"]["geometryModel"] == "parallel-beam-stack"

def limited_angle_source(**projection) -> dict:
    return projection_source(series_uid="1.2.series", **{
        "geometryModel": "limited-angle-tomo",
        "anglesDeg": [0, 30],
        "outputShape": [8, 8, 2],
        "outputSpacingMm": [1, 1, 1],
        "firstIPP": [0, 0, 0],
        "orientation": [1, 0, 0, 0, 1, 0],
        **projection,
    })

def test_projection_manifest_errors_accepts_v2_geometry_model() -> None:
    assert projection_manifest_errors(limited_angle_source(), 2, "1.2.series") == []

def test_projection_and_ultrasound_summary_include_versioned_contract_fields() -> None:
    projection = projection_summary(
        {
            "sourceRecordVersion": 2,
            "sourceKind": "projection",
            "projection": {
                "geometryModel": "circular-cbct",
                "anglesDeg": [0, 45, 90],
            },
        }
    )
    ultrasound = ultrasound_summary(
        {
            "sourceRecordVersion": 2,
            "sourceKind": "ultrasound",
            "ultrasound": {
                "mode": "tracked-freehand-sector",
                "probeGeometry": "sector",
                "profileId": "tracked-freehand-sector-default",
            },
        }
    )

    assert projection["sourceRecordVersion"] == 2
    assert projection["geometry"] == "circular-cbct"
    assert ultrasound["sourceRecordVersion"] == 2
    assert ultrasound["profileId"] == "tracked-freehand-sector-default"

def test_registration_manifest_errors_accept_an_explicit_selected_pair() -> None:
    assert registration_manifest_errors(registration_source(), {"fixed", "moving"}) == []

def test_registration_manifest_errors_reject_a_self_pair_and_an_unsupported_transform() -> None:
    invalid = registration_source(moving="fixed", transform="affine")

    errors = registration_manifest_errors(invalid, {"fixed"})

    assert any("different series" in error for error in errors)
    assert any("transform" in error for error in errors)

def test_registration_summary_normalizes_transform_alias() -> None:
    summary = registration_summary({
        "sourceRecordVersion": 2,
        "sourceKind": "registration",
        "registration": {
            "fixedSeriesUID": "fixed",
            "movingSeriesUID": "moving",
            "transformType": "translation",
        },
    })

    assert summary == {
        "status": "configured",
        "transform": "translation",
        "fixedSeriesUID": "fixed",
        "movingSeriesUID": "moving",
        "source": "external-json",
        "sourceRecordVersion": 2,
    }

@pytest.mark.parametrize(
    "output_shape",
    [[8.5, "8", 2], [100000, 100000, 100000]],
    ids=["non-integer-dimensions", "unreconstructably-large"],
)
def test_manifest_output_shape_requires_real_ints_and_a_reasonable_volume_size(output_shape: list) -> None:
    errors = projection_manifest_errors(limited_angle_source(outputShape=output_shape), 2, "1.2.series")

    assert any("outputShape" in error for error in errors)
