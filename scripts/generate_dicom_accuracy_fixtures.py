#!/usr/bin/env python3
"""Generate synthetic DICOM fixtures and pydicom/DICOM PS3.3 geometry goldens."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.sequence import Sequence
from pydicom.uid import CTImageStorage, EnhancedCTImageStorage, ExplicitVRLittleEndian, generate_uid


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = ROOT / "tests" / "fixtures" / "accuracy" / "dicom"
DICOM_REFERENCE = {
    "name": "pydicom+DICOM-PS3.3-Image-Plane",
    "version": f"pydicom {pydicom.__version__}; DICOM PS3.3 2026b C.7.6.2.1.1",
    "url": "https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_C.7.6.2.html",
}


def uid(*parts: str) -> str:
    return generate_uid(entropy_srcs=["voxellab-accuracy", *parts])


def normalize3(vector: list[float]) -> list[float]:
    length = math.sqrt(sum(value * value for value in vector))
    return [value / length for value in vector] if length > 1e-12 else []


def cross3(a: list[float], b: list[float]) -> list[float]:
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]


def dot3(a: list[float], b: list[float]) -> float:
    return sum(a[index] * b[index] for index in range(3))


def vector_add(a: list[float], b: list[float]) -> list[float]:
    return [a[index] + b[index] for index in range(3)]


def vector_scale(vector: list[float], scale: float) -> list[float]:
    return [value * scale for value in vector]


def matrix_json(matrix: list[list[float]]) -> list[list[float]]:
    return [[float(value) for value in row] for row in matrix]


def ds_float_list(value: Any, length: int) -> list[float]:
    values = [float(item) for item in value]
    if len(values) < length:
        raise ValueError(f"expected {length} values, got {values}")
    return values[:length]


def base_dataset(case: dict[str, Any], *, instance: int, sop_uid: str, frame_uid: str) -> FileDataset:
    file_meta = FileMetaDataset()
    file_meta.FileMetaInformationVersion = b"\0\1"
    file_meta.MediaStorageSOPClassUID = sop_uid
    file_meta.MediaStorageSOPInstanceUID = uid(case["id"], "sop", str(instance))
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    file_meta.ImplementationClassUID = uid("implementation")

    ds = FileDataset("", {}, file_meta=file_meta, preamble=b"\0" * 128)
    ds.SOPClassUID = sop_uid
    ds.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
    ds.PatientName = "Accuracy^Oracle"
    ds.PatientID = "VOXELLAB-ACCURACY"
    ds.StudyInstanceUID = uid(case["id"], "study")
    ds.SeriesInstanceUID = uid(case["id"], "series")
    ds.FrameOfReferenceUID = frame_uid
    ds.Modality = "CT"
    ds.SeriesDescription = case["id"]
    ds.StudyDate = "20260101"
    ds.StudyTime = "120000"
    ds.Rows = case["rows"]
    ds.Columns = case["cols"]
    ds.InstanceNumber = instance
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.SamplesPerPixel = 1
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    ds.RescaleSlope = 1
    ds.RescaleIntercept = 0
    ds.WindowCenter = 32
    ds.WindowWidth = 64
    return ds


def write_classic_case(case: dict[str, Any]) -> list[Path]:
    case_dir = FIXTURE_DIR / case["id"]
    case_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    frame_uids = case.get("frame_uids") or [uid(case["id"], "frame")] * len(case["positions"])
    for file_index, position_index in enumerate(case.get("file_order", range(len(case["positions"]))), start=1):
        ds = base_dataset(
            case,
            instance=file_index,
            sop_uid=CTImageStorage,
            frame_uid=frame_uids[position_index],
        )
        ds.ImagePositionPatient = case["positions"][position_index]
        ds.ImageOrientationPatient = case["iop"]
        ds.PixelSpacing = case["pixel_spacing"]
        ds.SliceThickness = case["slice_thickness"]
        pixel_count = case["rows"] * case["cols"]
        pixels = np.arange(pixel_count, dtype=np.uint16) + (file_index * 10)
        ds.PixelData = pixels.tobytes()
        path = case_dir / f"slice-{file_index:04d}.dcm"
        ds.save_as(path, write_like_original=False)
        paths.append(path)
    return paths


def write_enhanced_case(case: dict[str, Any]) -> list[Path]:
    case_dir = FIXTURE_DIR / case["id"]
    case_dir.mkdir(parents=True, exist_ok=True)
    ds = base_dataset(
        case,
        instance=1,
        sop_uid=EnhancedCTImageStorage,
        frame_uid=uid(case["id"], "frame"),
    )
    ds.NumberOfFrames = len(case["positions"])

    pixel_measures = Dataset()
    pixel_measures.PixelSpacing = case["pixel_spacing"]
    pixel_measures.SliceThickness = case["slice_thickness"]
    orientation = Dataset()
    orientation.ImageOrientationPatient = case["iop"]
    shared = Dataset()
    shared.PixelMeasuresSequence = Sequence([pixel_measures])
    shared.PlaneOrientationSequence = Sequence([orientation])
    if case.get("shared_rescale"):
        shared_transform = Dataset()
        shared_transform.RescaleSlope = case["shared_rescale"][0]
        shared_transform.RescaleIntercept = case["shared_rescale"][1]
        shared.PixelValueTransformationSequence = Sequence([shared_transform])
    ds.SharedFunctionalGroupsSequence = Sequence([shared])

    per_frame = []
    frame_rescales = case.get("frame_rescales") or [None] * len(case["positions"])
    for index, position in enumerate(case["positions"]):
        frame_group = Dataset()
        plane_position = Dataset()
        plane_position.ImagePositionPatient = position
        frame_group.PlanePositionSequence = Sequence([plane_position])
        if frame_rescales[index] is not None:
            frame_transform = Dataset()
            frame_transform.RescaleSlope = frame_rescales[index][0]
            frame_transform.RescaleIntercept = frame_rescales[index][1]
            frame_group.PixelValueTransformationSequence = Sequence([frame_transform])
        per_frame.append(frame_group)
    ds.PerFrameFunctionalGroupsSequence = Sequence(per_frame)

    pixel_count = case["rows"] * case["cols"] * len(case["positions"])
    ds.PixelData = np.arange(pixel_count, dtype=np.uint16).tobytes()
    path = case_dir / "enhanced.dcm"
    ds.save_as(path, write_like_original=False)
    return [path]


def frame_records(path: Path) -> list[dict[str, Any]]:
    ds = pydicom.dcmread(path)
    if int(getattr(ds, "NumberOfFrames", 1) or 1) > 1:
        shared = ds.SharedFunctionalGroupsSequence[0]
        shared_iop = ds_float_list(shared.PlaneOrientationSequence[0].ImageOrientationPatient, 6)
        shared_measures = shared.PixelMeasuresSequence[0]
        shared_spacing = ds_float_list(shared_measures.PixelSpacing, 2)
        shared_thickness = float(shared_measures.SliceThickness)
        root_slope = float(getattr(ds, "RescaleSlope", 1))
        root_intercept = float(getattr(ds, "RescaleIntercept", 0))
        shared_transform = getattr(shared, "PixelValueTransformationSequence", None)
        shared_slope = float(shared_transform[0].RescaleSlope) if shared_transform else root_slope
        shared_intercept = float(shared_transform[0].RescaleIntercept) if shared_transform else root_intercept
        raw_frames = np.asarray(ds.pixel_array)
        records = []
        for index, frame in enumerate(ds.PerFrameFunctionalGroupsSequence):
            frame_transform = getattr(frame, "PixelValueTransformationSequence", None)
            slope = float(frame_transform[0].RescaleSlope) if frame_transform else shared_slope
            intercept = float(frame_transform[0].RescaleIntercept) if frame_transform else shared_intercept
            records.append({
                "ipp": ds_float_list(frame.PlanePositionSequence[0].ImagePositionPatient, 3),
                "iop": shared_iop,
                "pixelSpacing": shared_spacing,
                "sliceThickness": shared_thickness,
                "frameOfReferenceUID": str(ds.FrameOfReferenceUID),
                "instanceNumber": index + 1,
                "rescaleSlope": slope,
                "rescaleIntercept": intercept,
                "rescaledPixels": [float(value * slope + intercept) for value in raw_frames[index].ravel()],
            })
        return records
    return [{
        "ipp": ds_float_list(ds.ImagePositionPatient, 3),
        "iop": ds_float_list(ds.ImageOrientationPatient, 6),
        "pixelSpacing": ds_float_list(ds.PixelSpacing, 2),
        "sliceThickness": float(ds.SliceThickness),
        "frameOfReferenceUID": str(ds.FrameOfReferenceUID),
        "instanceNumber": int(ds.InstanceNumber),
    }]


def spacing_stats(positions: list[list[float]], normal: list[float]) -> dict[str, Any]:
    if len(positions) < 2:
        return {"mean": 0.0, "min": 0.0, "max": 0.0, "regular": False}
    scalars = [dot3(position, normal) for position in positions]
    diffs = [abs(scalars[index + 1] - scalars[index]) for index in range(len(scalars) - 1)]
    diffs = [diff if diff > 1e-4 else 0.0 for diff in diffs]
    mean = sum(diffs) / len(diffs)
    minimum = min(diffs)
    maximum = max(diffs)
    tolerance = max(0.1, mean * 0.02)
    return {"mean": mean, "min": minimum, "max": maximum, "regular": minimum > 0 and (maximum - minimum) <= tolerance}


def expected_from_paths(case: dict[str, Any], paths: list[Path]) -> dict[str, Any]:
    records = [record for path in paths for record in frame_records(path)]
    row = normalize3(records[0]["iop"][:3])
    col = normalize3(records[0]["iop"][3:6])
    normal = normalize3(cross3(row, col))
    sorted_records = sorted(records, key=lambda record: (dot3(record["ipp"], normal), record["instanceNumber"]))
    positions = [record["ipp"] for record in sorted_records]
    stats = spacing_stats(positions, normal)
    frame_uids = [record["frameOfReferenceUID"].strip() for record in sorted_records]
    frame_consistent = bool(frame_uids) and all(value == frame_uids[0] for value in frame_uids)
    positions_distinct = len(positions) <= 1 or stats["min"] > 0
    volume_safe = bool(stats["regular"] and positions_distinct and frame_consistent)
    first = sorted_records[0]
    first_ipp = positions[0]
    last_ipp = positions[-1]
    slice_spacing = stats["mean"] if stats["mean"] > 0 else first["sliceThickness"]
    delta = [(last_ipp[index] - first_ipp[index]) / max(len(positions) - 1, 1) for index in range(3)]
    slice_dir = normalize3(delta) or normal
    row_spacing, col_spacing = first["pixelSpacing"]
    affine = [
        [row[0] * col_spacing, col[0] * row_spacing, slice_dir[0] * slice_spacing, first_ipp[0]],
        [row[1] * col_spacing, col[1] * row_spacing, slice_dir[1] * slice_spacing, first_ipp[1]],
        [row[2] * col_spacing, col[2] * row_spacing, slice_dir[2] * slice_spacing, first_ipp[2]],
        [0.0, 0.0, 0.0, 1.0],
    ]
    points = [
        [0, 0, 0],
        [min(1, case["cols"] - 1), min(1, case["rows"] - 1), min(1, len(positions) - 1)],
        [case["cols"] - 1, case["rows"] - 1, len(positions) - 1],
    ]
    expected = {
        "coordinateSystem": "LPS+",
        "units": "mm",
        "affineAppliesToVolume": volume_safe,
        "volumeStackSafe": volume_safe,
        "affine": matrix_json(affine),
        "voxelToWorldPoints": [
            {"voxel": point, "world": apply_affine(affine, point)}
            for point in points
        ],
        "series": {
            "slices": len(positions),
            "width": case["cols"],
            "height": case["rows"],
            "pixelSpacing": [row_spacing, col_spacing],
            "sliceThickness": first["sliceThickness"],
            "sliceSpacing": slice_spacing,
            "sliceSpacingRegular": bool(stats["regular"] and frame_consistent),
            "slicePositionsDistinct": bool(positions_distinct),
            "sliceSpacingStats": stats,
            "firstIPP": first_ipp,
            "lastIPP": last_ipp,
            "orientation": [*row, *col],
            "frameOfReferenceUIDConsistent": bool(frame_consistent),
            "geometryKind": "volumeStack" if volume_safe else "imageStack",
            "reconstructionCapability": "display-volume" if volume_safe else "2d-only",
            "renderability": "volume" if volume_safe else "2d",
            "dicomImportKind": "volume-stack" if volume_safe else "image-stack",
            "isReconstructedVolumeStack": bool(volume_safe),
        },
    }
    if frame_consistent:
        expected["series"]["frameOfReferenceUID"] = frame_uids[0]
    if case.get("verify_rescale"):
        expected["frameRescales"] = [
            [record["rescaleSlope"], record["rescaleIntercept"]]
            for record in sorted_records
        ]
        expected["rescaledPixels"] = [
            value
            for record in sorted_records
            for value in record["rescaledPixels"]
        ]
        expected["normalizedVolume"] = [
            (min(2048.0, max(-1024.0, value)) + 1024.0) / 3072.0
            for value in expected["rescaledPixels"]
        ]
    return expected


def apply_affine(affine: list[list[float]], voxel: list[int]) -> list[float]:
    i, j, k = voxel
    return [
        affine[0][0] * i + affine[0][1] * j + affine[0][2] * k + affine[0][3],
        affine[1][0] * i + affine[1][1] * j + affine[1][2] * k + affine[1][3],
        affine[2][0] * i + affine[2][1] * j + affine[2][2] * k + affine[2][3],
    ]


def case_data() -> list[dict[str, Any]]:
    sqrt2 = math.sqrt(2)
    oblique_iop = [
        1 / sqrt2,
        1 / sqrt2,
        0.0,
        -0.5,
        0.5,
        1 / sqrt2,
    ]
    return [
        {
            "id": "axial-regular",
            "description": "regular axial single-frame CT stack",
            "rows": 3,
            "cols": 4,
            "iop": [1, 0, 0, 0, 1, 0],
            "pixel_spacing": [0.8, 0.6],
            "slice_thickness": 1.5,
            "positions": [[-30, 20, 5 + 1.5 * index] for index in range(4)],
        },
        {
            "id": "oblique-iop",
            "description": "regular oblique stack with non-axial row/column direction cosines",
            "rows": 3,
            "cols": 4,
            "iop": oblique_iop,
            "pixel_spacing": [0.7, 1.1],
            "slice_thickness": 2.25,
            "positions": [
                vector_add([12.0, -18.0, 30.0], vector_scale(normalize3(cross3(oblique_iop[:3], oblique_iop[3:])), 2.25 * index))
                for index in range(3)
            ],
        },
        {
            "id": "reversed-slice-order",
            "description": "files are written opposite patient-space slice order",
            "rows": 2,
            "cols": 3,
            "iop": [1, 0, 0, 0, 1, 0],
            "pixel_spacing": [1.0, 1.2],
            "slice_thickness": 2.0,
            "positions": [[2, 4, -6 + 2 * index] for index in range(3)],
            "file_order": [2, 1, 0],
        },
        {
            "id": "duplicate-ipp",
            "description": "duplicate ImagePositionPatient should prevent volume-stack use",
            "rows": 2,
            "cols": 3,
            "iop": [1, 0, 0, 0, 1, 0],
            "pixel_spacing": [0.9, 0.9],
            "slice_thickness": 1.0,
            "positions": [[0, 0, 0], [0, 0, 0], [0, 0, 2]],
        },
        {
            "id": "mixed-frame-of-reference",
            "description": "mixed FrameOfReferenceUID should prevent volume-stack use",
            "rows": 2,
            "cols": 3,
            "iop": [1, 0, 0, 0, 1, 0],
            "pixel_spacing": [0.75, 0.75],
            "slice_thickness": 1.25,
            "positions": [[5, 6, 7 + 1.25 * index] for index in range(3)],
            "frame_uids": [uid("mixed-frame-of-reference", "frame-a"), uid("mixed-frame-of-reference", "frame-b"), uid("mixed-frame-of-reference", "frame-a")],
        },
        {
            "id": "enhanced-multiframe",
            "description": "enhanced multi-frame geometry and per-frame pixel-value transformations",
            "rows": 2,
            "cols": 3,
            "iop": [1, 0, 0, 0, 1, 0],
            "pixel_spacing": [0.9, 0.4],
            "slice_thickness": 1.2,
            "positions": [[5, -5, 10 + 1.2 * index] for index in range(3)],
            "shared_rescale": [3, -30],
            "frame_rescales": [[2, -20], None, [4, -40]],
            "verify_rescale": True,
            "enhanced": True,
        },
    ]


def write_case(case: dict[str, Any]) -> None:
    paths = write_enhanced_case(case) if case.get("enhanced") else write_classic_case(case)
    expected = expected_from_paths(case, paths)
    golden = {
        "fixture": case["id"],
        "description": case["description"],
        "files": [str(path.relative_to(FIXTURE_DIR)) for path in paths],
        "reference": DICOM_REFERENCE,
        "dicom": {
            "rows": case["rows"],
            "columns": case["cols"],
            "imagePlaneFormula": "P = S + i * columnSpacing * rowDirection + j * rowSpacing * columnDirection",
        },
        "expectedVoxelLab": expected,
    }
    _ = (FIXTURE_DIR / f"{case['id']}.golden.json").write_text(
        json.dumps(golden, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    for case in case_data():
        write_case(case)


if __name__ == "__main__":
    main()
