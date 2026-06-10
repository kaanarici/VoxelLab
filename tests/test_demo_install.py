from __future__ import annotations

import json
import hashlib
import io
import struct
import zipfile
from pathlib import Path

import scripts.build_openneuro_lite_pack as openneuro_build
import scripts.install_demo_data as demo_install

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def png_header(width: int, height: int) -> bytes:
    return PNG_MAGIC + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", width, height) + b"\x08\x00\x00\x00\x00"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def test_resolve_selected_packs_expands_mode_and_extras() -> None:
    catalog = {
        "modes": {"lite": ["lite"]},
        "packs": [
            {"id": "lite"},
            {"id": "mri-source"},
            {"id": "ct-source"},
        ],
    }

    packs = demo_install.resolve_selected_packs(catalog, demo_mode="lite", include_mri=True, include_ct=True)

    assert [pack["id"] for pack in packs] == ["lite", "mri-source", "ct-source"]


def test_resolve_selected_packs_stably_dedupes_requested_ids() -> None:
    catalog = {
        "modes": {"lite": ["lite"]},
        "packs": [
            {"id": "lite"},
            {"id": "mri-source"},
        ],
    }

    packs = demo_install.resolve_selected_packs(
        catalog,
        demo_mode="lite",
        requested=["lite", "mri-source", "lite", "mri-source"],
    )

    assert [pack["id"] for pack in packs] == ["lite", "mri-source"]


def test_catalog_exposes_optional_ome_microscopy_sample_pack() -> None:
    catalog = demo_install.load_catalog()
    pack = demo_install.packs_by_id(catalog)["ome-microscopy-samples"]
    selected = demo_install.resolve_selected_packs(catalog, demo_mode="none", requested=["ome-microscopy-samples"])
    expected_hashes = {
        "single-channel.ome.tif": "8188f23c90bbdebcac5f0788596ccad5e524cfa6f20a87682882421c94be7175",
        "multi-channel.ome.tif": "ff98dcffeebc6ea7011ba3ece20b7f8841bed57949566eb2460e7da389be9fd3",
        "multi-channel-z-series.ome.tif": "f8cebdb6036060e433576bd0303f6f632fac6f2a71f2e7ceec08a13f34f69cba",
        "time-series.ome.tif": "3144b55bdaf72c48224bb01cccbbd865989d0308873d6bf4cfb0165731f5df15",
    }
    expected_sizes = {
        "single-channel.ome.tif": 76095,
        "multi-channel.ome.tif": 226459,
        "multi-channel-z-series.ome.tif": 1128003,
        "time-series.ome.tif": 526767,
    }

    assert selected == [pack]
    assert "ome-microscopy-samples" not in catalog["modes"][catalog["defaultMode"]]
    assert pack["kind"] == "source"
    assert pack["public_safe"] is True
    assert pack["target_dir"].startswith("demo_sources/")
    assert pack["source_url"] == "https://downloads.openmicroscopy.org/images/OME-TIFF/2016-06/bioformats-artificial/"
    assert pack["attribution"]["license"] == "CC BY 4.0"
    assert pack["attribution"]["documentation_url"] == "https://ome-model.readthedocs.io/en/stable/ome-tiff/data.html#artificial-datasets"
    assert {Path(item["path"]).name: item["sha256"] for item in pack["files"]} == expected_hashes
    assert {Path(item["path"]).name: item["size_bytes"] for item in pack["files"]} == expected_sizes
    assert all(item["url"].startswith(pack["source_url"]) for item in pack["files"])
    assert all(Path(item["path"]).parts[0] == "bioformats-artificial" for item in pack["files"])
    assert pack["fixture_contract"]["axes_order"] == "XYZCT"
    assert "MakeTestOmeTiff" in pack["fixture_contract"]["source"]
    assert pack["fixture_contract"]["calibration"] == {
        "xy_physical_size": "missing",
        "z_physical_size": "missing",
        "expected_pixel_spacing_mm": [0, 0],
        "expected_slice_thickness_mm": 0,
        "expected_warnings": ["missing_xy_physical_size"],
        "z_warning_policy": "missing_z_physical_size applies only when SizeZ > 1",
    }
    assert {item["path"] for item in pack["fixture_contract"]["files"]} == {item["path"] for item in pack["files"]}
    assert {
        item["role"]: item["dimensions"]
        for item in pack["fixture_contract"]["files"]
    } == {
        "single-channel": [439, 167, 1, 1, 1],
        "multi-channel": [439, 167, 1, 3, 1],
        "multi-channel-z-series": [439, 167, 5, 3, 1],
        "time-series": [439, 167, 1, 1, 7],
    }
    assert {
        item["role"]: item["local_stack_keys"]
        for item in pack["fixture_contract"]["files"]
    } == {
        "single-channel": ["0|0"],
        "multi-channel": ["0|0", "1|0", "2|0"],
        "multi-channel-z-series": ["0|0", "1|0", "2|0"],
        "time-series": ["0|0", "0|1", "0|2", "0|3", "0|4", "0|5", "0|6"],
    }
    assert {
        item["role"]: item["expected_warnings"]
        for item in pack["fixture_contract"]["files"]
    } == {
        "single-channel": ["missing_xy_physical_size"],
        "multi-channel": ["missing_xy_physical_size"],
        "multi-channel-z-series": ["missing_xy_physical_size", "missing_z_physical_size"],
        "time-series": ["missing_xy_physical_size"],
    }


