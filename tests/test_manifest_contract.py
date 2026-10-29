from __future__ import annotations

import copy
from pathlib import Path

import pytest

from scripts.check_manifest import load_json, validate_config_data, validate_manifest_data

FIXTURES = Path(__file__).parent / "fixtures" / "manifest"
MPR_GEOMETRY = {
    "firstIPP": [0, 0, 0],
    "lastIPP": [0, 0, 1],
    "orientation": [1, 0, 0, 0, 1, 0],
}
DISPLAY_VOLUME = {
    "geometryKind": "volumeStack",
    "reconstructionCapability": "display-volume",
    "renderability": "volume",
    **MPR_GEOMETRY,
}
PROJECTION_SET = {
    "id": "projection_set_1",
    "name": "Source CBCT",
    "sourceSeriesSlug": "sample_projection",
    "modality": "XA",
    "projectionKind": "cbct",
    "projectionCount": 2,
    "reconstructionCapability": "requires-reconstruction",
    "reconstructionStatus": "reconstructed",
    "renderability": "2d",
}

def fixture_manifest() -> dict:
    return load_json(FIXTURES / "valid_manifest.json")

def manifest_with(**series_overrides) -> dict:
    """The valid fixture manifest with its first series patched."""
    manifest = fixture_manifest()
    manifest["series"][0].update(series_overrides)
    return manifest

def source_series(**overrides) -> dict:
    series = {
        "slug": "source_series",
        "name": "Source Series",
        "description": "source",
        "slices": 2,
        "width": 32,
        "height": 32,
        "pixelSpacing": [1.0, 1.0],
        "sliceThickness": 1.0,
        "hasBrain": False,
        "hasSeg": False,
        "hasRaw": False,
    }
    series.update(overrides)
    return series

def binding(**overrides) -> dict:
    entry = {
        "derivedKind": "seg",
        "frameOfReferenceUID": "1.2.for",
        "sourceSeriesUID": "1.2.source",
        "requiresRegistration": False,
        "affineCompatibility": "exact",
    }
    entry.update(overrides)
    return entry

def test_the_fixture_manifest_is_valid() -> None:
    assert validate_manifest_data(fixture_manifest()) == []

def test_an_empty_public_export_manifest_is_valid() -> None:
    assert validate_manifest_data({"patient": "anonymous", "studyDate": "", "series": []}) == []

def test_a_series_missing_a_required_field_is_rejected() -> None:
    manifest = fixture_manifest()
    del manifest["series"][0]["pixelSpacing"]

    assert "series[0]: missing required field: pixelSpacing" in validate_manifest_data(manifest)

def test_duplicate_slugs_are_rejected() -> None:
    manifest = fixture_manifest()
    manifest["series"].append(copy.deepcopy(manifest["series"][0]))

    errors = validate_manifest_data(manifest)

    assert any("duplicate slug" in error and "sample" in error for error in errors)

def test_slice_counts_and_dimensions_must_be_positive_integers() -> None:
    errors = validate_manifest_data(manifest_with(slices=0, width="2"))

    assert "series[0].slices: expected positive integer" in errors
    assert "series[0].width: expected int" in errors

@pytest.mark.parametrize("group", [None, "for:1.2.840.123"], ids=["cloud-null-group", "frame-of-reference-group"])
def test_compare_groups_accept_null_and_string_keys(group) -> None:
    assert validate_manifest_data(manifest_with(group=group)) == []

def test_a_derived_volume_may_declare_full_mpr_geometry() -> None:
    manifest = manifest_with(**{
        **DISPLAY_VOLUME,
        "renderability": {"canView2D": True, "canMpr3D": True, "reason": ""},
    })
    derived = copy.deepcopy(manifest["series"][0])
    derived.update({
        "slug": "derived_cbct",
        "name": "Derived CBCT",
        "geometryKind": "derivedVolume",
        "renderability": "volume",
        "sourceProjectionSetId": "projection_set_1",
    })
    manifest["series"].append(derived)
    manifest["projectionSets"] = [{**PROJECTION_SET, "reconstructionStatus": "requires-reconstruction"}]

    assert validate_manifest_data(manifest) == []

