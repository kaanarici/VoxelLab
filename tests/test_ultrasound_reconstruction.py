from __future__ import annotations

import numpy as np
from scipy import ndimage

from ultrasound_reconstruction import _accumulate_frame, reconstruct_ultrasound_volume
from geometry import geometry_from_grid

def test_grid_geometry_uses_row_column_spacing_and_oblique_slice_direction():
    result = geometry_from_grid({
        "outputShape": [2, 3, 4], "outputSpacingMm": [0.5, 2, 3],
        "firstIPP": [10, 20, 30], "orientation": [1, 0, 0, 0, 0, 1],
    })
    assert result["pixelSpacing"] == [2, 0.5]
    assert result["lastIPP"] == [10, 11, 30]

def test_tracked_accumulation_preserves_zero_samples_and_repeated_voxel_contributions():
    config = {
        "outputShape": [1, 1, 1], "outputSpacingMm": [10, 10, 10],
        "firstIPP": [0, 5, 0], "orientation": [1, 0, 0, 0, 1, 0],
        "scanConvertedSpacingMm": [1, 1], "radiusRangeMm": [5, 10],
    }
    volume = np.zeros((1, 1, 1), dtype=np.float32)
    weights = np.zeros_like(volume)
    _accumulate_frame(volume, weights, np.array([[0, 2]], dtype=np.float32), np.eye(4).tolist(), config, np)
    assert weights.item() == 2
    assert (volume / weights).item() == 1

def test_tracked_accumulation_maps_lps_points_into_rotated_output_axes():
    config = {
        "outputShape": [3, 3, 1], "outputSpacingMm": [1, 1, 1],
        "firstIPP": [0, 0, 0], "orientation": [0, 1, 0, -1, 0, 0],
        "scanConvertedSpacingMm": [1, 1], "radiusRangeMm": [0, 10],
    }
    transform = np.eye(4)
    transform[:3, 3] = [-1, 1, 0]
    volume = np.zeros((1, 3, 3), dtype=np.float32)
    weights = np.zeros_like(volume)
    _accumulate_frame(volume, weights, np.array([[1, 2, 3]], dtype=np.float32), transform.tolist(), config, np)
    np.testing.assert_array_equal(volume[0, :, 1], [3, 2, 1])
    assert weights.sum() == 3

class FakeUltrasound:
    def __init__(self, pixel_array):
        self.pixel_array = pixel_array
        self.NumberOfFrames = pixel_array.shape[0] if pixel_array.ndim == 3 else 1
        self.SeriesInstanceUID = "1.2.us.series"
        self.Modality = "US"

def test_reconstruct_ultrasound_volume_scan_converts_calibrated_sector_stack():
    rows = cols = 32
    frame_a = np.zeros((rows, cols), dtype=np.float32)
    frame_b = np.zeros((rows, cols), dtype=np.float32)
    frame_a[8:24, 10:22] = 1.0
    frame_b[12:28, 12:24] = 1.0
    ds = FakeUltrasound(np.stack([frame_a, frame_b], axis=0))

    manifest = {
        "sourceRecordVersion": 2,
        "sourceKind": "ultrasound",
        "seriesUID": "1.2.us.series",
        "ultrasound": {
            "mode": "stacked-sector",
            "probeGeometry": "sector",
            "profileId": "stacked-sector-default",
            "thetaRangeDeg": [-35.0, 35.0],
            "radiusRangeMm": [0.0, 60.0],
            "outputShape": [32, 32, 2],
            "outputSpacingMm": [1.0, 1.0, 2.0],
            "firstIPP": [0.0, 0.0, 0.0],
            "orientation": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "frameOfReferenceUID": "1.2.us.for",
        },
    }

    result = reconstruct_ultrasound_volume([ds], manifest, np, ndimage)

    assert result["volume"].shape == (2, 32, 32)
    assert float(result["volume"].max()) > 0.0
    assert result["geometry"]["frameOfReferenceUID"] == "1.2.us.for"
    assert result["geometry"]["sliceSpacingRegular"] is True
    assert result["report"]["backend"] == "sector-scan-conversion"
    assert result["report"]["profileId"] == "stacked-sector-default"


def test_color_ultrasound_is_not_interpreted_as_a_frame_stack():
    import pytest
    from ultrasound_reconstruction import _frame_pixels

    dataset = FakeUltrasound(np.ones((8, 8, 3), dtype=np.float32))
    dataset.SamplesPerPixel = 3
    dataset.NumberOfFrames = 1
    with pytest.raises(ValueError, match="grayscale"):
        _ = _frame_pixels(dataset, np)


def test_declared_ultrasound_frame_count_must_match_decoded_pixels():
    import pytest
    from ultrasound_reconstruction import _frame_pixels

    dataset = FakeUltrasound(np.ones((8, 8, 3), dtype=np.float32))
    dataset.NumberOfFrames = 2
    with pytest.raises(ValueError, match="multi-frame"):
        _ = _frame_pixels(dataset, np)