def test_package_exposes_combined_microscopy_public_sample_verifier() -> None:
    package = json.loads((Path(__file__).parents[1] / "package.json").read_text())
    scripts = package["scripts"]
    verifier = (Path(__file__).parents[1] / "scripts/verify_microscopy_public_samples.mjs").read_text()

    assert scripts["demo:verify:microscopy"] == "node scripts/verify_microscopy_public_samples.mjs"
    assert scripts["check:lab"] == "node scripts/check_lab_readiness.mjs"
    assert "verify_ome_microscopy_samples.mjs" in verifier
    assert "verify_imagej_microscopy_sample.mjs" in verifier
    assert "verify_ome_zarr_public_sample.mjs" in verifier
    assert "not Fiji, Bio-Formats, or proprietary-format parity" in verifier


def test_catalog_exposes_optional_imagej_calibrated_sample_pack() -> None:
    catalog = demo_install.load_catalog()
    pack = demo_install.packs_by_id(catalog)["imagej-confocal-series-sample"]
    selected = demo_install.resolve_selected_packs(catalog, demo_mode="none", requested=["imagej-confocal-series-sample"])

    assert selected == [pack]
    assert "imagej-confocal-series-sample" not in catalog["modes"][catalog["defaultMode"]]
    assert pack["kind"] == "source"
    assert pack["public_safe"] is True
    assert pack["target_dir"].startswith("demo_sources/")
    assert pack["source_url"] == "https://wsr.imagej.net/images/confocal-series.zip"
    assert pack["attribution"]["documentation_url"] == "https://imagej.net/ij/docs/guide/146-8.html"
    assert pack["attribution"]["license"] == "public sample; not bundled"
    assert pack["files"] == [
        {
            "url": "https://wsr.imagej.net/images/confocal-series.zip",
            "path": "imagej/confocal-series.zip",
            "sha256": "e1114e37bb442cfd05a5b701cf557b1fd12991cf9c9cd40390a4c0259a092df9",
            "size_bytes": 2386406,
        }
    ]
    assert pack["fixture_contract"]["axes_order"] == "XYCZT"
    assert pack["fixture_contract"]["calibration"] == {
        "xy_source": "TIFF XResolution/YResolution interpreted by the ImageJ TIFF convention with unit=um",
        "z_source": "ImageJ ImageDescription spacing=0.05445500181716341 with unit=um",
        "expected_pixel_spacing_mm": [0.00005445500181716341, 0.00005445500181716341],
        "expected_slice_thickness_mm": 0.00005445500181716341,
        "expected_warnings": [],
    }
    assert pack["fixture_contract"]["files"] == [
        {
            "path": "imagej/confocal-series.zip",
            "archive_member": "confocal-series.tif",
            "role": "calibrated-confocal-hyperstack",
            "dimensions": [400, 400, 25, 2, 1],
            "local_stack_keys": ["0|0", "1|0"],
            "pixel_type": "uint8",
            "sha256": "c03b1fc2c952b841302a51d9585cc0c0fce75828445f9c7e808c58e0846bd149",
            "size_bytes": 8008849,
        }
    ]


