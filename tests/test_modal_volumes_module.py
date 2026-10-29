from __future__ import annotations

import numpy as np
import pytest

from modal_volumes import (
    build_derived_volume_entry,
    normalize_volume_for_pngs,
    normalize_volume_for_raw,
    volume_normalization_report,
)

CT_ROW = np.array([[-1000.0, 0.0, 1000.0]], dtype=np.float32)

@pytest.fixture()
def normalization() -> dict:
    return volume_normalization_report(CT_ROW, "CT", np)

def test_preview_pngs_are_windowed_eight_bit_images() -> None:
    pngs = normalize_volume_for_pngs(CT_ROW, "CT", np)

    assert pngs.dtype == np.uint8

def test_raw_volumes_stay_inside_the_unit_interval() -> None:
    raw = normalize_volume_for_raw(CT_ROW, "CT", np)

    assert raw.min() >= 0
    assert raw.max() <= 1

def test_the_normalization_report_names_both_display_windows(normalization: dict) -> None:
    assert normalization["previewPng"]["window"] == [-160.0, 240.0]
    assert normalization["rawVolume"]["window"] == [-1024.0, 2048.0]

def test_a_derived_volume_entry_publishes_its_urls_and_known_losses(normalization: dict) -> None:
    entry = build_derived_volume_entry(
        slug="cloud_proj_123",
        name="Projection reconstruction",
        description="3 slices",
        modality="CT",
        width=16,
        height=16,
        depth=3,
        geometry={
            "pixelSpacing": [1, 1],
            "sliceThickness": 1.0,
            "sliceSpacing": 1.0,
            "sliceSpacingRegular": True,
            "firstIPP": [0, 0, 0],
            "lastIPP": [0, 0, 2],
            "orientation": [1, 0, 0, 0, 1, 0],
        },
        public_url="https://cdn.example",
        source_projection_set_id="proj-1",
        volume_normalization=normalization,
    )

    assert entry["sourceProjectionSetId"] == "proj-1"
    assert entry["sliceUrlBase"] == "https://cdn.example/data/cloud_proj_123"
    assert entry["rawUrl"] == "https://cdn.example/cloud_proj_123.raw.zst"
    assert entry["engineReport"]["normalization"]["previewPng"]["knownLosses"] == [
        "clipped outside display window",
        "rescaled to 8-bit preview",
    ]
