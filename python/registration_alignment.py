from __future__ import annotations

import math
import time
from datetime import datetime, timezone
from typing import Any

from geometry import cross3, geometry_from_slices, norm3
from modal_dicom import mpr_geometry_error, stack_pixels_with_rescale

def _series_uid(slices: list) -> str:
    return str(getattr(slices[0], "SeriesInstanceUID", "") or "") if slices else ""

def _series_label(slices: list, fallback: str) -> str:
    if not slices:
        return fallback
    desc = str(getattr(slices[0], "SeriesDescription", "") or "").strip()
    return desc or _series_uid(slices) or fallback

def _volume_xyz(slices: list, np):
    return np.transpose(stack_pixels_with_rescale(slices), (2, 1, 0))

def ants_image_from_slices(slices: list, np, ants):
    error = mpr_geometry_error(slices)
    if error:
        raise ValueError(error)
    volume = _volume_xyz(slices, np)
    if not np.isfinite(volume).all():
        raise ValueError("Registration requires finite source samples")
    geometry = geometry_from_slices(slices)
    orientation = geometry["orientation"]
    row = orientation[:3]
    col = orientation[3:6]
    slice_dir = [
        geometry["lastIPP"][i] - geometry["firstIPP"][i]
        for i in range(3)
    ]
    slice_norm = norm3(slice_dir)
    normal = [value / slice_norm for value in slice_dir] if slice_norm > 1e-6 else cross3(row, col)
    direction = np.array([
        [row[0], col[0], normal[0]],
        [row[1], col[1], normal[1]],
        [row[2], col[2], normal[2]],
    ], dtype=np.float64)
    spacing = (
        float(geometry["pixelSpacing"][1]),
        float(geometry["pixelSpacing"][0]),
        float(geometry["sliceSpacing"]),
    )
    return ants.from_numpy(
        volume,
        origin=tuple(float(value) for value in geometry["firstIPP"]),
        spacing=spacing,
        direction=direction,
    )

def _masked_metrics(fixed, warped, np) -> dict[str, float | None]:
    f = np.asarray(fixed, dtype=np.float32)
    w = np.asarray(warped, dtype=np.float32)
    if f.shape != w.shape:
        return {"mseNormalized": None, "dice": None}
    fmax = float(np.max(f)) if f.size else 1.0
    wmax = float(np.max(w)) if w.size else 1.0
    fmax = fmax if fmax > 0 else 1.0
    wmax = wmax if wmax > 0 else 1.0
    f_mask = f > (0.05 * fmax)
    w_mask = w > (0.05 * wmax)
    inter = f_mask & w_mask
    mse = float(np.mean(((f[inter] / fmax) - (w[inter] / wmax)) ** 2)) if inter.any() else None
    denom = int(f_mask.sum() + w_mask.sum())
    dice = float(2.0 * int((f_mask & w_mask).sum()) / denom) if denom else None
    return {"mseNormalized": mse, "dice": dice}

def registration_transform(ants, paths: list[str], np) -> dict[str, Any]:
    transform_path = next((path for path in paths if str(path).endswith(".mat")), paths[0] if paths else "")
    if not transform_path:
        raise ValueError("Registration did not return a transform")
    params = np.asarray(ants.read_transform(transform_path).parameters, dtype=np.float64)
    if not np.isfinite(params).all():
        raise ValueError("Registration returned non-finite transform parameters")
    if params.size == 12:
        matrix = params[:9].reshape(3, 3)
        if not np.allclose(matrix.T @ matrix, np.eye(3), atol=1e-4) or not np.isclose(np.linalg.det(matrix), 1.0, atol=1e-4):
            raise ValueError("Registration returned a non-rigid transform")
        translation = params[9:12].tolist()
        cos_theta = max(-1.0, min(1.0, (float(np.trace(matrix)) - 1.0) / 2.0))
        rotation_deg = float(math.degrees(math.acos(cos_theta)))
    elif params.size == 3:
        translation = params.tolist()
        rotation_deg = 0.0
    else:
        raise ValueError("Registration returned an unsupported transform encoding")
    translation_mag = float(math.sqrt(sum(value * value for value in translation)))
    return {
        "translationMm": translation,
        "translationMagnitudeMm": translation_mag,
        "rotationDeg": rotation_deg,
    }

def align_registration_pair(fixed_slices: list, moving_slices: list, *, transform: str, np) -> dict[str, Any]:
    started = time.time()
    if transform not in {"rigid", "translation"}:
        raise ValueError("Registration supports rigid or translation transforms")
    import ants

    fixed = ants_image_from_slices(fixed_slices, np, ants)
    moving = ants_image_from_slices(moving_slices, np, ants)
    transform_name = "Rigid" if transform == "rigid" else "Translation"
    registration = ants.registration(fixed=fixed, moving=moving, type_of_transform=transform_name, verbose=False)
    warped_xyz = registration["warpedmovout"].numpy().astype(np.float32)
    if warped_xyz.shape != fixed.numpy().shape or not np.isfinite(warped_xyz).all():
        raise ValueError("Registration returned an invalid fixed-space volume")
    warped_dhw = np.transpose(warped_xyz, (2, 1, 0))
    metrics = _masked_metrics(fixed.numpy(), warped_xyz, np)
    try:
        metrics["mutualInformation"] = float(ants.image_mutual_information(fixed, registration["warpedmovout"]))
    except Exception:
        metrics["mutualInformation"] = None
    magnitude = registration_transform(ants, registration.get("fwdtransforms", []), np)
    metrics["runtimeSeconds"] = time.time() - started
    result = {
        "volume": warped_dhw,
        "method": f"ANTsPy ants.registration type_of_transform='{transform_name}'",
        "antsVersion": str(getattr(ants, "__version__", "") or ""),
        "transformType": transform,
        "transform": magnitude,
        "metrics": metrics,
        "verdict": "alignment unverified",
        "quality": {
            "mm": magnitude["translationMagnitudeMm"],
            "grade": "unknown",
            "dice": metrics["dice"],
            "rotationDeg": magnitude["rotationDeg"],
            "verdict": "alignment unverified",
        },
    }

    generated_at = datetime.now(timezone.utc).isoformat()
    fixed_uid = _series_uid(fixed_slices)
    moving_uid = _series_uid(moving_slices)
    result["record"] = {
        "source": "modal:rigid_registration",
        "referenceSlug": fixed_uid,
        "movingSlug": moving_uid,
        "fixedSeriesUID": fixed_uid,
        "movingSeriesUID": moving_uid,
        "fixedName": _series_label(fixed_slices, "fixed series"),
        "movingName": _series_label(moving_slices, "moving series"),
        "method": result["method"],
        "antsVersion": result["antsVersion"],
        "generatedAt": generated_at,
        "transform": {"type": result["transformType"], **result["transform"]},
        "metrics": result["metrics"],
        "verdict": result["verdict"],
        "quality": result["quality"],
    }
    return result
