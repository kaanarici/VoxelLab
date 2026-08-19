"""Shared VoxelLab wire enums. Keep in lockstep with schemas/enums.json."""

from __future__ import annotations

import json
from pathlib import Path

_ENUMS = json.loads((Path(__file__).resolve().parent.parent / "schemas" / "enums.json").read_text())

ORTHONORMAL_TOLERANCE = float(_ENUMS["orthonormalTolerance"])
SLICE_AXIS_ALIGNMENT_MIN = float(_ENUMS["sliceAxisAlignmentMin"])
PROJECTION_MODALITIES = frozenset(_ENUMS["projectionModalities"])
PROJECTION_KINDS = frozenset(_ENUMS["projectionKinds"])
PROJECTION_STATUSES = frozenset(_ENUMS["projectionStatuses"])
GEOMETRY_KIND_CAPABILITY = dict(_ENUMS["geometryKindCapability"])
DERIVED_KINDS = frozenset(_ENUMS["derivedKinds"])
SOURCE_RECORD_VERSIONS = frozenset(int(value) for value in _ENUMS["sourceRecordVersions"])
PROJECTION_GEOMETRIES = frozenset(_ENUMS["projectionGeometries"])
ULTRASOUND_MODES = frozenset(_ENUMS["ultrasoundModes"])
ULTRASOUND_PROBE_GEOMETRIES = frozenset(_ENUMS["ultrasoundProbeGeometries"])
REGISTRATION_TRANSFORMS = frozenset(_ENUMS["registrationTransforms"])


def dump_contract_enums() -> dict:
    return {
        "orthonormalTolerance": ORTHONORMAL_TOLERANCE,
        "sliceAxisAlignmentMin": SLICE_AXIS_ALIGNMENT_MIN,
        "projectionModalities": sorted(PROJECTION_MODALITIES),
        "projectionKinds": sorted(PROJECTION_KINDS),
        "projectionStatuses": sorted(PROJECTION_STATUSES),
        "geometryKindCapability": dict(GEOMETRY_KIND_CAPABILITY),
        "derivedKinds": sorted(DERIVED_KINDS),
        "sourceRecordVersions": sorted(SOURCE_RECORD_VERSIONS),
        "projectionGeometries": sorted(PROJECTION_GEOMETRIES),
        "ultrasoundModes": sorted(ULTRASOUND_MODES),
        "ultrasoundProbeGeometries": sorted(ULTRASOUND_PROBE_GEOMETRIES),
        "registrationTransforms": sorted(REGISTRATION_TRANSFORMS),
    }


def source_record_version(payload: object) -> int:
    if not isinstance(payload, dict):
        return 0
    raw = payload.get("sourceRecordVersion", payload.get("version", 1))
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return 0
    return value if value in SOURCE_RECORD_VERSIONS else 0


def parallel_beam_coverage_deg(angles: list[float]) -> float:
    if len(angles) < 2:
        return 0.0
    normalized = sorted((float(angle) % 360.0 + 360.0) % 360.0 for angle in angles)
    gaps = [normalized[index + 1] - normalized[index] for index in range(len(normalized) - 1)]
    gaps.append(normalized[0] + 360.0 - normalized[-1])
    return 360.0 - max(gaps)
