from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from modal_regions import golden_color, humanize_region_name, region_volume_stats, write_region_outputs, write_region_stats

LABEL_NAMES = {1: "heart", 2: "left_lung"}
PIXEL_SPACING = [1.0, 1.0]
SLICE_THICKNESS = 2.0

@pytest.fixture()
def label_volume() -> np.ndarray:
    """One slice holding background, one heart voxel, and two left-lung voxels."""
    return np.array([[[0, 1], [2, 2]]], dtype=np.uint8)

def test_region_names_are_humanized_for_the_viewer() -> None:
    assert humanize_region_name("left_lung") == "Left lung"

def test_region_colors_are_distinct_per_label() -> None:
    assert golden_color(1) != golden_color(2)

def test_region_outputs_write_a_png_stack_and_a_named_sidecar(tmp_path: Path, label_volume: np.ndarray) -> None:
    region_dir, sidecar = write_region_outputs(
        "cloud_job",
        label_volume,
        LABEL_NAMES,
        tmp_path,
        PIXEL_SPACING,
        SLICE_THICKNESS,
        Image,
        np,
    )

    data = json.loads(sidecar.read_text())
    assert region_dir.joinpath("0000.png").exists()
    assert data["regions"]["2"]["name"] == "Left lung"

def test_region_volumes_are_voxel_counts_scaled_by_voxel_volume(label_volume: np.ndarray) -> None:
    stats = region_volume_stats("cloud_job", label_volume, LABEL_NAMES, PIXEL_SPACING, SLICE_THICKNESS)

    assert stats["source"] == "modal:totalsegmentator"
    assert stats["sourceRegions"] == "data/cloud_job_regions.json"
    assert stats["regionVolumes"][1]["name"] == "Left lung"
    assert stats["regionVolumes"][1]["volumeMl"] == 0.004

def test_region_stats_are_written_next_to_the_series(tmp_path: Path, label_volume: np.ndarray) -> None:
    stats_path = write_region_stats("cloud_job", label_volume, LABEL_NAMES, tmp_path, PIXEL_SPACING, SLICE_THICKNESS)

    assert stats_path.name == "cloud_job_stats.json"
    assert json.loads(stats_path.read_text())["regionVolumes"][1]["volumeMl"] == 0.004
