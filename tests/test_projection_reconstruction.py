from __future__ import annotations

import numpy as np
import pytest

import projection_rtk
from projection_reconstruction import reconstruct_projection_volume
from scripts import rtk_projection_wrapper

class FakeProjection:
    def __init__(self, pixel_array, instance: int):
        self.pixel_array = pixel_array
        self.SeriesInstanceUID = "1.2.projection.series"
        self.StudyInstanceUID = "1.2.study"
        self.Modality = "XA"
        self.InstanceNumber = instance

def test_reconstruct_projection_volume_requires_rtk_for_non_parallel_geometry(monkeypatch):
    datasets = [FakeProjection(np.ones((4, 4), dtype=np.float32), 1)]
    manifest = {
        "sourceRecordVersion": 2,
        "sourceKind": "projection",
        "seriesUID": "1.2.projection.series",
        "projection": {
            "geometryModel": "circular-cbct",
            "anglesDeg": [0],
            "outputShape": [8, 8, 2],
            "outputSpacingMm": [1.0, 1.0, 1.0],
            "firstIPP": [0.0, 0.0, 0.0],
            "orientation": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "frameOfReferenceUID": "1.2.for",
        },
    }

    monkeypatch.setattr(projection_rtk, "configured_rtk_command", lambda: "")
    try:
        _ = reconstruct_projection_volume(datasets, manifest, np)
    except RuntimeError as exc:
        assert "requires RTK" in str(exc)
    else:
        raise AssertionError("expected non-parallel projection geometry to require RTK")


def test_parallel_reconstruction_has_no_uncalibrated_fallback():
    from test_projection_rtk import circular_manifest

    manifest = circular_manifest()
    manifest["projection"]["geometryModel"] = "parallel-beam-stack"
    with pytest.raises(RuntimeError, match="calibrated external reconstruction engine"):
        _ = rtk_projection_wrapper.reconstruct(manifest, np.ones((2, 4, 4), dtype=np.float32))
