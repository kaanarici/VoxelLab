from __future__ import annotations

import numpy as np

from biomarkers import _adc_physical_values, _compute_wmh_stats, _detect_microbleed_candidates


def test_microbleed_detector_counts_planted_dark_blobs_and_per_slice() -> None:
    volume = np.full((7, 48, 48), 150, dtype=np.uint8)
    centers = [(2, 12, 12), (3, 26, 32), (4, 36, 18)]
    zz, yy, xx = np.indices(volume.shape)
    for z, y, x in centers:
        sphere = np.sqrt((zz - z) ** 2 + (yy - y) ** 2 + (xx - x) ** 2) <= 1.5
        volume[sphere] = 20

    result = _detect_microbleed_candidates(volume)

    assert result is not None
    candidates, per_slice, component_count = result
    assert component_count == 3
    assert len(candidates) == 3
    assert {(c["z"], c["y"], c["x"]) for c in candidates} == set(centers)
    assert per_slice == [0, 0, 1, 1, 1, 0, 0]


def test_microbleed_detector_returns_zero_for_flat_inbrain_volume() -> None:
    result = _detect_microbleed_candidates(np.full((5, 32, 32), 150, dtype=np.uint8))

    assert result is not None
    candidates, per_slice, component_count = result
    assert component_count == 0
    assert candidates == []
    assert per_slice == [0, 0, 0, 0, 0]


def test_wmh_burden_volume_is_voxel_count_times_voxel_volume() -> None:
    volume = np.full((2, 5, 5), 100, dtype=np.uint8)
    bright_voxels = [(0, 1, 1), (0, 1, 2), (0, 2, 1), (1, 3, 3), (1, 3, 4), (1, 4, 3)]
    for coord in bright_voxels:
        volume[coord] = 220

    # 1 mm * 2 mm * 5 mm = 10 mm^3 = 0.01 mL, so 6 kept voxels = 0.06 mL.
    result = _compute_wmh_stats(volume, voxel_ml=0.01)

    assert result is not None
    stats, component_count = result
    assert component_count == 2
    assert stats["voxels"] == 6
    assert stats["volume_ml"] == 0.06
    assert stats["per_slice_ml"] == [0.03, 0.03]


def test_adc_rescale_applies_linear_slope_and_intercept() -> None:
    raw = np.array([0.0, 100.0, 4095.0], dtype=np.float32)

    converted = _adc_physical_values(raw, slope=0.5, intercept=-1024.0)

    np.testing.assert_allclose(converted, np.array([-1024.0, -974.0, 1023.5]), rtol=0, atol=0)
