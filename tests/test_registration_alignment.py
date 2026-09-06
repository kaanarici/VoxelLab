import sys
from types import SimpleNamespace

import numpy as np
import pytest

from modal_dicom import ensure_registration_inputs
from registration_alignment import align_registration_pair


def registration_stack(uid, spacing):
    return [SimpleNamespace(
        SeriesInstanceUID=uid, SeriesDescription=uid, StudyInstanceUID="study",
        FrameOfReferenceUID="frame", Modality="MR", Rows=8, Columns=8,
        ImageOrientationPatient=[1, 0, 0, 0, 1, 0],
        ImagePositionPatient=[0, 0, z * spacing], PixelSpacing=[spacing, spacing],
        SliceThickness=spacing, InstanceNumber=z + 1,
        pixel_array=np.pad(np.ones((4, 4), dtype=np.float32) * 100, 2),
    ) for z in range(4)]


def test_registration_failure_never_relabels_an_unresampled_volume(monkeypatch):
    source = {"sourceRecordVersion": 1, "sourceKind": "registration", "registration": {
        "fixedSeriesUID": "fixed", "movingSeriesUID": "moving", "transform": "rigid",
    }}
    fixed, moving, error = ensure_registration_inputs(
        registration_stack("fixed", 1) + registration_stack("moving", 2), source,
    )
    assert not error

    def fail(*args, **kwargs):
        raise RuntimeError("ANTs unavailable")

    monkeypatch.setitem(sys.modules, "ants", SimpleNamespace(from_numpy=fail))
    with pytest.raises(RuntimeError, match="ANTs unavailable"):
        _ = align_registration_pair(fixed, moving, transform="rigid", np=np)


@pytest.mark.parametrize("parameters", [[], [1] * 6, [float("nan")] * 12, [2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]])
def test_registration_rejects_invalid_transform(parameters):
    from registration_alignment import registration_transform

    ants = SimpleNamespace(read_transform=lambda path: SimpleNamespace(parameters=parameters))
    with pytest.raises(ValueError):
        _ = registration_transform(ants, ["transform.mat"], np)


def test_native_registration_preserves_physical_grid():
    ants = pytest.importorskip("ants")
    from registration_alignment import ants_image_from_slices

    slices = registration_stack("fixed", 2)
    for index, item in enumerate(slices):
        item.PixelSpacing = [2, 3]
        item.ImageOrientationPatient = [0, 1, 0, 0, 0, 1]
        item.ImagePositionPatient = [10 + 4 * index, 20, 30]
    image = ants_image_from_slices(slices, np, ants)
    assert image.spacing == (3, 2, 4)
    assert image.origin == (10, 20, 30)
    np.testing.assert_allclose(image.direction, [[0, 0, 1], [1, 0, 0], [0, 1, 0]])
    assert image.numpy().shape == (8, 8, 4)


def test_native_registration_resamples_translation_into_fixed_space():
    _ = pytest.importorskip("ants")
    size = 24
    z, y, x = np.indices((size, size, size))
    phantom = (100 * np.exp(-((x - 9) ** 2 + (y - 12) ** 2 + (z - 10) ** 2) / 18)
               + 60 * np.exp(-((x - 16) ** 2 + (y - 8) ** 2 + (z - 15) ** 2) / 8)).astype(np.float32)

    def stack(uid, offset):
        return [SimpleNamespace(
            SeriesInstanceUID=uid, SeriesDescription=uid, StudyInstanceUID="study",
            FrameOfReferenceUID="frame", Modality="MR", Rows=size, Columns=size,
            ImageOrientationPatient=[1, 0, 0, 0, 1, 0],
            ImagePositionPatient=[offset, 0, index * 2], PixelSpacing=[1.5, 1],
            SliceThickness=2, InstanceNumber=index + 1, pixel_array=plane,
        ) for index, plane in enumerate(phantom)]

    result = align_registration_pair(stack("fixed", 0), stack("moving", 4), transform="translation", np=np)
    assert result["volume"].shape == phantom.shape
    assert np.isfinite(result["volume"]).all()
    assert np.mean((result["volume"] - phantom) ** 2) < 1
    np.testing.assert_allclose(result["transform"]["translationMm"], [4, 0, 0], atol=0.3)
    assert result["quality"]["grade"] == "unknown"
    assert result["verdict"] == "alignment unverified"
