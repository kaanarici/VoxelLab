"""Shared preflight checks for calibrated cloud source manifests."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

from engine_sources import (
    SOURCE_MANIFEST_NAMES,
    load_source_manifest,
    projection_manifest_errors,
    registration_manifest_errors,
    ultrasound_manifest_errors,
)
from pipeline_paths import is_skipped_path
from projection_rtk import configured_rtk_command


def module_exists(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def source_dicom_files(folder: Path) -> list[Path]:
    if not folder.is_dir():
        return []
    files: list[Path] = []
    for path in sorted(folder.rglob("*")):
        if is_skipped_path(path, folder):
            continue
        if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".txt"}:
            continue
        if path.suffix.lower() == ".json" or path.name in SOURCE_MANIFEST_NAMES:
            continue
        if path.is_file():
            files.append(path)
    return files


def dicom_frame_count(paths: list[Path]) -> int:
    import pydicom

    total = 0
    for path in paths:
        dataset = pydicom.dcmread(path, stop_before_pixels=True, force=True)
        if not getattr(dataset, "Rows", None) or not getattr(dataset, "Columns", None):
            raise ValueError(f"{path.name}: missing image dimensions")
        try:
            frames = int(getattr(dataset, "NumberOfFrames", 1) or 1)
        except (TypeError, ValueError):
            frames = 1
        total += frames if frames > 0 else 1
    return total


def _load_manifest_for_preflight(folder: Path, label: str) -> tuple[dict | None, list[str]]:
    try:
        return load_source_manifest(folder), []
    except (OSError, json.JSONDecodeError) as exc:
        return None, [f"{label} source: invalid calibration manifest: {exc}"]


def validate_projection_source(folder: Path) -> list[str]:
    errors = [f"missing Python module: pydicom"] if not module_exists("pydicom") else []
    files = source_dicom_files(folder)
    if not files:
        return errors + [f"projection source: no candidate DICOM files in {folder}"]
    manifest, manifest_errors = _load_manifest_for_preflight(folder, "projection")
    if manifest_errors:
        return errors + manifest_errors
    if manifest is None:
        return errors + [f"projection source: missing calibration manifest ({', '.join(SOURCE_MANIFEST_NAMES)}) in {folder}"]
    projection_count = len(files)
    if not errors:
        try:
            projection_count = dicom_frame_count(files)
        except Exception as exc:
            return errors + [f"projection source: invalid DICOM input: {exc}"]
        if projection_count != len(files):
            return errors + ["projection source: multi-frame DICOM inputs are not supported; expected one projection image per file"]
    errors.extend(projection_manifest_errors(manifest, projection_count))
    projection = manifest.get("projection", {}) if isinstance(manifest, dict) else {}
    geometry = str(projection.get("geometryModel", projection.get("geometry", "")) or "")
    if geometry in {"circular-cbct", "limited-angle-tomo"} and not configured_rtk_command():
        errors.append("projection source: missing RTK runtime; run `npm run setup -- --pipeline --rtk` or set MRI_VIEWER_RTK_COMMAND")
    return errors


def validate_ultrasound_source(folder: Path) -> list[str]:
    errors = [f"missing Python module: pydicom"] if not module_exists("pydicom") else []
    files = source_dicom_files(folder)
    if not files:
        return errors + [f"ultrasound source: no candidate DICOM files in {folder}"]
    manifest, manifest_errors = _load_manifest_for_preflight(folder, "ultrasound")
    if manifest_errors:
        return errors + manifest_errors
    if manifest is None:
        return errors + [f"ultrasound source: missing calibration manifest ({', '.join(SOURCE_MANIFEST_NAMES)}) in {folder}"]
    if not errors:
        try:
            frame_count = dicom_frame_count(files)
        except Exception as exc:
            return errors + [f"ultrasound source: invalid DICOM input: {exc}"]
        errors.extend(ultrasound_manifest_errors(manifest, frame_count))
    return errors


def registration_series_uids(paths: list[Path]) -> tuple[set[str], list[str]]:
    import pydicom

    series_uids: set[str] = set()
    errors: list[str] = []
    for path in paths:
        try:
            dataset = pydicom.dcmread(path, stop_before_pixels=True, force=True)
        except Exception as exc:
            errors.append(f"registration source: invalid DICOM input {path.name}: {exc}")
            continue
        modality = str(getattr(dataset, "Modality", "") or "").upper()
        if modality not in {"CT", "MR"}:
            errors.append(f"registration source: expected CT/MR DICOM, got {modality or 'unknown'} in {path.name}")
        series_uid = str(getattr(dataset, "SeriesInstanceUID", "") or "")
        if series_uid:
            series_uids.add(series_uid)
    return series_uids, errors


def validate_registration_source(folder: Path) -> list[str]:
    errors = [f"missing Python module: pydicom"] if not module_exists("pydicom") else []
    files = source_dicom_files(folder)
    if not files:
        return errors + [f"registration source: no candidate DICOM files in {folder}"]
    manifest, manifest_errors = _load_manifest_for_preflight(folder, "registration")
    if manifest_errors:
        return errors + manifest_errors
    if manifest is None:
        return errors + [f"registration source: missing source manifest ({', '.join(SOURCE_MANIFEST_NAMES)}) in {folder}"]
    if not errors:
        series_uids, dicom_errors = registration_series_uids(files)
        errors.extend(dicom_errors)
        if len(series_uids) < 2:
            errors.append("registration source: expected at least two CT/MR DICOM series")
        errors.extend(registration_manifest_errors(manifest, series_uids))
    return errors
