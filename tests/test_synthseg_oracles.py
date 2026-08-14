from __future__ import annotations

import numpy as np

from synthseg_pipeline import _remap_synthseg_labels, _synthseg_region_payload


def test_synthseg_remap_maps_sparse_labels_and_preserves_background() -> None:
    sparse = np.array([[[0, 2, 3, 999], [41, 60, 0, 24]]], dtype=np.int32)

    dense = _remap_synthseg_labels(sparse)

    expected = np.array([[[0, 1, 2, 0], [19, 32, 0, 16]]], dtype=np.uint8)
    np.testing.assert_array_equal(dense, expected)


def test_synthseg_region_volumes_are_counts_times_voxel_volume_without_background_region() -> None:
    labels = np.array(
        [
            [[0, 1, 1, 2], [19, 19, 19, 0]],
            [[16, 16, 0, 0], [32, 0, 0, 0]],
        ],
        dtype=np.uint8,
    )

    # 10 mm * 10 mm * 10 mm = 1000 mm^3 = 1.0 mL per voxel.
    payload = _synthseg_region_payload(labels, px_x=10.0, px_y=10.0, slice_mm=10.0)
    regions = payload["regions"]

    assert "0" not in regions
    assert regions["1"]["voxels"] == 2
    assert regions["1"]["mL"] == 2.0
    assert regions["16"]["voxels"] == 2
    assert regions["16"]["mL"] == 2.0
    assert regions["19"]["voxels"] == 3
    assert regions["19"]["mL"] == 3.0
    assert regions["32"]["voxels"] == 1
    assert regions["32"]["mL"] == 1.0
    assert regions["2"]["voxels"] == 1
    assert regions["2"]["mL"] == 1.0