def test_catalog_exposes_optional_ome_zarr_public_metadata_pack() -> None:
    catalog = demo_install.load_catalog()
    pack = demo_install.packs_by_id(catalog)["ome-zarr-public-metadata-sample"]
    selected = demo_install.resolve_selected_packs(catalog, demo_mode="none", requested=["ome-zarr-public-metadata-sample"])
    expected_sizes = {
        ".zgroup": 24,
        ".zattrs": 3343,
        "0/.zarray": 417,
        "1/.zarray": 417,
        "2/.zarray": 413,
    }

    assert selected == [pack]
    assert "ome-zarr-public-metadata-sample" not in catalog["modes"][catalog["defaultMode"]]
    assert pack["kind"] == "source"
    assert pack["public_safe"] is True
    assert pack["target_dir"].startswith("demo_sources/")
    assert pack["source_url"] == "https://livingobjects.ebi.ac.uk/idr/zarr/v0.4/idr0062A/6001240.zarr/"
    assert pack["attribution"]["license"] == "CC BY 4.0"
    assert pack["attribution"]["url"] == "https://idr.github.io/ome-ngff-samples/"
    assert {str(Path(item["path"]).relative_to("idr0062A/6001240.zarr")): item["size_bytes"] for item in pack["files"]} == expected_sizes
    assert all(item["url"].startswith(pack["source_url"]) for item in pack["files"])
    assert all(Path(item["path"]).parts[:2] == ("idr0062A", "6001240.zarr") for item in pack["files"])
    assert pack["fixture_contract"]["ngff_version"] == "0.4"
    assert pack["fixture_contract"]["axes_order"] == "CZYX"
    assert pack["fixture_contract"]["dimensions"] == [2, 236, 275, 271]
    assert pack["fixture_contract"]["pixel_type"] == "uint16"
    assert pack["fixture_contract"]["channels"] == ["LaminB1", "Dapi"]
    assert pack["fixture_contract"]["channel_colors"] == ["#0000FF", "#FFFF00"]
    assert pack["fixture_contract"]["channel_luts"] == ["linear", "linear"]
    assert pack["fixture_contract"]["channel_data_ranges"] == [[0, 65535], [0, 65535]]
    assert pack["fixture_contract"]["channel_display_ranges"] == [[0, 1500], [0, 1500]]
    assert pack["fixture_contract"]["physical_units"] == {
        "z": "micrometer",
        "y": "micrometer",
        "x": "micrometer",
    }
    assert pack["fixture_contract"]["physical_spacing_mm"] == {
        "z": 0.0005002025531914894,
        "y": 0.0003603981534640209,
        "x": 0.0003603981534640209,
    }
    assert "Metadata verification only" in pack["fixture_contract"]["first_party_boundary"]


