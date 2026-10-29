"""Manifest and source-record builders shared by contract tests."""

from __future__ import annotations

def local_series(**overrides) -> dict:
    """A minimal locally converted series entry."""
    series = {
        "slug": "sample",
        "name": "Sample",
        "description": "Sample series",
        "slices": 1,
        "width": 2,
        "height": 2,
        "pixelSpacing": [1.0, 1.0],
        "sliceThickness": 1.0,
        "hasBrain": False,
        "hasSeg": False,
        "hasRaw": False,
    }
    series.update(overrides)
    return series

def cloud_manifest() -> dict:
    """A single-series manifest that cloud results merge into."""
    return {
        "patient": "fixture",
        "studyDate": "2026-04-09",
        "series": [
            {
                "slug": "sample",
                "name": "Sample",
                "description": "Tiny fixture stack",
                "slices": 2,
                "width": 2,
                "height": 1,
                "pixelSpacing": [0.5, 0.5],
                "sliceThickness": 1.0,
                "hasBrain": False,
                "hasSeg": True,
                "hasRaw": False,
            }
        ],
    }

def modal_entry(**overrides) -> dict:
    """A cloud result series entry as returned by the Modal pipeline."""
    entry = {
        "slug": "cloud_job12345",
        "name": "Cloud CT",
        "description": "2 slices - cloud processed",
        "modality": "CT",
        "slices": 2,
        "width": 4,
        "height": 4,
        "pixelSpacing": [0.7, 0.7],
        "sliceThickness": 1.5,
        "group": None,
        "hasBrain": False,
        "hasSeg": False,
        "hasSym": False,
        "hasRegions": False,
        "hasStats": False,
        "hasAnalysis": False,
        "hasMaskRaw": False,
        "hasRaw": True,
        "rawUrl": "https://r2.example/cloud_job12345.raw.zst",
        "sliceUrlBase": "https://r2.example/data/cloud_job12345",
    }
    entry.update(overrides)
    return entry

def projection_source(*, series_uid: str = "1.2.projection.series", **projection) -> dict:
    """A `voxellab.source.json` record for a projection series."""
    geometry = {
        "geometryModel": "parallel-beam-stack",
        "anglesDeg": [0, 90],
        "outputShape": [8, 8, 3],
        "outputSpacingMm": [1.0, 1.0, 1.5],
        "firstIPP": [0.0, 0.0, 0.0],
        "orientation": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        "frameOfReferenceUID": "1.2.for",
    }
    geometry.update(projection)
    return {
        "sourceRecordVersion": 2,
        "sourceKind": "projection",
        "seriesUID": series_uid,
        "projection": geometry,
    }

def circular_cbct_source(*, series_uid: str = "1.2.projection.series", **projection) -> dict:
    """A calibrated circular CBCT source record with its projection set identity."""
    record = projection_source(series_uid=series_uid, **{"geometryModel": "circular-cbct", **projection})
    record["name"] = "Calibrated CBCT"
    record["projectionSetId"] = "projection_set_1"
    return record

def ultrasound_source(*, series_uid: str = "1.2.us", **ultrasound) -> dict:
    """A `voxellab.source.json` record for a calibrated ultrasound source."""
    calibration = {
        "mode": "stacked-sector",
        "probeGeometry": "sector",
        "thetaRangeDeg": [-30, 30],
        "radiusRangeMm": [0, 50],
        "outputShape": [8, 8, 1],
        "outputSpacingMm": [1, 1, 1],
        "firstIPP": [0, 0, 0],
        "orientation": [1, 0, 0, 0, 1, 0],
        "frameOfReferenceUID": "1.2.us.for",
    }
    calibration.update(ultrasound)
    return {
        "sourceRecordVersion": 2,
        "sourceKind": "ultrasound",
        "seriesUID": series_uid,
        "ultrasound": calibration,
    }

def registration_source(*, fixed: str = "fixed", moving: str = "moving", transform: str = "rigid") -> dict:
    """A `voxellab.source.json` record naming the fixed and moving series."""
    return {
        "sourceRecordVersion": 2,
        "sourceKind": "registration",
        "registration": {
            "fixedSeriesUID": fixed,
            "movingSeriesUID": moving,
            "transform": transform,
        },
    }
