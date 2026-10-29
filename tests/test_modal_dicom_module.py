from __future__ import annotations

import numpy as np
import pytest

from modal_dicom import (
    dropped_dicom_series,
    ensure_projection_inputs,
    ensure_registration_inputs,
    ensure_ultrasound_inputs,
    expand_primary_stack,
    is_projection_like_dicom,
    mpr_geometry_error,
    select_primary_dicom_stack,
    stack_pixels_with_rescale,
)

from tests.helpers.python.dicom_doubles import (
    FakeDicom,
    FakePixelCube,
    FakePixelPlane,
    enhanced_multiframe_dataset,
    stack_slices,
)
from tests.helpers.python.manifests import projection_source, registration_source, ultrasound_source

def test_primary_stack_selection_picks_the_largest_coherent_series() -> None:
    selected, modality, key = select_primary_dicom_stack([
        FakeDicom(series_uid="scout", rows=256, cols=232, instance=1),
        FakeDicom(series_uid="main", rows=792, cols=512, instance=2),
        FakeDicom(series_uid="main", rows=792, cols=512, instance=1),
    ], "CT")

    assert modality == "CT"
    assert key[1] == "main"
    assert [(ds.Rows, ds.Columns, ds.InstanceNumber) for ds in selected] == [
        (792, 512, 1),
        (792, 512, 2),
    ]

def test_primary_stack_selection_respects_the_requested_modality() -> None:
    selected, modality, key = select_primary_dicom_stack([
        FakeDicom(modality="MR", series_uid="mr", rows=64, cols=64, instance=1),
        FakeDicom(modality="CT", series_uid="ct", rows=512, cols=512, instance=1),
        FakeDicom(modality="CT", series_uid="ct", rows=512, cols=512, instance=2),
    ], "MR")

    assert len(selected) == 1
    assert modality == "MR"
    assert key[1] == "mr"

def test_primary_stack_selection_rejects_projection_and_localizer_inputs() -> None:
    selected, modality, key = select_primary_dicom_stack([
        FakeDicom(modality="DX", series_uid="dx", instance=1),
        FakeDicom(modality="CT", series_uid="localizer", image_type=["ORIGINAL", "PRIMARY", "LOCALIZER"], instance=2),
    ], "auto")

    assert selected == []
    assert modality == ""
    assert key == ("", "", 0, 0)

def test_non_primary_series_are_reported_as_dropped() -> None:
    datasets = [
        FakeDicom(series_uid="main", rows=512, cols=512, instance=1),
        FakeDicom(series_uid="main", rows=512, cols=512, instance=2),
        FakeDicom(series_uid="other", rows=256, cols=256, instance=1),
    ]
    _selected, _modality, key = select_primary_dicom_stack(datasets, "CT")

    assert dropped_dicom_series(datasets, "CT", key) == [{
        "modality": "CT",
        "seriesUID": "other",
        "rows": 256,
        "columns": 256,
        "sliceCount": 1,
    }]

def test_projection_modality_allowlist_matches_the_browser() -> None:
    assert is_projection_like_dicom(FakeDicom(modality="IO"))
    assert is_projection_like_dicom(FakeDicom(modality="PX"))

def test_multiframe_expansion_yields_one_positioned_slice_per_frame() -> None:
    dataset = enhanced_multiframe_dataset([[0, 0, 0], [0, 0, 1]])

    expanded, error = expand_primary_stack([dataset])

    assert error == ""
    assert len(expanded) == 2
    assert expanded[0].ImagePositionPatient == [0.0, 0.0, 0.0]
    assert expanded[1].ImagePositionPatient == [0.0, 0.0, 1.0]
    assert expanded[0].pixel_array == [[1, 2], [3, 4]]
    assert mpr_geometry_error(expanded) == ""

def test_multiframe_expansion_keeps_per_frame_rescale() -> None:
    dataset = enhanced_multiframe_dataset(
        [[0, 0, 0], [0, 0, 1]],
        rescale=[(2.0, -100.0), (3.0, -200.0)],
    )

    expanded, error = expand_primary_stack([dataset])

    assert error == ""
    assert [(ds.RescaleSlope, ds.RescaleIntercept) for ds in expanded] == [(2.0, -100.0), (3.0, -200.0)]

def test_multiframe_zero_intercept_overrides_a_nonzero_dataset_intercept() -> None:
    dataset = enhanced_multiframe_dataset([[0, 0, 0], [0, 0, 1]], rescale=[(1, 0), (1, 0)])
    dataset.RescaleIntercept = -1024

    expanded, error = expand_primary_stack([dataset])

    assert not error
    assert expanded[0].RescaleIntercept == 0
    assert stack_pixels_with_rescale(expanded).tolist()[0][0][0] == 1

def test_stacked_pixels_apply_per_slice_rescale() -> None:
    first = FakeDicom(modality="MR", instance=1)
    first.pixel_array = [[1, 2], [3, 4]]
    first.RescaleSlope = 2.0
    first.RescaleIntercept = -10.0
    second = FakeDicom(modality="MR", instance=2)
    second.pixel_array = [[5, 6], [7, 8]]
    second.RescaleSlope = 3.0
    second.RescaleIntercept = -20.0

    assert stack_pixels_with_rescale([first, second]).tolist() == [
        [[-8.0, -6.0], [-4.0, -2.0]],
        [[-5.0, -2.0], [1.0, 4.0]],
    ]

def test_mpr_geometry_accepts_a_regular_orthogonal_stack() -> None:
    assert mpr_geometry_error(stack_slices([[0, 0, 0], [0, 0, 1]])) == ""

