from __future__ import annotations

import importlib.metadata
import json
import math
import os
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from engine_report import normalize_engine_validation
from geometry import geometry_from_grid

def _bundled_rtk_wrapper() -> str:
    wrapper = Path(__file__).resolve().parents[1] / "scripts" / "rtk_projection_wrapper.py"
    if not wrapper.exists():
        return ""
    try:
        _ = importlib.metadata.version("itk-rtk")
    except importlib.metadata.PackageNotFoundError:
        return ""
    return f"{sys.executable} {wrapper}"

def configured_rtk_command() -> str:
    raw = str(os.environ.get("MRI_VIEWER_RTK_COMMAND", "") or "").strip()
    if raw:
        return raw
    bundled = _bundled_rtk_wrapper()
    if bundled:
        return bundled
    return ""

def rtk_available() -> bool:
    return bool(configured_rtk_command())

def backend_report(geometry_model: str, backend: str) -> dict[str, Any]:
    return {
        "backend": backend,
        "geometryModel": geometry_model,
        "validation": "external-engine",
        "rtkAvailable": rtk_available(),
    }

def _projection_pixels(dataset: Any, np: Any) -> Any:
    pixels = dataset.pixel_array.astype(np.float32)
    slope = float(getattr(dataset, "RescaleSlope", 1) or 1)
    intercept = float(getattr(dataset, "RescaleIntercept", 0) or 0)
    return pixels * slope + intercept

def _detector_spacing_mm(dataset: Any, explicit: Any = None) -> list[float]:
    spacing = explicit if explicit is not None else getattr(dataset, "ImagerPixelSpacing", None)
    spacing = spacing if spacing is not None else []
    if isinstance(spacing, str):
        spacing = spacing.split("\\")
    try:
        values = [float(spacing[0]), float(spacing[1])]
    except (TypeError, ValueError, IndexError) as exc:
        raise ValueError("Projection reconstruction requires calibrated detector pixel spacing") from exc
    if not all(math.isfinite(value) and value > 0 for value in values):
        raise ValueError("Projection detector spacing must be finite and positive")
    return values

def _base_geometry(source_manifest: dict[str, Any]) -> dict[str, Any]:
    return geometry_from_grid(source_manifest["projection"])

def _base_projection_set(datasets: list[Any], source_manifest: dict[str, Any], detector_shape: tuple[int, int]) -> dict[str, Any]:
    projection = source_manifest["projection"]
    series_uid = str(getattr(datasets[0], "SeriesInstanceUID", "") or "")
    detector_spacing = _detector_spacing_mm(datasets[0], source_manifest["projection"].get("detectorSpacingMm"))
    return {
        "id": str(source_manifest.get("projectionSetId", "") or f"{series_uid or 'projection'}_projection_set"),
        "name": str(source_manifest.get("name", "") or "Projection source"),
        "sourceSeriesUID": series_uid,
        "frameOfReferenceUID": str(projection["frameOfReferenceUID"]),
        "projectionKind": "cbct",
        "projectionCount": len(datasets),
        "reconstructionCapability": "requires-reconstruction",
        "reconstructionStatus": "reconstructed",
        "renderability": "2d",
        "calibrationStatus": "calibrated",
        "projectionMatrices": source_manifest.get("projectionMatrices", []),
        "detectorPixels": [int(detector_shape[0]), int(detector_shape[1])],
        "detectorSpacingMm": detector_spacing,
    }

def _wrapper_manifest(source_manifest: dict[str, Any], geometry_model: str) -> dict[str, Any]:
    projection = dict(source_manifest["projection"])
    projection["geometryModel"] = geometry_model
    return {**source_manifest, "projection": projection}

