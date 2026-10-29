from __future__ import annotations

import pytest

from tests.helpers.python.modal_runtime import load_module

@pytest.fixture()
def validation(monkeypatch):
    """`modal_validation` reloaded so module-level env parsing is per test."""
    return load_module(monkeypatch, "modal_validation")

def test_env_helpers_clamp_values_to_supported_bounds(validation, monkeypatch) -> None:
    monkeypatch.setenv("MRI_VIEWER_MODAL_GPU", "L4,A10G")
    monkeypatch.setenv("TEST_INT", "999")
    monkeypatch.setenv("TEST_FLOAT", "-5")

    assert validation.env_int("TEST_INT", 10, max_value=64) == 64
    assert validation.env_float("TEST_FLOAT", 1.5, min_value=0.5) == 0.5
    assert validation.env_gpu("MRI_VIEWER_MODAL_GPU") == ["L4", "A10"]

def test_env_gpu_rejects_an_unknown_gpu_type(validation, monkeypatch) -> None:
    monkeypatch.setenv("MRI_VIEWER_MODAL_GPU", "expensive-mystery-gpu")

    with pytest.raises(ValueError, match="unsupported Modal GPU type"):
        _ = validation.env_gpu("MRI_VIEWER_MODAL_GPU")

def test_env_gpu_treats_an_empty_list_as_unset(validation, monkeypatch) -> None:
    monkeypatch.setenv("MRI_VIEWER_MODAL_GPU", ",")

    assert validation.env_gpu("MRI_VIEWER_MODAL_GPU") is None

def test_ephemeral_disk_is_unset_by_default(validation, monkeypatch) -> None:
    monkeypatch.delenv("MRI_VIEWER_MODAL_EPHEMERAL_DISK_MB", raising=False)

    assert validation.env_ephemeral_disk_mb("MRI_VIEWER_MODAL_EPHEMERAL_DISK_MB") is None

def test_ephemeral_disk_accepts_a_size_inside_current_modal_bounds(validation, monkeypatch) -> None:
    monkeypatch.setenv("MRI_VIEWER_MODAL_EPHEMERAL_DISK_MB", "524288")

    assert validation.env_ephemeral_disk_mb("MRI_VIEWER_MODAL_EPHEMERAL_DISK_MB") == 524_288

@pytest.mark.parametrize("requested", ["204800", "not-a-size", "3145729"], ids=["below-minimum", "not-a-number", "above-maximum"])
def test_ephemeral_disk_rejects_sizes_modal_cannot_provision(validation, monkeypatch, requested: str) -> None:
    monkeypatch.setenv("MRI_VIEWER_MODAL_EPHEMERAL_DISK_MB", requested)

    with pytest.raises(ValueError):
        _ = validation.env_ephemeral_disk_mb("MRI_VIEWER_MODAL_EPHEMERAL_DISK_MB")

def test_request_validators_accept_the_shapes_the_browser_sends(validation) -> None:
    assert validation.validate_job_id("abc123-def_456") == "abc123-def_456"
    assert validation.validate_upload_id("f000001") == "f000001"
    assert validation.validate_modality("CT") == "CT"
    assert validation.validate_upload_filename("slice-0001.dcm") == "slice-0001.dcm"

@pytest.mark.parametrize(
    "mode",
    ["standard", "projection_set_reconstruction", "ultrasound_scan_conversion", "rigid_registration"],
)
def test_processing_modes_stay_the_shipped_set(validation, mode: str) -> None:
    assert validation.validate_processing_mode(mode) == mode

@pytest.mark.parametrize(
    ("kind", "mode"),
    [
        ("dicom_volume_stack", "standard"),
        ("calibrated_projection_set", "projection_set_reconstruction"),
        ("calibrated_ultrasound_source", "ultrasound_scan_conversion"),
        ("dicom_registration_pair", "rigid_registration"),
    ],
)
def test_each_processing_mode_accepts_only_its_own_input_kind(validation, kind: str, mode: str) -> None:
    assert validation.validate_input_kind(kind, mode) == kind