@pytest.mark.parametrize(
    ("slices", "reason"),
    [
        (stack_slices([[0, 0, 0], [0, 10, 0]]), "slice positions aligned"),
        (stack_slices([[0, 0, 0], [2, 0, 1], [0, 0, 2]]), "slice positions aligned"),
        (stack_slices([[0, 0, 0], [0, 0, 1], [0, 0, 3]]), "regular slice spacing"),
        (stack_slices([[0, 0, 0], [0, 0, 0], [0, 0, 1]]), "distinct slice positions"),
        (stack_slices([[0, 0, 0], [0, 0, 1]], orientation=[2, 0, 0, 0, 1, 0]), "orthonormal"),
        (
            [
                FakeDicom(instance=1, position=[0, 0, 0], frame_uid="for-A"),
                FakeDicom(instance=2, position=[0, 0, 1], frame_uid="for-B"),
            ],
            "FrameOfReferenceUID",
        ),
        (
            [
                FakeDicom(instance=1, position=[0, 0, 0], pixel_spacing=[1, 1]),
                FakeDicom(instance=2, position=[0, 0, 1], pixel_spacing=[1.2, 1]),
            ],
            "consistent DICOM PixelSpacing",
        ),
        (
            [
                FakeDicom(instance=1, position=[0, 0, 0], orientation=[1, 0, 0, 0, 1, 0]),
                FakeDicom(instance=2, position=[0, 0, 1], orientation=[0, 1, 0, -1, 0, 0]),
            ],
            "consistent slice orientation",
        ),
    ],
    ids=[
        "misaligned-slice-axis",
        "shifted-middle-slice",
        "irregular-spacing",
        "duplicate-positions",
        "non-unit-orientation",
        "mixed-frame-of-reference",
        "mixed-pixel-spacing",
        "mixed-slice-orientation",
    ],
)
def test_mpr_geometry_rejects_untrustworthy_stacks(slices, reason: str) -> None:
    assert reason in mpr_geometry_error(slices)

def test_projection_inputs_require_a_source_manifest() -> None:
    selected, error = ensure_projection_inputs(
        [FakeDicom(modality="XA", series_uid="proj", instance=1)],
        None,
    )

    assert selected == []
    assert "source manifest" in error

def test_projection_inputs_accept_one_calibrated_projection_series() -> None:
    datasets = [
        FakeDicom(modality="XA", series_uid="proj", instance=1),
        FakeDicom(modality="XA", series_uid="proj", instance=2),
    ]
    for dataset in datasets:
        dataset.pixel_array = FakePixelPlane()

    selected, error = ensure_projection_inputs(
        datasets,
        projection_source(series_uid="proj", outputShape=[16, 16, 2], outputSpacingMm=[1, 1, 1]),
    )

    assert error == ""
    assert len(selected) == 2

@pytest.mark.parametrize(
    ("frames", "pixel_array", "reason"),
    [
        (2, None, "multi-frame DICOM inputs"),
        ("many", None, "numeric NumberOfFrames"),
        (None, [[1, 2], [3, 4]], "one 2D pixel frame"),
    ],
    ids=["multi-frame", "non-numeric-frame-count", "non-2d-pixels"],
)
def test_projection_inputs_reject_unsupported_pixel_shapes(frames, pixel_array, reason: str) -> None:
    dataset = FakeDicom(modality="XA", series_uid="proj", instance=1)
    if frames is not None:
        dataset.NumberOfFrames = frames
    if pixel_array is not None:
        dataset.pixel_array = pixel_array

    selected, error = ensure_projection_inputs(
        [dataset],
        projection_source(series_uid="proj", anglesDeg=[0], outputShape=[16, 16, 2], outputSpacingMm=[1, 1, 1]),
    )

    assert selected == []
    assert reason in error

def test_ultrasound_inputs_accept_a_calibrated_multiframe_source() -> None:
    dataset = FakeDicom(modality="US", series_uid="us", instance=1)
    dataset.NumberOfFrames = 2
    dataset.pixel_array = FakePixelCube([[[1, 2], [3, 4]], [[5, 6], [7, 8]]])

    selected, error = ensure_ultrasound_inputs(
        [dataset],
        ultrasound_source(series_uid="us", outputShape=[8, 8, 2]),
        np,
    )

    assert error == ""
    assert len(selected) == 1

def test_ultrasound_inputs_reject_non_array_pixels() -> None:
    dataset = FakeDicom(modality="US", series_uid="us", instance=1)

    selected, error = ensure_ultrasound_inputs([dataset], ultrasound_source(series_uid="us"), np)

    assert selected == []
    assert "expects 2D frames" in error

def test_registration_inputs_select_the_named_fixed_and_moving_stacks() -> None:
    datasets = [
        *stack_slices([[0, 0, 0], [0, 0, 1]], modality="MR", series_uid="fixed"),
        *stack_slices([[0, 0, 0], [0, 0, 1]], modality="MR", series_uid="moving"),
    ]

    fixed, moving, error = ensure_registration_inputs(datasets, registration_source())

    assert error == ""
    assert [ds.SeriesInstanceUID for ds in fixed] == ["fixed", "fixed"]
    assert [ds.SeriesInstanceUID for ds in moving] == ["moving", "moving"]

def test_registration_inputs_reject_a_pair_that_names_one_series_twice() -> None:
    datasets = stack_slices([[0, 0, 0], [0, 0, 1]], modality="MR", series_uid="fixed")

    fixed, moving, error = ensure_registration_inputs(datasets, registration_source(moving="fixed"))

    assert fixed == []
    assert moving == []
    assert "different series" in error