def test_install_artifact_pack_extracts_data_and_merges_manifest(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(demo_install, "ROOT", tmp_path)
    pack_dir = tmp_path / "demo_packs"
    pack_dir.mkdir()
    archive_path = pack_dir / "fixture.zip"
    with zipfile.ZipFile(archive_path, "w") as bundle:
        bundle.writestr(
            "manifest.json",
            json.dumps(
                {
                    "patient": "demo",
                    "studyDate": "",
                    "series": [
                        {
                            "slug": "sample",
                            "name": "Sample",
                            "description": "Fixture",
                            "slices": 2,
                            "width": 2,
                            "height": 1,
                            "pixelSpacing": [0.5, 0.5],
                            "sliceThickness": 1.0,
                            "hasBrain": False,
                            "hasSeg": False,
                            "hasRaw": False,
                            "hasRegions": False,
                            "hasStats": False,
                            "hasAnalysis": False,
                        }
                    ],
                }
            ),
        )
        bundle.writestr("sample/0000.png", png_header(2, 1))
        bundle.writestr("sample/0001.png", png_header(2, 1))

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    _ = (data_dir / "manifest.json").write_text(
        json.dumps(
            {
                "patient": "anonymous",
                "studyDate": "",
                "series": [{"slug": "existing", "name": "Existing", "description": "", "slices": 1, "width": 1, "height": 1, "pixelSpacing": [1, 1], "sliceThickness": 1, "hasBrain": False, "hasSeg": False, "hasRaw": False, "hasRegions": False, "hasStats": False, "hasAnalysis": False}],
            }
        ),
        encoding="utf-8",
    )

    result = demo_install.install_artifact_pack({"id": "lite", "archive_path": "demo_packs/fixture.zip"}, data_dir)

    manifest = json.loads((data_dir / "manifest.json").read_text(encoding="utf-8"))
    assert result["installed"] == ["sample"]
    assert (data_dir / "sample" / "0000.png").is_file()
    assert [series["slug"] for series in manifest["series"]] == ["existing", "sample"]


def test_install_artifact_pack_merges_into_legacy_manifest_without_names(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(demo_install, "ROOT", tmp_path)
    pack_dir = tmp_path / "demo_packs"
    pack_dir.mkdir()
    archive_path = pack_dir / "fixture.zip"
    with zipfile.ZipFile(archive_path, "w") as bundle:
        bundle.writestr(
            "manifest.json",
            json.dumps(
                {
                    "patient": "demo",
                    "studyDate": "",
                    "series": [
                        {
                            "slug": "sample",
                            "name": "Sample",
                            "description": "Fixture",
                            "slices": 1,
                            "width": 2,
                            "height": 1,
                            "pixelSpacing": [0.5, 0.5],
                            "sliceThickness": 1.0,
                            "hasBrain": False,
                            "hasSeg": False,
                            "hasRaw": False,
                            "hasRegions": False,
                            "hasStats": False,
                            "hasAnalysis": False,
                        }
                    ],
                }
            ),
        )
        bundle.writestr("sample/0000.png", png_header(2, 1))

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    _ = (data_dir / "manifest.json").write_text(
        json.dumps({"patient": "anonymous", "studyDate": "", "series": [{"slug": "legacy"}]}),
        encoding="utf-8",
    )

    result = demo_install.install_artifact_pack({"id": "lite", "archive_path": "demo_packs/fixture.zip"}, data_dir)

    manifest = json.loads((data_dir / "manifest.json").read_text(encoding="utf-8"))
    assert result["installed"] == ["sample"]
    assert [series["slug"] for series in manifest["series"]] == ["legacy", "sample"]


def test_write_json_preserves_existing_file_when_replace_fails(tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "manifest.json"
    _ = path.write_text("old", encoding="utf-8")

    def fail_replace(self: Path, target: Path):
        assert target == path
        raise RuntimeError("replace failed")

    monkeypatch.setattr(Path, "replace", fail_replace)

    with __import__("pytest").raises(RuntimeError, match="replace failed"):
        demo_install.write_json(path, {"patient": "anonymous"})

    assert path.read_text(encoding="utf-8") == "old"
    assert not (tmp_path / ".manifest.json.tmp").exists()


def test_copy_pack_tree_preserves_existing_series_when_copy_fails(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "source"
    data_dir = tmp_path / "data"
    (source / "sample").mkdir(parents=True)
    _ = (source / "sample" / "0000.png").write_bytes(b"new")
    (data_dir / "sample").mkdir(parents=True)
    _ = (data_dir / "sample" / "0000.png").write_bytes(b"old")

    def fail_copytree(_src, dest):
        Path(dest).mkdir(parents=True)
        _ = (Path(dest) / "partial.png").write_bytes(b"partial")
        raise RuntimeError("copy failed")

    monkeypatch.setattr(demo_install.shutil, "copytree", fail_copytree)

    with __import__("pytest").raises(RuntimeError, match="copy failed"):
        demo_install.copy_pack_tree(source, data_dir, ["sample"])

    assert (data_dir / "sample" / "0000.png").read_bytes() == b"old"
    assert not (data_dir / ".sample.install").exists()


def test_install_source_pack_copies_local_files_and_writes_notice(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    payload = b"fake"
    _ = (source / "scan.nii.gz").write_bytes(payload)

    pack = {
        "id": "mri-source",
        "title": "MRI Source Files",
        "target_dir": "demo_sources/openneuro_on01802",
        "license_note": "CC0",
        "attribution": {"title": "Demo"},
        "files": [
            {
                "url": str(source / "scan.nii.gz"),
                "path": "sub-ON01802/ses-01/anat/scan.nii.gz",
                "sha256": sha256_bytes(payload),
            }
        ],
    }

    result = demo_install.install_source_pack(pack, tmp_path)

    target = tmp_path / "demo_sources" / "openneuro_on01802"
    notice = json.loads((target / "PACK_INFO.json").read_text(encoding="utf-8"))
    assert result["installed"] == ["sub-ON01802/ses-01/anat/scan.nii.gz"]
    assert (target / "sub-ON01802" / "ses-01" / "anat" / "scan.nii.gz").read_bytes() == b"fake"
    assert notice["pack"] == "mri-source"


def test_install_artifact_pack_rejects_zip_members_that_escape_target(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(demo_install, "ROOT", tmp_path)
    pack_dir = tmp_path / "demo_packs"
    pack_dir.mkdir()
    archive_path = pack_dir / "fixture.zip"
    with zipfile.ZipFile(archive_path, "w") as bundle:
        bundle.writestr("../escape.txt", b"boom")

    with __import__("pytest").raises(ValueError, match="escapes extraction root"):
        _ = demo_install.install_artifact_pack({"id": "lite", "archive_path": "demo_packs/fixture.zip"}, tmp_path / "data")


def test_install_source_pack_requires_checksums(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _ = (source / "scan.nii.gz").write_bytes(b"fake")

    pack = {
        "id": "mri-source",
        "title": "MRI Source Files",
        "target_dir": "demo_sources/openneuro_on01802",
        "license_note": "CC0",
        "attribution": {"title": "Demo"},
        "files": [
            {
                "url": str(source / "scan.nii.gz"),
                "path": "sub-ON01802/ses-01/anat/scan.nii.gz",
            }
        ],
    }

    with __import__("pytest").raises(ValueError, match="expected sha256 checksum"):
        _ = demo_install.install_source_pack(pack, tmp_path)


def test_install_source_pack_rejects_target_dirs_that_escape_root(tmp_path: Path) -> None:
    pack = {
        "id": "mri-source",
        "title": "MRI Source Files",
        "target_dir": "../outside",
        "license_note": "CC0",
        "attribution": {"title": "Demo"},
        "files": [
            {
                "url": "https://example.test/scan.nii.gz",
                "path": "scan.nii.gz",
                "sha256": "0" * 64,
            }
        ],
    }

    with __import__("pytest").raises(ValueError, match="path must stay inside pack target"):
        _ = demo_install.install_source_pack(pack, tmp_path)

    assert not (tmp_path.parent / "outside").exists()


def test_install_source_pack_rejects_file_paths_that_escape_target(tmp_path: Path) -> None:
    pack = {
        "id": "mri-source",
        "title": "MRI Source Files",
        "target_dir": "demo_sources/openneuro_on01802",
        "license_note": "CC0",
        "attribution": {"title": "Demo"},
        "files": [
            {
                "url": "https://example.test/scan.nii.gz",
                "path": "../scan.nii.gz",
                "sha256": "0" * 64,
            }
        ],
    }

    with __import__("pytest").raises(ValueError, match="path must stay inside pack target"):
        _ = demo_install.install_source_pack(pack, tmp_path)

    assert not (tmp_path / "scan.nii.gz").exists()


def test_install_source_pack_rejects_series_zip_paths_that_escape_target(tmp_path: Path) -> None:
    pack = {
        "id": "ct-source",
        "title": "CT Source Files",
        "target_dir": "demo_sources/ct",
        "license_note": "CC BY",
        "series_zips": [
            {
                "patient_id": "../PATIENT_001",
                "url": "https://example.test/patient.zip",
                "sha256": "0" * 64,
            }
        ],
    }

    with __import__("pytest").raises(ValueError, match="path must stay inside pack target"):
        _ = demo_install.install_source_pack(pack, tmp_path)

    assert not (tmp_path / "demo_sources" / "PATIENT_001").exists()


def test_install_source_pack_replaces_existing_file_with_bad_checksum(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _ = (source / "scan.nii.gz").write_bytes(b"fresh")
    target = tmp_path / "demo_sources" / "openneuro_on01802" / "sub-ON01802" / "ses-01" / "anat"
    target.mkdir(parents=True)
    _ = (target / "scan.nii.gz").write_bytes(b"stale")

    pack = {
        "id": "mri-source",
        "title": "MRI Source Files",
        "target_dir": "demo_sources/openneuro_on01802",
        "license_note": "CC0",
        "attribution": {"title": "Demo"},
        "files": [
            {
                "url": str(source / "scan.nii.gz"),
                "path": "sub-ON01802/ses-01/anat/scan.nii.gz",
                "sha256": sha256_bytes(b"fresh"),
            }
        ],
    }

    result = demo_install.install_source_pack(pack, tmp_path)

    assert result["installed"] == ["sub-ON01802/ses-01/anat/scan.nii.gz"]
    assert (target / "scan.nii.gz").read_bytes() == b"fresh"


def test_install_source_pack_keeps_existing_file_when_replacement_download_fails(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "demo_sources" / "openneuro_on01802" / "sub-ON01802" / "ses-01" / "anat"
    target.mkdir(parents=True)
    _ = (target / "scan.nii.gz").write_bytes(b"stale")

    def fail_download(*_args, **_kwargs):
        raise ValueError("download failed")

    monkeypatch.setattr(demo_install, "download_to_path", fail_download)

    pack = {
        "id": "mri-source",
        "title": "MRI Source Files",
        "target_dir": "demo_sources/openneuro_on01802",
        "license_note": "CC0",
        "attribution": {"title": "Demo"},
        "files": [
            {
                "url": "https://example.test/scan.nii.gz",
                "path": "sub-ON01802/ses-01/anat/scan.nii.gz",
                "sha256": sha256_bytes(b"fresh"),
            }
        ],
    }

    with __import__("pytest").raises(ValueError, match="download failed"):
        _ = demo_install.install_source_pack(pack, tmp_path)

    assert (target / "scan.nii.gz").read_bytes() == b"stale"


def test_install_source_pack_removes_new_bad_download(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _ = (source / "scan.nii.gz").write_bytes(b"bad")

    pack = {
        "id": "mri-source",
        "title": "MRI Source Files",
        "target_dir": "demo_sources/openneuro_on01802",
        "license_note": "CC0",
        "attribution": {"title": "Demo"},
        "files": [
            {
                "url": str(source / "scan.nii.gz"),
                "path": "sub-ON01802/ses-01/anat/scan.nii.gz",
                "sha256": sha256_bytes(b"fresh"),
            }
        ],
    }

    with __import__("pytest").raises(ValueError, match="sha256"):
        _ = demo_install.install_source_pack(pack, tmp_path)

    assert not (
        tmp_path / "demo_sources" / "openneuro_on01802" / "sub-ON01802" / "ses-01" / "anat" / "scan.nii.gz"
    ).exists()


def test_install_source_pack_checks_catalog_size_when_present(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    payload = b"fresh"
    _ = (source / "scan.nii.gz").write_bytes(payload)

    pack = {
        "id": "mri-source",
        "title": "MRI Source Files",
        "target_dir": "demo_sources/openneuro_on01802",
        "license_note": "CC0",
        "attribution": {"title": "Demo"},
        "files": [
            {
                "url": str(source / "scan.nii.gz"),
                "path": "sub-ON01802/ses-01/anat/scan.nii.gz",
                "sha256": sha256_bytes(payload),
                "size_bytes": len(payload) + 1,
            }
        ],
    }

    with __import__("pytest").raises(ValueError, match="size"):
        _ = demo_install.install_source_pack(pack, tmp_path)


def test_download_to_path_stops_when_catalog_size_is_exceeded(tmp_path: Path, monkeypatch) -> None:
    class FakeResponse:
        def __init__(self, payload: bytes):
            self.body = io.BytesIO(payload)

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, size: int = -1) -> bytes:
            return self.body.read(size)

    monkeypatch.setattr(demo_install.urllib.request, "urlopen", lambda *_args, **_kwargs: FakeResponse(b"too-large"))

    target = tmp_path / "demo_sources" / "sample.ome.tif"
    with __import__("pytest").raises(ValueError, match="exceeded expected size"):
        _ = demo_install.download_to_path("https://example.test/sample.ome.tif", target, max_bytes=4)

    assert not target.exists()
    assert not (target.parent / ".sample.ome.tif.download").exists()


def test_download_to_path_preserves_existing_target_when_download_fails(tmp_path: Path, monkeypatch) -> None:
    class FakeResponse:
        def __init__(self, payload: bytes):
            self.body = io.BytesIO(payload)

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, size: int = -1) -> bytes:
            return self.body.read(size)

    monkeypatch.setattr(demo_install.urllib.request, "urlopen", lambda *_args, **_kwargs: FakeResponse(b"too-large"))

    target = tmp_path / "demo_sources" / "sample.ome.tif"
    target.parent.mkdir(parents=True)
    _ = target.write_bytes(b"existing")

    with __import__("pytest").raises(ValueError, match="exceeded expected size"):
        _ = demo_install.download_to_path("https://example.test/sample.ome.tif", target, max_bytes=4)

    assert target.read_bytes() == b"existing"
    assert not (target.parent / ".sample.ome.tif.download").exists()


def test_install_source_pack_caps_series_zip_download_from_catalog_estimate(tmp_path: Path, monkeypatch) -> None:
    class FakeResponse:
        def __init__(self, payload: bytes):
            self.body = io.BytesIO(payload)

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, size: int = -1) -> bytes:
            return self.body.read(size)

    monkeypatch.setattr(demo_install.urllib.request, "urlopen", lambda *_args, **_kwargs: FakeResponse(b"too-large"))

    pack = {
        "id": "ct-source",
        "title": "CT Source Files",
        "target_dir": "demo_sources/ct",
        "license_note": "CC BY",
        "estimated_size_mb": 4 / (1024 * 1024),
        "series_zips": [
            {
                "patient_id": "PATIENT_001",
                "url": "https://example.test/patient.zip",
                "sha256": "0" * 64,
            }
        ],
    }

    with __import__("pytest").raises(ValueError, match="exceeded expected size"):
        _ = demo_install.install_source_pack(pack, tmp_path)

    assert not (tmp_path / "demo_sources" / "ct" / "PATIENT_001").exists()


def test_install_source_pack_does_not_leave_partial_series_dir_on_extract_failure(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "source"
    source.mkdir()
    zip_path = source / "patient.zip"
    with zipfile.ZipFile(zip_path, "w") as bundle:
        bundle.writestr("IM0001.dcm", b"dicom-bytes")

    def fail_extract(_bundle, target_dir: Path) -> None:
        target_dir.mkdir(parents=True)
        _ = (target_dir / "partial.dcm").write_bytes(b"partial")
        raise ValueError("extract failed")

    monkeypatch.setattr(demo_install, "extract_zip_safe", fail_extract)

    pack = {
        "id": "ct-source",
        "title": "CT Source Files",
        "target_dir": "demo_sources/ct",
        "license_note": "CC BY",
        "series_zips": [
            {
                "patient_id": "PATIENT_001",
                "url": str(zip_path),
                "sha256": demo_install.sha256_zip_contents(zip_path),
            }
        ],
    }

    with __import__("pytest").raises(ValueError, match="extract failed"):
        _ = demo_install.install_source_pack(pack, tmp_path)

    assert not (tmp_path / "demo_sources" / "ct" / "PATIENT_001").exists()


def test_install_source_pack_reinstalls_hidden_only_series_dir(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    zip_path = source / "patient.zip"
    with zipfile.ZipFile(zip_path, "w") as bundle:
        bundle.writestr("IM0001.dcm", b"dicom-bytes")

    stale_dir = tmp_path / "demo_sources" / "ct" / "PATIENT_001"
    stale_dir.mkdir(parents=True)
    _ = (stale_dir / ".DS_Store").write_bytes(b"")

    pack = {
        "id": "ct-source",
        "title": "CT Source Files",
        "target_dir": "demo_sources/ct",
        "license_note": "CC BY",
        "series_zips": [
            {
                "patient_id": "PATIENT_001",
                "url": str(zip_path),
                "sha256": demo_install.sha256_zip_contents(zip_path),
            }
        ],
    }

    result = demo_install.install_source_pack(pack, tmp_path)

    assert result["installed"] == ["PATIENT_001/"]
    assert (stale_dir / "IM0001.dcm").read_bytes() == b"dicom-bytes"
    assert not (stale_dir / ".DS_Store").exists()


def test_install_source_pack_reinstalls_series_dir_without_matching_marker(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    zip_path = source / "patient.zip"
    with zipfile.ZipFile(zip_path, "w") as bundle:
        bundle.writestr("IM0001.dcm", b"fresh-dicom")

    stale_dir = tmp_path / "demo_sources" / "ct" / "PATIENT_001"
    stale_dir.mkdir(parents=True)
    _ = (stale_dir / "IM0001.dcm").write_bytes(b"stale-dicom")

    checksum = demo_install.sha256_zip_contents(zip_path)
    pack = {
        "id": "ct-source",
        "title": "CT Source Files",
        "target_dir": "demo_sources/ct",
        "license_note": "CC BY",
        "series_zips": [
            {
                "patient_id": "PATIENT_001",
                "url": str(zip_path),
                "sha256": checksum,
            }
        ],
    }

    result = demo_install.install_source_pack(pack, tmp_path)

    marker = json.loads((stale_dir / demo_install.SOURCE_ZIP_MARKER).read_text(encoding="utf-8"))
    assert result["installed"] == ["PATIENT_001/"]
    assert (stale_dir / "IM0001.dcm").read_bytes() == b"fresh-dicom"
    assert marker == {"sha256": checksum}


def test_install_source_pack_reuses_series_dir_with_matching_marker(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    zip_path = source / "patient.zip"
    with zipfile.ZipFile(zip_path, "w") as bundle:
        bundle.writestr("IM0001.dcm", b"fresh-dicom")

    checksum = demo_install.sha256_zip_contents(zip_path)
    existing_dir = tmp_path / "demo_sources" / "ct" / "PATIENT_001"
    existing_dir.mkdir(parents=True)
    _ = (existing_dir / "IM0001.dcm").write_bytes(b"already-installed")
    demo_install.write_json(existing_dir / demo_install.SOURCE_ZIP_MARKER, {"sha256": checksum})

    pack = {
        "id": "ct-source",
        "title": "CT Source Files",
        "target_dir": "demo_sources/ct",
        "license_note": "CC BY",
        "series_zips": [
            {
                "patient_id": "PATIENT_001",
                "url": str(zip_path),
                "sha256": checksum,
            }
        ],
    }

    result = demo_install.install_source_pack(pack, tmp_path)

    assert result["installed"] == ["PATIENT_001/"]
    assert (existing_dir / "IM0001.dcm").read_bytes() == b"already-installed"


def test_series_zip_checksum_ignores_zip_wrapper_metadata(tmp_path: Path) -> None:
    first = tmp_path / "first.zip"
    second = tmp_path / "second.zip"
    shared_payload = b"dicom-bytes"
    first_info = zipfile.ZipInfo("patient/IM0001.dcm")
    first_info.date_time = (2024, 1, 1, 0, 0, 0)
    second_info = zipfile.ZipInfo("patient/IM0001.dcm")
    second_info.date_time = (2025, 1, 1, 0, 0, 0)
    with zipfile.ZipFile(first, "w") as bundle:
        bundle.writestr(first_info, shared_payload)
    with zipfile.ZipFile(second, "w") as bundle:
        bundle.writestr(second_info, shared_payload)

    assert demo_install.sha256_file(first) != demo_install.sha256_file(second)
    demo_install.verify_zip_contents_checksum(second, demo_install.sha256_zip_contents(first))


def test_openneuro_lite_build_uses_bounded_atomic_downloads(tmp_path: Path, monkeypatch) -> None:
    calls = []

    def fake_download_to_path(url: str, target: Path, max_bytes: int | None = None) -> Path:
        calls.append((url, target.name, max_bytes))
        target.parent.mkdir(parents=True, exist_ok=True)
        _ = target.write_bytes(b"download")
        return target

    def fake_load_volume(_nifti_path: Path, b0_path: Path | None = None):
        assert b0_path is not None
        return "volume", {
            "width": 2,
            "height": 2,
            "slices": 1,
            "pixelSpacing": [1, 1],
            "sliceThickness": 1,
            "sliceSpacing": 1,
            "sliceSpacingRegular": True,
            "firstIPP": [0, 0, 0],
            "lastIPP": [0, 0, 0],
            "orientation": [1, 0, 0, 0, 1, 0],
        }

    monkeypatch.setattr(openneuro_build, "download_to_path", fake_download_to_path)
    monkeypatch.setattr(openneuro_build, "load_volume", fake_load_volume)
    monkeypatch.setattr(openneuro_build, "write_png_stack", lambda _volume, _dest: (0, 1))

    def fake_write_raw_u16(_volume, out_path: Path) -> None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        _ = out_path.write_bytes(b"raw")

    monkeypatch.setattr(openneuro_build, "write_raw_u16", fake_write_raw_u16)

    entry = openneuro_build.build_series(
        tmp_path / "data",
        {
            "slug": "demo",
            "name": "Demo",
            "description": "Demo",
            "url": "https://example.test/demo.nii.gz",
            "bval_url": "https://example.test/demo.bval",
            "modality": "MR",
            "sequence": "DWI",
        },
        tmp_path / "downloads",
    )

    assert entry["slug"] == "demo"
    assert calls == [
        ("https://example.test/demo.nii.gz", "demo.nii.gz", openneuro_build.MAX_OPENNEURO_SOURCE_BYTES),
        ("https://example.test/demo.bval", "demo.bval", openneuro_build.MAX_OPENNEURO_SOURCE_BYTES),
    ]


def test_update_catalog_checksum_sets_matching_archive_entry(tmp_path: Path) -> None:
    pack_path = tmp_path / "demo_packs" / "fixture.zip"
    pack_path.parent.mkdir()
    _ = pack_path.write_bytes(b"fixture")
    catalog_path = tmp_path / "demo_packs" / "catalog.json"
    _ = catalog_path.write_text(
        json.dumps(
            {
                "packs": [
                    {"id": "lite", "archive_path": "demo_packs/fixture.zip", "checksum": ""},
                    {"id": "other", "archive_path": "demo_packs/other.zip", "checksum": ""},
                ]
            }
        ),
        encoding="utf-8",
    )

    openneuro_build.update_catalog_checksum(pack_path, catalog_path)

    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    assert len(catalog["packs"][0]["checksum"]) == 64
    assert catalog["packs"][1]["checksum"] == ""
