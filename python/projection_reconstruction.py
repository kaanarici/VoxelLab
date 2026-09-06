from __future__ import annotations

from typing import Any

from engine_sources import normalize_source_manifest, projection_manifest_errors
from projection_rtk import backend_report, reconstruct_with_rtk

def reconstruct_projection_volume(datasets: list[Any], source_manifest: dict[str, Any], np: Any) -> dict[str, Any]:
    source_manifest = normalize_source_manifest(source_manifest) or source_manifest
    if not datasets:
        raise ValueError("projection reconstruction requires at least one projection image")

    series_uid = str(getattr(datasets[0], "SeriesInstanceUID", "") or "")
    errors = projection_manifest_errors(source_manifest, len(datasets), series_uid)
    if errors:
        raise ValueError("; ".join(errors))

    projection = source_manifest["projection"]
    geometry_model = str(projection.get("geometryModel", projection.get("geometry", "")) or "")
    reconstructed = reconstruct_with_rtk(datasets, source_manifest, np=np, geometry_model=geometry_model)
    reconstructed.setdefault("report", backend_report(geometry_model, "rtk-cli"))
    return reconstructed
