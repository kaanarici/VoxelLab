from __future__ import annotations

from pathlib import Path

import pytest

import scripts.install_demo_data as demo_install

OPTIONAL_SAMPLE_PACKS = [
    "ome-microscopy-samples",
    "imagej-confocal-series-sample",
    "ome-zarr-public-metadata-sample",
]
PER_FILE_FIXTURE_PACKS = ["ome-microscopy-samples", "imagej-confocal-series-sample"]

@pytest.fixture(scope="module")
def catalog() -> dict:
    return demo_install.load_catalog()

@pytest.fixture()
def packs(catalog: dict) -> dict:
    return demo_install.packs_by_id(catalog)

def stack_keys(dimensions: list[int]) -> set[str]:
    """Local stack keys the viewer builds for a `[X, Y, Z, C, T]` fixture."""
    _x, _y, _z, channels, frames = dimensions
    return {f"{channel}|{frame}" for channel in range(channels) for frame in range(frames)}

def test_selected_packs_expand_a_mode_and_append_requested_extras(catalog: dict) -> None:
    fixture = {
        "modes": {"lite": ["lite"]},
        "packs": [{"id": "lite"}, {"id": "mri-source"}, {"id": "ct-source"}],
    }

    packs = demo_install.resolve_selected_packs(fixture, demo_mode="lite", include_mri=True, include_ct=True)

    assert [pack["id"] for pack in packs] == ["lite", "mri-source", "ct-source"]

def test_selected_packs_dedupe_repeated_requests_in_order() -> None:
    fixture = {"modes": {"lite": ["lite"]}, "packs": [{"id": "lite"}, {"id": "mri-source"}]}

    packs = demo_install.resolve_selected_packs(
        fixture,
        demo_mode="lite",
        requested=["lite", "mri-source", "lite", "mri-source"],
    )

    assert [pack["id"] for pack in packs] == ["lite", "mri-source"]

@pytest.mark.parametrize("pack_id", OPTIONAL_SAMPLE_PACKS)
def test_optional_sample_packs_stay_opt_in(catalog: dict, packs: dict, pack_id: str) -> None:
    pack = packs[pack_id]

    assert pack_id not in catalog["modes"][catalog["defaultMode"]]
    assert demo_install.resolve_selected_packs(catalog, demo_mode="none", requested=[pack_id]) == [pack]

@pytest.mark.parametrize("pack_id", OPTIONAL_SAMPLE_PACKS)
def test_optional_sample_packs_are_attributed_public_downloads(packs: dict, pack_id: str) -> None:
    pack = packs[pack_id]

    assert pack["kind"] == "source"
    assert pack["public_safe"] is True
    assert pack["target_dir"].startswith("demo_sources/")
    assert pack["source_url"].startswith("https://")
    assert pack["attribution"]["license"]

@pytest.mark.parametrize("pack_id", OPTIONAL_SAMPLE_PACKS)
def test_optional_sample_files_are_pinned_and_stay_inside_the_pack(packs: dict, pack_id: str) -> None:
    pack = packs[pack_id]

    assert pack["files"]
    for item in pack["files"]:
        path = Path(item["path"])
        assert item["url"].startswith(pack["source_url"])
        assert len(item["sha256"]) == 64
        assert item["size_bytes"] > 0
        assert not path.is_absolute()
        assert ".." not in path.parts

@pytest.mark.parametrize("pack_id", PER_FILE_FIXTURE_PACKS)
def test_fixture_contracts_describe_exactly_the_downloaded_files(packs: dict, pack_id: str) -> None:
    pack = packs[pack_id]
    contract_files = pack["fixture_contract"]["files"]

    assert {item["path"] for item in contract_files} == {item["path"] for item in pack["files"]}
    assert len({item["role"] for item in contract_files}) == len(contract_files)

@pytest.mark.parametrize("pack_id", PER_FILE_FIXTURE_PACKS)
def test_fixture_contract_stack_keys_follow_the_declared_channel_and_time_sizes(packs: dict, pack_id: str) -> None:
    for item in packs[pack_id]["fixture_contract"]["files"]:
        assert set(item["local_stack_keys"]) == stack_keys(item["dimensions"]), item["role"]
        assert len(item["local_stack_keys"]) == len(set(item["local_stack_keys"]))

def test_ome_sample_warnings_follow_the_declared_calibration_policy(packs: dict) -> None:
    contract = packs["ome-microscopy-samples"]["fixture_contract"]
    baseline = set(contract["calibration"]["expected_warnings"])

    assert "SizeZ > 1" in contract["calibration"]["z_warning_policy"]
    for item in contract["files"]:
        depth = item["dimensions"][2]
        expected = baseline | ({"missing_z_physical_size"} if depth > 1 else set())
        assert set(item["expected_warnings"]) == expected, item["role"]

def test_imagej_sample_declares_calibration_instead_of_warnings(packs: dict) -> None:
    calibration = packs["imagej-confocal-series-sample"]["fixture_contract"]["calibration"]

    assert calibration["expected_warnings"] == []
    assert calibration["expected_pixel_spacing_mm"] == [calibration["expected_slice_thickness_mm"]] * 2
    assert calibration["expected_slice_thickness_mm"] > 0

def test_zarr_sample_levels_agree_with_the_declared_dimensions(packs: dict) -> None:
    contract = packs["ome-zarr-public-metadata-sample"]["fixture_contract"]
    levels = contract["level_arrays"]

    assert contract["ngff_version"] == "0.4"
    assert contract["axes_order"] == "CZYX"
    assert contract["levels"] == [level["path"] for level in levels]
    assert contract["dimensions"] == levels[0]["shape"]
    for level in levels:
        assert len(level["shape"]) == len(contract["axes_order"])
        assert all(chunk <= size for chunk, size in zip(level["chunks"], level["shape"]))
    for finer, coarser in zip(levels, levels[1:]):
        assert coarser["shape"][-1] < finer["shape"][-1]
        assert coarser["shape"][:2] == finer["shape"][:2]

def test_zarr_sample_channel_metadata_covers_every_channel(packs: dict) -> None:
    contract = packs["ome-zarr-public-metadata-sample"]["fixture_contract"]
    channels = contract["dimensions"][0]

    for key in ("channels", "channel_colors", "channel_luts", "channel_data_ranges", "channel_display_ranges"):
        assert len(contract[key]) == channels, key
    assert set(contract["physical_spacing_mm"]) == set(contract["physical_units"])
    assert all(spacing > 0 for spacing in contract["physical_spacing_mm"].values())

def test_zarr_sample_files_stay_inside_the_declared_zarr_root(packs: dict) -> None:
    pack = packs["ome-zarr-public-metadata-sample"]
    root = Path(pack["fixture_contract"]["root"])

    for item in pack["files"]:
        assert Path(item["path"]).is_relative_to(root)