@pytest.mark.parametrize(
    ("overrides", "error"),
    [
        (
            {"geometryKind": "projectionSet", "reconstructionCapability": "display-volume", "renderability": "volume"},
            "series[0].reconstructionCapability: expected requires-reconstruction for geometryKind projectionSet",
        ),
        (
            {
                "geometryKind": "singleProjection",
                "reconstructionCapability": "2d-only",
                "renderability": {"canView2D": True, "canMpr3D": True, "reason": ""},
            },
            "series[0].renderability.canMpr3D: expected false unless reconstructionCapability is display-volume",
        ),
        (
            {"geometryKind": "projectionSet", "renderability": "volume"},
            "series[0].renderability: expected 2d unless reconstructionCapability is display-volume",
        ),
    ],
    ids=["projection-claiming-volume", "projection-claiming-mpr", "inferred-projection-renderability"],
)
def test_projection_series_cannot_claim_volume_capabilities(overrides: dict, error: str) -> None:
    assert error in validate_manifest_data(manifest_with(**overrides))

@pytest.mark.parametrize(
    ("overrides", "error"),
    [
        (
            {
                "geometryKind": "volumeStack",
                "reconstructionCapability": "display-volume",
                "renderability": "volume",
            },
            "series[0]: display-volume MPR requires firstIPP, lastIPP, and orientation",
        ),
        (
            {**DISPLAY_VOLUME, "sliceSpacingRegular": False},
            "series[0].sliceSpacingRegular: display-volume series must have regular slice spacing",
        ),
        (
            {**DISPLAY_VOLUME, "frameOfReferenceUIDConsistent": False},
            "series[0].frameOfReferenceUIDConsistent: display-volume series must have one consistent FrameOfReferenceUID",
        ),
        (
            {**DISPLAY_VOLUME, "slicePositionsDistinct": False},
            "series[0].slicePositionsDistinct: display-volume series must have distinct patient-space slice positions",
        ),
        (
            {**DISPLAY_VOLUME, "lastIPP": [0, 10, 0]},
            "series[0].firstIPP/lastIPP: slice axis must align with orientation normal for accurate MPR",
        ),
    ],
    ids=[
        "missing-geometry",
        "irregular-spacing",
        "mixed-frame-of-reference",
        "duplicate-slice-positions",
        "slice-axis-off-normal",
    ],
)
def test_display_volume_requires_trustworthy_geometry(overrides: dict, error: str) -> None:
    assert error in validate_manifest_data(manifest_with(**overrides))

def test_a_derived_volume_may_reference_a_registered_projection_set() -> None:
    manifest = manifest_with(
        **MPR_GEOMETRY,
        geometryKind="derivedVolume",
        reconstructionCapability="display-volume",
        renderability="volume",
        sourceProjectionSetId="projection_set_1",
    )
    manifest["projectionSets"] = [{
        **PROJECTION_SET,
        "name": "DX projection pair",
        "sourceSeriesSlug": "sample",
        "modality": "DX",
        "projectionKind": "xray",
        "reconstructionStatus": "requires-calibration",
        "missingGeometry": ["projectionMatrices", "calibrationStatus"],
    }]

    assert validate_manifest_data(manifest) == []

@pytest.mark.parametrize("projection_kind", ["cbct", "parallel-beam"])
def test_supported_projection_kinds_validate(projection_kind: str) -> None:
    manifest = fixture_manifest()
    manifest["projectionSets"] = [{
        **PROJECTION_SET,
        "sourceSeriesSlug": "sample",
        "projectionKind": projection_kind,
    }]

    assert validate_manifest_data(manifest) == []