def _run_wrapper(command: str, manifest_path: Path, projections_path: Path, output_path: Path) -> None:
    argv = shlex.split(command)
    if not argv:
        raise RuntimeError("MRI_VIEWER_RTK_COMMAND is empty")
    try:
        _ = subprocess.run(
            [
                *argv,
                "--input-manifest",
                str(manifest_path),
                "--projections",
                str(projections_path),
                "--output-json",
                str(output_path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        stderr = str(exc.stderr or exc.stdout or "").strip()
        detail = f": {stderr}" if stderr else ""
        raise RuntimeError(f"projection reconstruction wrapper failed{detail}") from exc

def reconstruct_with_rtk(datasets: list[Any], source_manifest: dict[str, Any], np: Any, geometry_model: str = "", **_kwargs: Any) -> dict[str, Any]:
    command = configured_rtk_command()
    if not command:
        raise RuntimeError(
            f"projection geometry {geometry_model or '(unknown)'} requires RTK; run `npm run setup -- --pipeline --rtk` or set MRI_VIEWER_RTK_COMMAND"
        )

    projection_stack = np.stack([_projection_pixels(dataset, np) for dataset in datasets], axis=0)
    if projection_stack.ndim != 3 or not np.isfinite(projection_stack).all():
        raise ValueError("Projection reconstruction requires finite 2D projection images")
    if source_manifest["projection"].get("detectorSpacingMm") is None and any(_detector_spacing_mm(dataset) != _detector_spacing_mm(datasets[0]) for dataset in datasets[1:]):
        raise ValueError("Projection detector spacing must be consistent across images")
    detector_shape = tuple(int(value) for value in projection_stack.shape[1:3])
    base_geometry = _base_geometry(source_manifest)
    base_projection_set = _base_projection_set(datasets, source_manifest, detector_shape)
    detector_spacing = _detector_spacing_mm(datasets[0], source_manifest["projection"].get("detectorSpacingMm"))

    with tempfile.TemporaryDirectory(prefix="voxellab_rtk_") as temp_dir:
        temp_root = Path(temp_dir)
        manifest_path = temp_root / "input_manifest.json"
        projections_path = temp_root / "projections.npy"
        output_path = temp_root / "output.json"

        wrapper_manifest = _wrapper_manifest(source_manifest, geometry_model)
        wrapper_manifest["projection"] = {
            **wrapper_manifest["projection"],
            "detectorSpacingMm": detector_spacing,
            "detectorPixels": [detector_shape[0], detector_shape[1]],
        }
        _ = manifest_path.write_text(json.dumps(wrapper_manifest, indent=2))
        np.save(projections_path, projection_stack)
        _run_wrapper(command, manifest_path, projections_path, output_path)

        if not output_path.exists():
            raise RuntimeError(f"projection geometry {geometry_model or '(unknown)'} wrapper did not produce output.json")
        payload = json.loads(output_path.read_text())
        if not isinstance(payload, dict):
            raise RuntimeError("projection reconstruction wrapper output must be an object")

        volume_path = Path(str(payload.get("volumePath", "") or ""))
        if not volume_path.is_absolute():
            volume_path = temp_root / volume_path
        if not volume_path.exists():
            raise RuntimeError("projection reconstruction wrapper must emit volumePath to a saved NumPy volume")

        volume = np.load(volume_path, allow_pickle=False)
        if getattr(volume, "ndim", 0) != 3:
            raise RuntimeError("projection reconstruction wrapper volume must be 3D")
        if tuple(volume.shape) != tuple(reversed(source_manifest["projection"]["outputShape"])):
            raise RuntimeError("projection reconstruction wrapper volume does not match the requested grid")
        if not np.issubdtype(volume.dtype, np.number) or np.iscomplexobj(volume) or not np.isfinite(volume).all():
            raise RuntimeError("projection reconstruction wrapper volume must contain finite real samples")

        geometry = dict(base_geometry)
        if isinstance(payload.get("geometry"), dict):
            for key, value in payload["geometry"].items():
                if key not in base_geometry:
                    continue
                expected = base_geometry[key]
                try:
                    matches = np.shape(value) == np.shape(expected) and np.allclose(value, expected, rtol=0, atol=1e-6) if isinstance(expected, (list, float)) else value == expected
                except (TypeError, ValueError):
                    matches = False
                if not matches:
                    raise RuntimeError(f"projection reconstruction wrapper changed requested geometry: {key}")
        projection_set = dict(base_projection_set)
        if isinstance(payload.get("projectionSet"), dict):
            projection_set.update(payload["projectionSet"])
        report = backend_report(geometry_model, "rtk-cli")
        if isinstance(payload.get("report"), dict):
            report.update(payload["report"])
        report["backend"] = str(report.get("backend", "rtk-cli") or "rtk-cli")
        report["geometryModel"] = str(report.get("geometryModel", geometry_model) or geometry_model)
        report["validation"] = normalize_engine_validation(report.get("validation", "external-engine"))
        return {
            "volume": volume,
            "geometry": geometry,
            "projectionSet": projection_set,
            "report": report,
        }
