from __future__ import annotations

import hashlib
import json
import struct
import zipfile
from pathlib import Path

import pytest

import scripts.build_openneuro_lite_pack as openneuro_build
import scripts.install_demo_data as demo_install

from tests.helpers.python.streams import FakeHTTPResponse

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
NIFTI_REL_PATH = "sub-ON01802/ses-01/anat/scan.nii.gz"

def png_header(width: int, height: int) -> bytes:
    return PNG_MAGIC + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", width, height) + b"\x08\x00\x00\x00\x00"

def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def artifact_pack(root: Path, series: dict, slice_count: int) -> dict:
    """Write a demo pack archive and return the catalog entry that installs it."""
    pack_dir = root / "demo_packs"
    pack_dir.mkdir(exist_ok=True)
    with zipfile.ZipFile(pack_dir / "fixture.zip", "w") as bundle:
        bundle.writestr("manifest.json", json.dumps({"patient": "demo", "studyDate": "", "series": [series]}))
        for index in range(slice_count):
            bundle.writestr(f"{series['slug']}/{index:04d}.png", png_header(series["width"], series["height"]))
    return {"id": "lite", "archive_path": "demo_packs/fixture.zip"}

def pack_series(**overrides) -> dict:
    series = {
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
    series.update(overrides)
    return series

def source_pack(**overrides) -> dict:
    pack = {
        "id": "mri-source",
        "title": "MRI Source Files",
        "target_dir": "demo_sources/openneuro_on01802",
        "license_note": "CC0",
        "attribution": {"title": "Demo"},
    }
    pack.update(overrides)
    return pack

def local_file_pack(source: Path, payload: bytes | None = None, **file_overrides) -> dict:
    """A source pack whose single file is fetched from a local path."""
    entry = {"url": str(source), "path": NIFTI_REL_PATH}
    if payload is not None:
        entry["sha256"] = sha256_bytes(payload)
    entry.update(file_overrides)
    return source_pack(files=[entry])

def responding_urlopen(monkeypatch, *responses: FakeHTTPResponse, record_ranges: list | None = None):
    remaining = iter(responses)

    def fake_urlopen(request, **_kwargs):
        if record_ranges is not None:
            is_request = isinstance(request, demo_install.urllib.request.Request)
            record_ranges.append(request.get_header("Range") if is_request else None)
        return next(remaining)

    monkeypatch.setattr(demo_install.urllib.request, "urlopen", fake_urlopen)

def test_artifact_pack_extracts_its_stack_and_merges_the_manifest(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(demo_install, "ROOT", tmp_path)
    pack = artifact_pack(tmp_path, pack_series(), 2)
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    _ = (data_dir / "manifest.json").write_text(
        json.dumps({
            "patient": "anonymous",
            "studyDate": "",
            "series": [pack_series(slug="existing", name="Existing", description="", slices=1, width=1, height=1, pixelSpacing=[1, 1], sliceThickness=1)],
        }),
        encoding="utf-8",
    )

    result = demo_install.install_artifact_pack(pack, data_dir)

    manifest = json.loads((data_dir / "manifest.json").read_text(encoding="utf-8"))
    assert result["installed"] == ["sample"]
    assert (data_dir / "sample" / "0000.png").is_file()
    assert [series["slug"] for series in manifest["series"]] == ["existing", "sample"]

def test_artifact_pack_merges_into_a_manifest_whose_entries_lack_names(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(demo_install, "ROOT", tmp_path)
    pack = artifact_pack(tmp_path, pack_series(slices=1), 1)
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    _ = (data_dir / "manifest.json").write_text(
        json.dumps({"patient": "anonymous", "studyDate": "", "series": [{"slug": "legacy"}]}),
        encoding="utf-8",
    )

    result = demo_install.install_artifact_pack(pack, data_dir)

    manifest = json.loads((data_dir / "manifest.json").read_text(encoding="utf-8"))
    assert result["installed"] == ["sample"]
    assert [series["slug"] for series in manifest["series"]] == ["legacy", "sample"]

def test_artifact_pack_rejects_zip_members_that_escape_the_extraction_root(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(demo_install, "ROOT", tmp_path)
    pack_dir = tmp_path / "demo_packs"
    pack_dir.mkdir()
    with zipfile.ZipFile(pack_dir / "fixture.zip", "w") as bundle:
        bundle.writestr("../escape.txt", b"boom")

    with pytest.raises(ValueError, match="escapes extraction root"):
        _ = demo_install.install_artifact_pack({"id": "lite", "archive_path": "demo_packs/fixture.zip"}, tmp_path / "data")

def test_manifest_writes_keep_the_previous_file_when_the_replace_fails(tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "manifest.json"
    _ = path.write_text("old", encoding="utf-8")

    def fail_replace(self: Path, target: Path):
        assert target == path
        raise RuntimeError("replace failed")

    monkeypatch.setattr(Path, "replace", fail_replace)

    with pytest.raises(RuntimeError, match="replace failed"):
        demo_install.write_json(path, {"patient": "anonymous"})

    assert path.read_text(encoding="utf-8") == "old"
    assert not (tmp_path / ".manifest.json.tmp").exists()

def test_a_failed_pack_copy_keeps_the_previously_installed_series(tmp_path: Path, monkeypatch) -> None:
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

    with pytest.raises(RuntimeError, match="copy failed"):
        demo_install.copy_pack_tree(source, data_dir, ["sample"])

    assert (data_dir / "sample" / "0000.png").read_bytes() == b"old"
    assert not (data_dir / ".sample.install").exists()

def test_source_pack_copies_local_files_and_records_its_attribution(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    payload = b"fake"
    _ = (source / "scan.nii.gz").write_bytes(payload)

    result = demo_install.install_source_pack(local_file_pack(source / "scan.nii.gz", payload), tmp_path)

    target = tmp_path / "demo_sources" / "openneuro_on01802"
    notice = json.loads((target / "PACK_INFO.json").read_text(encoding="utf-8"))
    assert result["installed"] == [NIFTI_REL_PATH]
    assert (target / NIFTI_REL_PATH).read_bytes() == payload
    assert notice["pack"] == "mri-source"

def test_source_pack_requires_a_checksum_for_every_file(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _ = (source / "scan.nii.gz").write_bytes(b"fake")

    with pytest.raises(ValueError, match="expected sha256 checksum"):
        _ = demo_install.install_source_pack(local_file_pack(source / "scan.nii.gz"), tmp_path)

@pytest.mark.parametrize(
    ("pack", "escaped"),
    [
        (
            source_pack(
                target_dir="../outside",
                files=[{"url": "https://example.test/scan.nii.gz", "path": "scan.nii.gz", "sha256": "0" * 64}],
            ),
            "../outside",
        ),
        (
            source_pack(files=[{"url": "https://example.test/scan.nii.gz", "path": "../scan.nii.gz", "sha256": "0" * 64}]),
            "scan.nii.gz",
        ),
        (
            source_pack(
                id="ct-source",
                target_dir="demo_sources/ct",
                series_zips=[{"patient_id": "../PATIENT_001", "url": "https://example.test/patient.zip", "sha256": "0" * 64}],
            ),
            "demo_sources/PATIENT_001",
        ),
    ],
    ids=["target-dir", "file-path", "series-zip-patient-id"],
)
def test_source_pack_rejects_paths_that_escape_the_pack_target(tmp_path: Path, pack: dict, escaped: str) -> None:
    with pytest.raises(ValueError, match="path must stay inside pack target"):
        _ = demo_install.install_source_pack(pack, tmp_path)

    assert not (tmp_path / escaped).exists()
    assert not (tmp_path.parent / Path(escaped).name).exists()

def test_source_pack_replaces_a_local_file_whose_checksum_no_longer_matches(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _ = (source / "scan.nii.gz").write_bytes(b"fresh")
    target = tmp_path / "demo_sources" / "openneuro_on01802" / NIFTI_REL_PATH
    target.parent.mkdir(parents=True)
    _ = target.write_bytes(b"stale")

    result = demo_install.install_source_pack(local_file_pack(source / "scan.nii.gz", b"fresh"), tmp_path)

    assert result["installed"] == [NIFTI_REL_PATH]
    assert target.read_bytes() == b"fresh"

def test_source_pack_keeps_the_existing_file_when_the_replacement_download_fails(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "demo_sources" / "openneuro_on01802" / NIFTI_REL_PATH
    target.parent.mkdir(parents=True)
    _ = target.write_bytes(b"stale")
    monkeypatch.setattr(
        demo_install,
        "download_to_path",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(ValueError("download failed")),
    )
    pack = source_pack(files=[{
        "url": "https://example.test/scan.nii.gz",
        "path": NIFTI_REL_PATH,
        "sha256": sha256_bytes(b"fresh"),
    }])

    with pytest.raises(ValueError, match="download failed"):
        _ = demo_install.install_source_pack(pack, tmp_path)

    assert target.read_bytes() == b"stale"

def test_source_pack_removes_a_new_file_whose_checksum_does_not_match(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _ = (source / "scan.nii.gz").write_bytes(b"bad")

    with pytest.raises(ValueError, match="sha256"):
        _ = demo_install.install_source_pack(local_file_pack(source / "scan.nii.gz", b"fresh"), tmp_path)

    assert not (tmp_path / "demo_sources" / "openneuro_on01802" / NIFTI_REL_PATH).exists()

def test_source_pack_enforces_the_catalog_size_of_a_local_file(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    payload = b"fresh"
    _ = (source / "scan.nii.gz").write_bytes(payload)

    with pytest.raises(ValueError, match="size"):
        _ = demo_install.install_source_pack(
            local_file_pack(source / "scan.nii.gz", payload, size_bytes=len(payload) + 1),
            tmp_path,
        )

def test_download_stops_once_the_catalog_size_is_exceeded(tmp_path: Path, monkeypatch) -> None:
    responding_urlopen(monkeypatch, FakeHTTPResponse(b"too-large"))
    target = tmp_path / "demo_sources" / "sample.ome.tif"

    with pytest.raises(ValueError, match="exceeded expected size"):
        _ = demo_install.download_to_path("https://example.test/sample.ome.tif", target, max_bytes=4)

    assert not target.exists()
    assert not (target.parent / ".sample.ome.tif.download").exists()

def test_download_preserves_an_existing_target_when_it_fails(tmp_path: Path, monkeypatch) -> None:
    responding_urlopen(monkeypatch, FakeHTTPResponse(b"too-large"))
    target = tmp_path / "demo_sources" / "sample.ome.tif"
    target.parent.mkdir(parents=True)
    _ = target.write_bytes(b"existing")

    with pytest.raises(ValueError, match="exceeded expected size"):
        _ = demo_install.download_to_path("https://example.test/sample.ome.tif", target, max_bytes=4)

    assert target.read_bytes() == b"existing"
    assert not (target.parent / ".sample.ome.tif.download").exists()

def test_download_retries_a_truncated_remote_body(tmp_path: Path, monkeypatch) -> None:
    responding_urlopen(monkeypatch, FakeHTTPResponse(b"short"), FakeHTTPResponse(b"complete"))
    target = tmp_path / "demo_sources" / "sample.ome.tif"

    result = demo_install.download_to_path(
        "https://example.test/sample.ome.tif",
        target,
        max_bytes=8,
        expected_bytes=8,
    )

    assert result.read_bytes() == b"complete"
    assert not (target.parent / ".sample.ome.tif.download").exists()

def test_download_resumes_from_the_bytes_already_written(tmp_path: Path, monkeypatch) -> None:
    ranges: list[str | None] = []
    responding_urlopen(
        monkeypatch,
        FakeHTTPResponse(b"abc", headers={"Content-Length": "8"}),
        FakeHTTPResponse(b"def", status=206, headers={"Content-Length": "3", "Content-Range": "bytes 3-5/8"}),
        FakeHTTPResponse(b"gh", status=206, headers={"Content-Length": "2", "Content-Range": "bytes 6-7/8"}),
        record_ranges=ranges,
    )
    target = tmp_path / "demo_sources" / "sample.zip"

    result = demo_install.download_to_path(
        "https://example.test/sample.zip",
        target,
        max_bytes=8,
        expected_bytes=8,
    )

    assert result.read_bytes() == b"abcdefgh"
    assert ranges == [None, "bytes=3-", "bytes=6-"]

def test_download_restarts_when_the_server_ignores_the_range_request(tmp_path: Path, monkeypatch) -> None:
    ranges: list[str | None] = []
    responding_urlopen(
        monkeypatch,
        FakeHTTPResponse(b"abc", headers={"Content-Length": "8"}),
        FakeHTTPResponse(b"abcdefgh", headers={"Content-Length": "8"}),
        record_ranges=ranges,
    )
    target = tmp_path / "demo_sources" / "sample.zip"

    result = demo_install.download_to_path(
        "https://example.test/sample.zip",
        target,
        max_bytes=8,
        expected_bytes=8,
    )

    assert result.read_bytes() == b"abcdefgh"
    assert ranges == [None, "bytes=3-"]

def test_download_rejects_a_partial_response_that_starts_at_the_wrong_offset(tmp_path: Path, monkeypatch) -> None:
    responding_urlopen(
        monkeypatch,
        FakeHTTPResponse(b"abc", headers={"Content-Length": "3"}),
        FakeHTTPResponse(b"abc", status=206, headers={"Content-Length": "3", "Content-Range": "bytes 0-2/8"}),
    )
    target = tmp_path / "demo_sources" / "sample.zip"

    with pytest.raises(ValueError, match="started at 0, expected 3"):
        _ = demo_install.download_to_path(
            "https://example.test/sample.zip",
            target,
            max_bytes=8,
            expected_bytes=8,
        )

    assert not target.exists()
    assert not (target.parent / ".sample.zip.download").exists()

def test_download_bounds_retries_that_make_no_progress(tmp_path: Path, monkeypatch) -> None:
    calls = 0

    def fake_urlopen(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return FakeHTTPResponse(b"abc", headers={"Content-Length": "3"})
        raise ConnectionError("connection closed")

    monkeypatch.setattr(demo_install.urllib.request, "urlopen", fake_urlopen)
    target = tmp_path / "demo_sources" / "sample.zip"
    target.parent.mkdir(parents=True)
    _ = target.write_bytes(b"existing")

    with pytest.raises(ValueError, match="no progress after 3 retries"):
        _ = demo_install.download_to_path(
            "https://example.test/sample.zip",
            target,
            max_bytes=8,
            expected_bytes=8,
        )

    assert calls == 4
    assert target.read_bytes() == b"existing"
    assert not (target.parent / ".sample.zip.download").exists()

def test_download_replaces_the_target_only_after_the_body_is_complete(tmp_path: Path, monkeypatch) -> None:
    responding_urlopen(monkeypatch, FakeHTTPResponse(b"complete", headers={"Content-Length": "8"}))
    target = tmp_path / "demo_sources" / "sample.zip"
    target.parent.mkdir(parents=True)
    _ = target.write_bytes(b"existing")
    original_replace = Path.replace

    def checked_replace(self: Path, destination: Path):
        assert destination == target
        assert target.read_bytes() == b"existing"
        return original_replace(self, destination)

    monkeypatch.setattr(Path, "replace", checked_replace)

    result = demo_install.download_to_path(
        "https://example.test/sample.zip",
        target,
        max_bytes=8,
        expected_bytes=8,
    )

    assert result.read_bytes() == b"complete"

def test_series_zip_download_is_capped_by_the_catalog_size_estimate(tmp_path: Path, monkeypatch) -> None:
    responding_urlopen(monkeypatch, FakeHTTPResponse(b"too-large"))
    pack = source_pack(
        id="ct-source",
        title="CT Source Files",
        target_dir="demo_sources/ct",
        license_note="CC BY",
        estimated_size_mb=4 / (1024 * 1024),
        series_zips=[{
            "patient_id": "PATIENT_001",
            "url": "https://example.test/patient.zip",
            "sha256": "0" * 64,
        }],
    )

    with pytest.raises(ValueError, match="exceeded expected size"):
        _ = demo_install.install_source_pack(pack, tmp_path)

    assert not (tmp_path / "demo_sources" / "ct" / "PATIENT_001").exists()

def series_zip_pack(zip_path: Path, checksum: str | None = None) -> dict:
    return source_pack(
        id="ct-source",
        title="CT Source Files",
        target_dir="demo_sources/ct",
        license_note="CC BY",
        series_zips=[{
            "patient_id": "PATIENT_001",
            "url": str(zip_path),
            "sha256": checksum or demo_install.sha256_zip_contents(zip_path),
        }],
    )

def write_series_zip(path: Path, payload: bytes = b"dicom-bytes") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as bundle:
        bundle.writestr("IM0001.dcm", payload)
    return path

def test_series_zip_extraction_failure_leaves_no_partial_series_directory(tmp_path: Path, monkeypatch) -> None:
    zip_path = write_series_zip(tmp_path / "source" / "patient.zip")

    def fail_extract(_bundle, target_dir: Path) -> None:
        target_dir.mkdir(parents=True)
        _ = (target_dir / "partial.dcm").write_bytes(b"partial")
        raise ValueError("extract failed")

    monkeypatch.setattr(demo_install, "extract_zip_safe", fail_extract)

    with pytest.raises(ValueError, match="extract failed"):
        _ = demo_install.install_source_pack(series_zip_pack(zip_path), tmp_path)

    assert not (tmp_path / "demo_sources" / "ct" / "PATIENT_001").exists()

def test_series_zip_reinstalls_over_a_directory_that_only_holds_hidden_files(tmp_path: Path) -> None:
    zip_path = write_series_zip(tmp_path / "source" / "patient.zip")
    stale_dir = tmp_path / "demo_sources" / "ct" / "PATIENT_001"
    stale_dir.mkdir(parents=True)
    _ = (stale_dir / ".DS_Store").write_bytes(b"")

    result = demo_install.install_source_pack(series_zip_pack(zip_path), tmp_path)

    assert result["installed"] == ["PATIENT_001/"]
    assert (stale_dir / "IM0001.dcm").read_bytes() == b"dicom-bytes"
    assert not (stale_dir / ".DS_Store").exists()

def test_series_zip_reinstalls_when_the_installed_marker_is_missing(tmp_path: Path) -> None:
    zip_path = write_series_zip(tmp_path / "source" / "patient.zip", b"fresh-dicom")
    stale_dir = tmp_path / "demo_sources" / "ct" / "PATIENT_001"
    stale_dir.mkdir(parents=True)
    _ = (stale_dir / "IM0001.dcm").write_bytes(b"stale-dicom")
    checksum = demo_install.sha256_zip_contents(zip_path)

    result = demo_install.install_source_pack(series_zip_pack(zip_path), tmp_path)

    marker = json.loads((stale_dir / demo_install.SOURCE_ZIP_MARKER).read_text(encoding="utf-8"))
    assert result["installed"] == ["PATIENT_001/"]
    assert (stale_dir / "IM0001.dcm").read_bytes() == b"fresh-dicom"
    assert marker == {"sha256": checksum}

def test_series_zip_reuses_a_directory_whose_marker_already_matches(tmp_path: Path) -> None:
    zip_path = write_series_zip(tmp_path / "source" / "patient.zip", b"fresh-dicom")
    checksum = demo_install.sha256_zip_contents(zip_path)
    existing_dir = tmp_path / "demo_sources" / "ct" / "PATIENT_001"
    existing_dir.mkdir(parents=True)
    _ = (existing_dir / "IM0001.dcm").write_bytes(b"already-installed")
    demo_install.write_json(existing_dir / demo_install.SOURCE_ZIP_MARKER, {"sha256": checksum})

    result = demo_install.install_source_pack(series_zip_pack(zip_path), tmp_path)

    assert result["installed"] == ["PATIENT_001/"]
    assert (existing_dir / "IM0001.dcm").read_bytes() == b"already-installed"

def test_series_zip_checksums_ignore_archive_wrapper_metadata(tmp_path: Path) -> None:
    first = tmp_path / "first.zip"
    second = tmp_path / "second.zip"
    shared_payload = b"dicom-bytes"
    for path, date_time in ((first, (2024, 1, 1, 0, 0, 0)), (second, (2025, 1, 1, 0, 0, 0))):
        info = zipfile.ZipInfo("patient/IM0001.dcm")
        info.date_time = date_time
        with zipfile.ZipFile(path, "w") as bundle:
            bundle.writestr(info, shared_payload)

    assert demo_install.sha256_file(first) != demo_install.sha256_file(second)
    demo_install.verify_zip_contents_checksum(second, demo_install.sha256_zip_contents(first))

def test_openneuro_lite_build_downloads_sources_under_a_bounded_limit(tmp_path: Path, monkeypatch) -> None:
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

    def fake_write_raw_u16(_volume, out_path: Path) -> None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        _ = out_path.write_bytes(b"raw")

    monkeypatch.setattr(openneuro_build, "download_to_path", fake_download_to_path)
    monkeypatch.setattr(openneuro_build, "load_volume", fake_load_volume)
    monkeypatch.setattr(openneuro_build, "write_png_stack", lambda _volume, _dest: (0, 1))
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

def test_catalog_checksum_update_touches_only_the_matching_archive_entry(tmp_path: Path) -> None:
    pack_path = tmp_path / "demo_packs" / "fixture.zip"
    pack_path.parent.mkdir()
    _ = pack_path.write_bytes(b"fixture")
    catalog_path = tmp_path / "demo_packs" / "catalog.json"
    _ = catalog_path.write_text(
        json.dumps({
            "packs": [
                {"id": "lite", "archive_path": "demo_packs/fixture.zip", "checksum": ""},
                {"id": "other", "archive_path": "demo_packs/other.zip", "checksum": ""},
            ]
        }),
        encoding="utf-8",
    )

    openneuro_build.update_catalog_checksum(pack_path, catalog_path)

    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    assert catalog["packs"][0]["checksum"] == hashlib.sha256(b"fixture").hexdigest()
    assert catalog["packs"][1]["checksum"] == ""
