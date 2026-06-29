#!/usr/bin/env python3
"""Generate synthetic NIfTI fixtures and nibabel goldens for the accuracy ledger."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import nibabel as nib
import numpy as np


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = ROOT / "tests" / "fixtures" / "accuracy" / "nifti"
RAS_TO_LPS = np.diag([-1.0, -1.0, 1.0, 1.0])
UNIT_TO_MM = {
    "meter": 1000.0,
    "mm": 1.0,
    "micron": 0.001,
}


def rotation_z(degrees: float) -> np.ndarray:
    radians = np.deg2rad(degrees)
    c = np.cos(radians)
    s = np.sin(radians)
    return np.array(
        [
            [c, -s, 0.0],
            [s, c, 0.0],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )


def case_data() -> list[dict[str, Any]]:
    oblique = np.eye(4, dtype=np.float64)
    oblique[:3, :3] = rotation_z(30.0) @ np.diag([1.2, 0.8, 2.0])
    oblique[:3, 3] = [4.0, -6.0, 8.0]

    anisotropic = np.diag([0.7, 1.25, 2.5, 1.0]).astype(np.float64)
    anisotropic[:3, 3] = [12.0, -24.0, 36.0]

    micron = np.diag([2000.0, 3000.0, 4000.0, 1.0]).astype(np.float64)
    micron[:3, 3] = [10000.0, -20000.0, 30000.0]

    return [
        {
            "id": "identity-qform-mm",
            "description": "qform-only identity affine in millimeters",
            "shape": (3, 4, 2),
            "affine": np.eye(4, dtype=np.float64),
            "form": "qform",
            "unit": "mm",
        },
        {
            "id": "anisotropic-sform-mm",
            "description": "sform-only anisotropic spacing with translation in millimeters",
            "shape": (3, 4, 2),
            "affine": anisotropic,
            "form": "sform",
            "unit": "mm",
        },
        {
            "id": "oblique-qform-mm",
            "description": "qform-only rotated affine in millimeters",
            "shape": (4, 3, 3),
            "affine": oblique,
            "form": "qform",
            "unit": "mm",
        },
        {
            "id": "micron-sform-non-mm",
            "description": "sform-only affine stored in microns and compared in millimeters",
            "shape": (2, 3, 3),
            "affine": micron,
            "form": "sform",
            "unit": "micron",
        },
    ]


def voxel_points(shape: tuple[int, int, int]) -> list[list[int]]:
    return [
        [0, 0, 0],
        [min(1, shape[0] - 1), min(2, shape[1] - 1), min(1, shape[2] - 1)],
        [shape[0] - 1, shape[1] - 1, shape[2] - 1],
    ]


def apply_affine(affine: np.ndarray, voxel: list[int]) -> list[float]:
    point = affine @ np.array([voxel[0], voxel[1], voxel[2], 1.0], dtype=np.float64)
    return [float(value) for value in point[:3]]


def matrix_json(matrix: np.ndarray) -> list[list[float]]:
    return [[float(value) for value in row] for row in matrix.tolist()]


def write_case(item: dict[str, Any]) -> None:
    case_id = item["id"]
    shape = item["shape"]
    data = np.arange(np.prod(shape), dtype=np.int16).reshape(shape)
    img = nib.Nifti1Image(data, item["affine"])
    img.header.set_xyzt_units(xyz=item["unit"])
    img.header.set_data_dtype(np.int16)

    if item["form"] == "qform":
        img.set_qform(item["affine"], code=1)
        img.set_sform(item["affine"], code=0)
    else:
        img.set_qform(item["affine"], code=0)
        img.set_sform(item["affine"], code=1)

    fixture_path = FIXTURE_DIR / f"{case_id}.nii"
    nib.save(img, str(fixture_path))

    loaded = nib.load(str(fixture_path))
    spatial_unit = loaded.header.get_xyzt_units()[0] or "unknown"
    unit_to_mm = UNIT_TO_MM.get(spatial_unit, 1.0)
    affine_ras = np.asarray(loaded.affine, dtype=np.float64)
    affine_ras_mm = affine_ras.copy()
    affine_ras_mm[:3, :] *= unit_to_mm
    affine_lps_mm = RAS_TO_LPS @ affine_ras_mm
    points = voxel_points(shape)

    golden = {
        "fixture": f"{case_id}.nii",
        "description": item["description"],
        "reference": {
            "name": "nibabel",
            "version": nib.__version__,
            "coordinateSystem": "RAS+",
            "affineUnits": spatial_unit,
        },
        "nifti": {
            "form": item["form"],
            "shape": list(shape),
            "spatialUnit": spatial_unit,
            "unitToMillimeters": unit_to_mm,
        },
        "nibabel": {
            "affine": matrix_json(affine_ras),
            "voxelToWorldPoints": [
                {
                    "voxel": point,
                    "world": apply_affine(affine_ras, point),
                }
                for point in points
            ],
        },
        "expectedVoxelLab": {
            "coordinateSystem": "LPS+",
            "units": "mm",
            "affine": matrix_json(affine_lps_mm),
            "voxelToWorldPoints": [
                {
                    "voxel": point,
                    "world": apply_affine(affine_lps_mm, point),
                }
                for point in points
            ],
        },
    }
    _ = (FIXTURE_DIR / f"{case_id}.golden.json").write_text(
        json.dumps(golden, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    for item in case_data():
        write_case(item)


if __name__ == "__main__":
    main()