def test_a_calibrated_projection_set_and_ultrasound_source_validate() -> None:
    manifest = fixture_manifest()
    manifest["projectionSets"] = [{
        **PROJECTION_SET,
        "name": "CBCT sweep",
        "calibrationStatus": "calibrated",
        "projectionMatrices": [
            [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]],
            [[1, 0, 0, 1], [0, 1, 0, 0], [0, 0, 1, 0]],
        ],
        "detectorPixels": [16, 16],
        "detectorSpacingMm": [1.0, 1.0],
        "frameOfReferenceUID": "1.2.for",
    }]
    manifest["series"].append(source_series(
        slug="us_source",
        name="Calibrated US",
        modality="US",
        width=16,
        height=16,
        geometryKind="ultrasoundSource",
        reconstructionCapability="requires-reconstruction",
        renderability="2d",
        sourceSeriesUID="1.2.us.source",
        ultrasoundCalibration={
            "status": "calibrated",
            "mode": "stacked-sector",
            "probeGeometry": "sector",
            "source": "external-json",
        },
    ))

    assert validate_manifest_data(manifest) == []

def test_an_engine_report_must_name_a_backend_and_a_known_validation_level() -> None:
    assert validate_manifest_data(manifest_with(engineReport={
        "backend": "parallel-fbp",
        "geometryModel": "parallel-beam-stack",
        "validation": "prototype",
    })) == []

    errors = validate_manifest_data(manifest_with(engineReport={"backend": "", "validation": "fake"}))

    assert "series[0].engineReport.backend: expected non-empty string" in errors
    assert (
        "series[0].engineReport.validation: expected one of ['external-engine', 'prototype', 'reference-parity']"
        in errors
    )

def test_a_projection_registry_entry_must_stay_a_safe_reconstruction_source() -> None:
    manifest = manifest_with(sourceProjectionSetId="missing_projection_set")
    manifest["projectionSets"] = [{
        "id": "../bad",
        "name": "Bad",
        "modality": "DX",
        "projectionKind": "fake",
        "projectionCount": 0,
        "reconstructionCapability": "display-volume",
        "reconstructionStatus": "reconstructed",
        "renderability": "volume",
        "missingGeometry": ["projectionMatrices"],
    }]

    errors = validate_manifest_data(manifest)

    assert "projectionSets[0].id: expected safe projection set id" in errors
    assert (
        "projectionSets[0].projectionKind: expected one of ['cbct', 'parallel-beam', 'tomosynthesis', 'unknown', 'xray']"
        in errors
    )
    assert "projectionSets[0].reconstructionCapability: expected requires-reconstruction" in errors
    assert "projectionSets[0].renderability: expected 2d" in errors
    assert "projectionSets[0].projectionCount: expected positive integer" in errors
    assert "series[0].sourceProjectionSetId: unknown projection set id: missing_projection_set" in errors

def test_a_calibrated_projection_set_must_carry_its_detector_geometry() -> None:
    manifest = manifest_with(sourceProjectionSetId="projection_set_1")
    manifest["projectionSets"] = [{**PROJECTION_SET, "name": "Bad CBCT", "calibrationStatus": "calibrated"}]

    errors = validate_manifest_data(manifest)

    assert "projectionSets[0].projectionMatrices: calibrated sets require one matrix per projection" in errors
    assert "projectionSets[0].detectorPixels: calibrated sets require positive [rows, cols]" in errors
    assert "projectionSets[0].detectorSpacingMm: calibrated sets require positive [row, col] spacing" in errors

def test_a_series_cannot_reference_a_projection_set_without_a_registry() -> None:
    errors = validate_manifest_data(manifest_with(sourceProjectionSetId="projection_set_1"))

    assert "series[0].sourceProjectionSetId: projectionSets registry is required" in errors

def test_a_derived_binding_must_name_a_source_series_in_the_manifest() -> None:
    errors = validate_manifest_data(manifest_with(
        derivedObjectBindings=[binding(sourceSeriesUID="missing.source.series")],
    ))

    assert (
        "series[0].derivedObjectBindings[0].sourceSeriesUID: unknown sourceSeriesUID: missing.source.series"
        in errors
    )