@pytest.mark.parametrize(
    ("validator", "value"),
    [
        ("validate_job_id", "../abc123"),
        ("validate_job_id", "short"),
        ("validate_upload_id", "../item"),
        ("validate_modality", "PET"),
        ("validate_modality", "DX"),
        ("validate_processing_mode", "fdka"),
        ("validate_input_kind", "../projection"),
        ("validate_upload_filename", "../slice.dcm"),
        ("validate_upload_filename", "folder/slice.dcm"),
    ],
)
def test_request_validators_reject_r2_key_escape_shapes(validation, validator: str, value: str) -> None:
    assert getattr(validation, validator)(value) == ""

@pytest.mark.parametrize(
    ("mode", "reason"),
    [
        ("ultrasound_scan_conversion", "ultrasound_scan_conversion requires calibrated_ultrasound_source input_kind"),
        ("rigid_registration", "rigid_registration requires dicom_registration_pair input_kind"),
    ],
)
def test_mismatched_input_kind_is_rejected_with_a_named_reason(validation, mode: str, reason: str) -> None:
    assert validation.validate_input_kind("dicom_volume_stack", mode) == ""
    assert validation.input_kind_error("dicom_volume_stack", mode) == reason

def test_upload_items_keep_duplicate_filenames_apart_by_upload_id(validation) -> None:
    items, error = validation.normalize_upload_items({
        "items": [
            {"upload_id": "f000001", "filename": "IM0001", "size_bytes": 10},
            {"upload_id": "f000002", "filename": "IM0001", "size_bytes": 11},
        ]
    })

    assert error is None
    assert items == [
        {"upload_id": "f000001", "filename": "IM0001", "content_type": "application/dicom", "size_bytes": 10},
        {"upload_id": "f000002", "filename": "IM0001", "content_type": "application/dicom", "size_bytes": 11},
    ]

def test_upload_object_names_keep_the_source_manifest_filename(validation) -> None:
    assert validation.upload_object_name("f000001", "IM0001") == "f000001__IM0001"
    assert validation.upload_object_name("f000002", "voxellab.source.json") == "voxellab.source.json"

@pytest.mark.parametrize("size", [True, 1.5, "10", 0, -1], ids=["bool", "float", "string", "zero", "negative"])
def test_upload_items_require_a_positive_integer_size(validation, size) -> None:
    items, error = validation.normalize_upload_items({
        "items": [{"upload_id": "f000001", "filename": "IM0001", "size_bytes": size}],
    })

    assert items == []
    assert error == "invalid upload item"

def test_legacy_filename_batches_are_rejected(validation) -> None:
    items, error = validation.normalize_upload_items({"filenames": ["IM0001", "IM0001"]})

    assert items == []
    assert error == "structured upload items with size_bytes are required"

def test_legacy_oversized_batches_are_rejected_before_counting(validation) -> None:
    items, error = validation.normalize_upload_items({
        "filenames": [f"IM{index:06d}" for index in range(validation.MAX_UPLOAD_ITEMS + 1)]
    })

    assert items == []
    assert error == "structured upload items with size_bytes are required"

def test_structured_batches_are_capped_at_the_modal_contract_limit(validation) -> None:
    items, error = validation.normalize_upload_items({
        "items": [
            {"upload_id": f"f{index:06d}", "filename": f"IM{index:06d}"}
            for index in range(validation.MAX_UPLOAD_ITEMS + 1)
        ]
    })

    assert items == []
    assert error == f"too many upload items; maximum is {validation.MAX_UPLOAD_ITEMS}"

def test_auth_error_names_only_the_configured_token(validation, monkeypatch) -> None:
    monkeypatch.setenv("MODAL_AUTH_TOKEN", "secret-token")

    assert validation.auth_error("secret-token") == ""
    assert validation.auth_error("wrong-token") == "unauthorized"
    assert validation.auth_error("") == "unauthorized"
