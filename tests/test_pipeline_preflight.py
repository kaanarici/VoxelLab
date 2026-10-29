from __future__ import annotations

import json
from pathlib import Path
import sys

import pytest

import engine_preflight
import pipeline_paths
import scripts.check_pipeline_ready as preflight
from engine_preflight import source_dicom_files
from pipeline_paths import candidate_dicom_files, load_manifest
from scripts.check_pipeline_ready import manifest_series, parse_slugs, resolve_source, validate_ct_pipeline, validate_synthseg_pipeline

from tests.helpers.python.manifests import circular_cbct_source, projection_source, ultrasound_source

pytestmark = pytest.mark.filterwarnings("ignore:.*write_like_original.*:DeprecationWarning")

TRACKED_FRAME_TRANSFORMS = [
    [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
    [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 1], [0, 0, 0, 1]],
]

def write_image_dicom(path: Path, *, modality: str = "US", frames: int = 1) -> str:
    """A minimal but readable secondary-capture DICOM; returns its SeriesInstanceUID."""
    pydicom = pytest.importorskip("pydicom")
    from pydicom.dataset import FileDataset, FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, SecondaryCaptureImageStorage, generate_uid

    file_meta = FileMetaDataset()
    file_meta.MediaStorageSOPClassUID = SecondaryCaptureImageStorage
    file_meta.MediaStorageSOPInstanceUID = generate_uid()
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    dataset = FileDataset(str(path), {}, file_meta=file_meta, preamble=b"\0" * 128)
    dataset.SOPClassUID = SecondaryCaptureImageStorage
    dataset.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
    dataset.SeriesInstanceUID = generate_uid()
    dataset.StudyInstanceUID = generate_uid()
    dataset.Modality = modality
    dataset.NumberOfFrames = frames
    dataset.Rows = 2
    dataset.Columns = 2
    dataset.save_as(path, enforce_file_format=True)
    return str(dataset.SeriesInstanceUID)

def write_source_record(folder: Path, record: dict | str) -> Path:
    path = folder / "voxellab.source.json"
    _ = path.write_text(record if isinstance(record, str) else json.dumps(record))
    return path

def ct_workspace(tmp_path: Path, monkeypatch, *, source_files: dict[str, bytes] | None = None) -> Path:
    """A data directory whose manifest expects one CT series under `sources/TestFolder`."""
    data = tmp_path / "data"
    data.mkdir()
    _ = (data / "manifest.json").write_text(
        json.dumps({"series": [{"slug": "ct_test", "modality": "CT", "sourceFolder": "TestFolder"}]}),
    )
    monkeypatch.setattr(pipeline_paths, "DATA", data)
    source = tmp_path / "sources" / "TestFolder"
    for name, payload in (source_files or {}).items():
        source.mkdir(parents=True, exist_ok=True)
        _ = (source / name).write_bytes(payload)
    return tmp_path / "sources"