@pytest.mark.parametrize(
    ("source_overrides", "binding_overrides"),
    [
        (
            {"slug": "sample_source", "name": "Source", "sourceSeriesUID": "1.2.source", "frameOfReferenceUID": "1.2.for"},
            {"sourceSeriesSlug": "sample_source"},
        ),
        (
            {"slug": "local_source", "name": "Source"},
            {
                "frameOfReferenceUID": "",
                "sourceSeriesSlug": "local_source",
                "requiresRegistration": True,
                "affineCompatibility": "requires-registration",
            },
        ),
    ],
    ids=["frame-of-reference-match", "slug-bound-local-import"],
)
def test_a_slug_bound_derived_binding_validates(source_overrides: dict, binding_overrides: dict) -> None:
    entry = binding(**binding_overrides)
    entry.pop("sourceSeriesUID", None)
    manifest = manifest_with(
        **MPR_GEOMETRY,
        sliceSpacingRegular=True,
        derivedObjectBindings=[entry],
    )
    manifest["series"].append(source_series(**{**MPR_GEOMETRY, **source_overrides}))

    assert validate_manifest_data(manifest) == []

def test_an_exact_binding_requires_a_matching_frame_of_reference() -> None:
    manifest = manifest_with(
        frameOfReferenceUID="1.2.derived",
        derivedObjectBindings=[binding(frameOfReferenceUID="1.2.derived")],
    )
    manifest["series"].append(source_series(sourceSeriesUID="1.2.source", frameOfReferenceUID="1.2.source.for"))

    errors = validate_manifest_data(manifest)

    assert (
        "series[0].derivedObjectBindings[0].affineCompatibility: exact/within-tolerance bindings require matching FrameOfReferenceUID"
        in errors
    )

def test_an_exact_binding_requires_trustworthy_geometry_on_both_series() -> None:
    manifest = manifest_with(frameOfReferenceUID="1.2.for", derivedObjectBindings=[binding()])
    manifest["series"].append(source_series(sourceSeriesUID="1.2.source", frameOfReferenceUID="1.2.for"))

    errors = validate_manifest_data(manifest)

    assert (
        "series[0].derivedObjectBindings[0].affineCompatibility: exact/within-tolerance bindings require trustworthy geometry on source and derived series"
        in errors
    )

def test_geometry_records_accept_a_consistent_cartesian_volume() -> None:
    assert validate_manifest_data(manifest_with(
        geometryRecordKind="cartesian_volume",
        sliceSpacingRegular=True,
        dimensions={"width": 256, "height": 256, "depth": 10},
        spacingMm={"row": 0.5, "col": 0.5, "slice": 1.0},
        sliceSpacingStatsMm={"mean": 1.0, "min": 1.0, "max": 1.0, "regular": True},
    )) == []

@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"geometryRecordKind": "magic_volume"}, "geometryRecordKind"),
        (
            {"geometryRecordKind": "cartesian_volume", "sliceSpacingRegular": False},
            "cartesian_volume requires regular slice spacing",
        ),
        ({"spacingMm": {"row": -0.5, "col": 0.5, "slice": 1.0}}, "spacingMm.row: expected positive number"),
    ],
    ids=["unknown-record-kind", "irregular-cartesian-volume", "negative-spacing"],
)
def test_geometry_records_reject_impossible_values(overrides: dict, expected: str) -> None:
    errors = validate_manifest_data(manifest_with(**overrides))

    assert any(expected in error for error in errors)

def test_the_fixture_config_is_valid() -> None:
    assert validate_config_data(load_json(FIXTURES / "valid_config.json")) == []

@pytest.mark.parametrize(
    ("overrides", "error"),
    [
        ({"features": {"aiAnalysis": "false"}}, "config.features.aiAnalysis: expected bool"),
        ({"trustedUploadOrigins": "https://upload.example"}, "config.trustedUploadOrigins: expected string list"),
        (
            {"modalAuthToken": "secret"},
            "config.modalAuthToken: no longer supported; keep Modal auth server-side",
        ),
    ],
    ids=["non-bool-feature-flag", "non-list-origins", "browser-side-modal-token"],
)
def test_config_rejects_unsafe_or_malformed_values(overrides: dict, error: str) -> None:
    config = load_json(FIXTURES / "valid_config.json")
    for key, value in overrides.items():
        if isinstance(value, dict):
            config[key].update(value)
        else:
            config[key] = value

    assert error in validate_config_data(config)
