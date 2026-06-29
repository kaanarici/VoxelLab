from __future__ import annotations

import json

import numpy as np
from PIL import Image

from modal_regions import golden_color, humanize_region_name, region_volume_stats, write_region_outputs, write_region_stats


def test_modal_regions_write_sidecar_and_pngs(tmp_path):
    label_vol = np.array([[[0, 1], [2, 2]]], dtype=np.uint8)
    region_dir, sidecar = write_region_outputs(
        "cloud_job",
        label_vol,
        {1: "heart", 2: "left_lung"},
        tmp_path,
        [1.0, 1.0],
        2.0,
        Image,
        np,
    )

    data = json.loads(sidecar.read_text())
    assert humanize_region_name("left_lung") == "Left lung"
    assert golden_color(1) != golden_color(2)
    assert region_dir.joinpath("0000.png").exists()
    assert data["regions"]["2"]["name"] == "Left lung"

    stats = region_volume_stats("cloud_job", label_vol, {1: "heart", 2: "left_lung"}, [1.0, 1.0], 2.0)
    assert stats["source"] == "modal:totalsegmentator"
    assert stats["sourceRegions"] == "data/cloud_job_regions.json"
    assert stats["regionVolumes"][1]["name"] == "Left lung"
    assert stats["regionVolumes"][1]["volumeMl"] == 0.004

    stats_path = write_region_stats("cloud_job", label_vol, {1: "heart", 2: "left_lung"}, tmp_path, [1.0, 1.0], 2.0)
    assert stats_path.name == "cloud_job_stats.json"