def test_an_explicit_source_path_wins_over_the_environment(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("MRI_VIEWER_DICOM_ROOT", "/definitely/missing")

    assert resolve_source(str(tmp_path)) == tmp_path.resolve()

def test_dicom_discovery_ignores_sidecars_and_finds_extensionless_files(tmp_path: Path) -> None:
    _ = (tmp_path / "0000.png").write_bytes(b"not dicom")
    _ = (tmp_path / ".DS_Store").write_bytes(b"")

    assert not source_dicom_files(tmp_path)

    _ = (tmp_path / "IM0001").write_bytes(b"dicom-ish")

    assert source_dicom_files(tmp_path)

def test_dicom_discovery_descends_into_study_folders(tmp_path: Path) -> None:
    nested = tmp_path / "study" / "series"
    nested.mkdir(parents=True)
    _ = (nested / "IM0001").write_bytes(b"dicom-ish")

    assert source_dicom_files(tmp_path)

def test_dicom_discovery_skips_hidden_and_macosx_trees(tmp_path: Path) -> None:
    for folder, name in ((tmp_path / "__MACOSX" / "study", "IM0001"), (tmp_path / ".hidden" / "study", "IM0002")):
        folder.mkdir(parents=True)
        _ = (folder / name).write_bytes(b"dicom-ish")

    assert not source_dicom_files(tmp_path)

def test_flat_dicom_discovery_uses_the_same_hidden_file_filter(tmp_path: Path) -> None:
    _ = (tmp_path / "IM0001").write_bytes(b"dicom-ish")
    _ = (tmp_path / ".hidden").write_bytes(b"not input")
    _ = (tmp_path / "__MACOSX").write_bytes(b"not input")

    assert [path.name for path in candidate_dicom_files(tmp_path)] == ["IM0001"]

def test_a_missing_manifest_fails_closed(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="manifest.json is missing"):
        _ = load_manifest(tmp_path)

def test_an_empty_manifest_is_allowed_only_when_bootstrapping(tmp_path: Path) -> None:
    assert load_manifest(tmp_path, allow_empty=True) == {
        "patient": "anonymous",
        "studyDate": "",
        "series": [],
    }

@pytest.mark.parametrize("contents", ["{not json", '{"series": {}}', "[]"], ids=["malformed", "series-not-a-list", "not-an-object"])
def test_an_unusable_manifest_fails_closed(tmp_path: Path, contents: str) -> None:
    _ = (tmp_path / "manifest.json").write_text(contents)

    with pytest.raises(RuntimeError, match="manifest.json (?:is malformed|has invalid series data)"):
        _ = load_manifest(tmp_path)

def test_manifest_series_treats_unreadable_json_as_no_series(tmp_path: Path) -> None:
    manifest = tmp_path / "manifest.json"
    _ = manifest.write_text("{not json")

    assert manifest_series(manifest) == set()

def test_requested_slugs_must_exist_in_the_manifest() -> None:
    with pytest.raises(ValueError, match="unknown_slug"):
        _ = parse_slugs(["unknown_slug"], ["known_slug"], ["known_slug"])

def test_ct_preflight_reports_a_series_without_any_source_files(tmp_path: Path, monkeypatch) -> None:
    source_root = ct_workspace(tmp_path, monkeypatch)

    errors = validate_ct_pipeline(source_root, ["ct_test"])

    assert any("ct_test: no candidate DICOM files" in error for error in errors)

def test_ct_preflight_rejects_files_that_are_not_readable_dicom(tmp_path: Path, monkeypatch) -> None:
    source_root = ct_workspace(tmp_path, monkeypatch, source_files={"IM0001": b"not a dicom image"})

    errors = validate_ct_pipeline(source_root, ["ct_test"])

    assert any("ct_test: invalid DICOM input" in error for error in errors)

def test_synthseg_preflight_reports_a_series_without_a_brain_stack(tmp_path: Path) -> None:
    data = tmp_path / "data"
    data.mkdir()
    _ = (data / "manifest.json").write_text(json.dumps({"series": [{"slug": "t2_tse"}]}))

    errors = validate_synthseg_pipeline(tmp_path, data, ["t2_tse"], tmp_path / "venv")

    assert any("t2_tse: no brain PNG stack" in error for error in errors)

def test_projection_preflight_requires_a_calibration_manifest(tmp_path: Path) -> None:
    _ = (tmp_path / "IM0001").write_bytes(b"dicom-ish")

    errors = preflight.validate_projection_source(tmp_path)

    assert any("missing calibration manifest" in error for error in errors)

def test_projection_preflight_reports_a_malformed_calibration_manifest(tmp_path: Path) -> None:
    _ = (tmp_path / "IM0001").write_bytes(b"dicom-ish")
    _ = write_source_record(tmp_path, "{not json")

    errors = preflight.validate_projection_source(tmp_path)

    assert any("invalid calibration manifest" in error for error in errors)

def test_projection_preflight_requires_an_rtk_runtime_for_cbct(tmp_path: Path, monkeypatch) -> None:
    series_uid = write_image_dicom(tmp_path / "IM0001", modality="XA")
    _ = write_source_record(tmp_path, circular_cbct_source(
        series_uid=series_uid,
        anglesDeg=[0],
        outputShape=[8, 8, 4],
        outputSpacingMm=[1, 1, 1],
    ))
    monkeypatch.setattr(engine_preflight, "configured_rtk_command", lambda: "")

    errors = preflight.validate_projection_source(tmp_path)

    assert any("missing RTK runtime" in error for error in errors)

def test_projection_preflight_rejects_files_that_are_not_readable_dicom(tmp_path: Path) -> None:
    _ = (tmp_path / "IM0001").write_bytes(b"not a dicom image")
    _ = write_source_record(tmp_path, projection_source(
        series_uid="1.2.proj",
        anglesDeg=[0],
        outputShape=[8, 8, 4],
        outputSpacingMm=[1, 1, 1],
    ))

    errors = preflight.validate_projection_source(tmp_path)

    assert any("invalid DICOM input" in error for error in errors)

def test_projection_preflight_rejects_multiframe_dicom(tmp_path: Path) -> None:
    series_uid = write_image_dicom(tmp_path / "IM0001", modality="XA", frames=2)
    _ = write_source_record(tmp_path, projection_source(
        series_uid=series_uid,
        outputShape=[8, 8, 4],
        outputSpacingMm=[1, 1, 1],
    ))

    errors = preflight.validate_projection_source(tmp_path)

    assert any("multi-frame DICOM inputs are not supported" in error for error in errors)

def test_the_bundled_engine_requires_line_integral_projections(tmp_path: Path, monkeypatch) -> None:
    series_uid = write_image_dicom(tmp_path / "source.dcm", modality="XA")
    manifest = circular_cbct_source(series_uid=series_uid, anglesDeg=[0])
    path = write_source_record(tmp_path, manifest)
    monkeypatch.delenv("MRI_VIEWER_RTK_COMMAND", raising=False)
    monkeypatch.setattr(engine_preflight, "configured_rtk_command", lambda: "bundled")

    assert any(
        "inputValueDomain=line-integral" in error
        for error in preflight.validate_projection_source(tmp_path)
    )

    manifest["projection"]["inputValueDomain"] = "line-integral"
    _ = path.write_text(json.dumps(manifest))

    assert preflight.validate_projection_source(tmp_path) == []

def test_an_external_engine_may_accept_detector_intensity_projections(tmp_path: Path, monkeypatch) -> None:
    series_uid = write_image_dicom(tmp_path / "source.dcm", modality="XA")
    manifest = circular_cbct_source(series_uid=series_uid, anglesDeg=[0], inputValueDomain="detector-intensity")
    _ = write_source_record(tmp_path, manifest)
    monkeypatch.setenv("MRI_VIEWER_RTK_COMMAND", "external-engine")
    monkeypatch.setattr(engine_preflight, "configured_rtk_command", lambda: "external-engine")

    assert preflight.validate_projection_source(tmp_path) == []

def test_ultrasound_preflight_accepts_a_tracked_multiframe_cine(tmp_path: Path) -> None:
    series_uid = write_image_dicom(tmp_path / "cine.dcm", frames=2)
    _ = write_source_record(tmp_path, ultrasound_source(
        series_uid=series_uid,
        mode="tracked-freehand-sector",
        outputShape=[8, 8, 2],
        frameTransformsLps=TRACKED_FRAME_TRANSFORMS,
    ))

    assert preflight.validate_ultrasound_source(tmp_path) == []

def test_ultrasound_preflight_rejects_files_that_are_not_readable_dicom(tmp_path: Path) -> None:
    _ = (tmp_path / "cine.dcm").write_bytes(b"not a dicom image")
    _ = write_source_record(tmp_path, ultrasound_source(
        mode="tracked-freehand-sector",
        frameTransformsLps=TRACKED_FRAME_TRANSFORMS[:1],
    ))

    errors = preflight.validate_ultrasound_source(tmp_path)

    assert any("invalid DICOM input" in error for error in errors)

def test_ultrasound_preflight_rejects_colour_frames(tmp_path: Path) -> None:
    pydicom = pytest.importorskip("pydicom")
    path = tmp_path / "color.dcm"
    _ = write_image_dicom(path, modality="US")
    dataset = pydicom.dcmread(path)
    dataset.SamplesPerPixel = 3
    dataset.PhotometricInterpretation = "RGB"
    dataset.PlanarConfiguration = 0
    dataset.BitsAllocated = 8
    dataset.BitsStored = 8
    dataset.HighBit = 7
    dataset.PixelRepresentation = 0
    dataset.add_new(0x7FE00010, "OB", bytes(12))
    dataset.save_as(path)

    with pytest.raises(ValueError, match="grayscale"):
        _ = engine_preflight.dicom_frame_count([path], grayscale=True)

def test_the_preflight_cli_validates_registration_sources(tmp_path: Path, monkeypatch) -> None:
    seen: list[Path] = []
    monkeypatch.setattr(preflight, "validate_registration_source", lambda path: seen.append(path) or [])
    monkeypatch.setattr(sys, "argv", [
        "check_pipeline_ready.py",
        "--no-ct",
        "--no-synthseg",
        "--registration-source",
        str(tmp_path),
    ])

    assert preflight.main() == 0
    assert seen == [tmp_path.resolve()]
