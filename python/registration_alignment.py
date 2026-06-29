from __future__ import annotations

import math
import time
from datetime import datetime, timezone
from typing import Any

from geometry import cross3, geometry_from_slices, norm3
from modal_dicom import stack_pixels_with_rescale

BRAIN_RADIUS_MM = 80.0


def _finite(value: Any) -> float | None:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def _series_uid(slices: list) -> str:
    return str(getattr(slices[0], "SeriesInstanceUID", "") or "") if slices else ""


def _series_label(slices: list, fallback: str) -> str:
    if not slices:
        return fallback
    desc = str(getattr(slices[0], "SeriesDescription", "") or "").strip()
    return desc or _series_uid(slices) or fallback


def _geometry_spacing_dhw(geometry: dict[str, Any]) -> tuple[float, float, float]:
    spacing = geometry.get("pixelSpacing") or [1.0, 1.0]
    return (
        float(geometry.get("sliceSpacing") or geometry.get("sliceThickness") or 1.0),
        float(spacing[0] or 1.0),
        float(spacing[1] or 1.0),
    )


def _volume_xyz(slices: list, np):
    return np.transpose(stack_pixels_with_rescale(slices), (2, 1, 0))


def _ants_image_from_slices(slices: list, np, ants):
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
        _volume_xyz(slices, np),
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


def _quality(verdict: str, translation_mm: float | None, dice: float | None, rotation_deg: float | None) -> dict[str, Any]:
    grade = "unknown"
    if verdict == "aligned":
        grade = "good"
    elif verdict == "slightly off":
        grade = "fair"
    elif verdict == "misregistered":
        grade = "poor"
    return {
        "mm": round(float(translation_mm), 2) if translation_mm is not None else None,
        "grade": grade,
        "dice": dice,
        "rotationDeg": round(float(rotation_deg), 2) if rotation_deg is not None else None,
        "verdict": verdict,
    }


def _verdict(translation_mm: float | None, rotation_deg: float | None, dice: float | None) -> str:
    t = float(translation_mm) if translation_mm is not None else float("inf")
    r = float(rotation_deg) if rotation_deg is not None else float("inf")
    d = float(dice) if dice is not None else 0.0
    if t < 2.0 and r < 2.0 and d > 0.9:
        return "aligned"
    if t < 5.0 and r < 5.0 and d > 0.8:
        return "slightly off"
    return "misregistered"


def _transform_magnitude(ants, paths: list[str], np) -> dict[str, Any]:
    transform_path = next((path for path in paths if str(path).endswith(".mat")), paths[0] if paths else "")
    translation = [0.0, 0.0, 0.0]
    rotation_deg = 0.0
    if transform_path:
        params = np.array(ants.read_transform(transform_path).parameters, dtype=np.float64)
        if params.size >= 12:
            matrix = params[:9].reshape(3, 3)
            translation = [float(value) for value in params[9:12]]
            cos_theta = max(-1.0, min(1.0, (float(np.trace(matrix)) - 1.0) / 2.0))
            rotation_deg = float(math.degrees(math.acos(cos_theta)))
        elif params.size >= 6:
            translation = [float(value) for value in params[3:6]]
            rotation_deg = float(math.degrees(math.sqrt(float(np.dot(params[:3], params[:3])))))
    translation_mag = float(math.sqrt(sum(value * value for value in translation)))
    return {
        "translationMm": translation,
        "translationMagnitudeMm": translation_mag,
        "rotationDeg": rotation_deg,
        "rotationMagnitudeMm": BRAIN_RADIUS_MM * math.radians(rotation_deg),
    }


def _fit_to_shape(vol, shape: tuple[int, int, int], np):
    out = np.zeros(shape, dtype=np.float32)
    dz = min(shape[0], vol.shape[0])
    dy = min(shape[1], vol.shape[1])
    dx = min(shape[2], vol.shape[2])
    out[:dz, :dy, :dx] = vol[:dz, :dy, :dx]
    return out


def _center_of_mass_align(fixed_slices: list, moving_slices: list, transform: str, np, ndimage, started: float) -> dict[str, Any]:
    fixed = stack_pixels_with_rescale(fixed_slices)
    moving = _fit_to_shape(stack_pixels_with_rescale(moving_slices), fixed.shape, np)
    fixed_mask = fixed > (0.05 * float(np.max(fixed) or 1.0))
    moving_mask = moving > (0.05 * float(np.max(moving) or 1.0))
    fixed_center = ndimage.center_of_mass(fixed_mask) if fixed_mask.any() else tuple(value / 2 for value in fixed.shape)
    moving_center = ndimage.center_of_mass(moving_mask) if moving_mask.any() else tuple(value / 2 for value in moving.shape)
    shift_dhw = [float(fixed_center[i] - moving_center[i]) for i in range(3)]
    warped = ndimage.shift(moving, shift_dhw, order=1, mode="constant", cval=0.0).astype(np.float32)
    spacing_dhw = _geometry_spacing_dhw(geometry_from_slices(fixed_slices))
    translation = [shift_dhw[2] * spacing_dhw[2], shift_dhw[1] * spacing_dhw[1], shift_dhw[0] * spacing_dhw[0]]
    translation_mag = float(math.sqrt(sum(value * value for value in translation)))
    metrics = _masked_metrics(fixed, warped, np)
    verdict = _verdict(translation_mag, 0.0, metrics["dice"])
    return {
        "volume": warped,
        "method": "scipy.ndimage center-of-mass translation fallback",
        "antsVersion": "",
        "transformType": "translation" if transform == "translation" else "translation-fallback",
        "transform": {
            "translationMm": translation,
            "translationMagnitudeMm": translation_mag,
            "rotationDeg": 0.0,
            "rotationMagnitudeMm": 0.0,
        },
        "metrics": {**metrics, "mutualInformation": None, "runtimeSeconds": time.time() - started},
        "verdict": verdict,
        "quality": _quality(verdict, translation_mag, metrics["dice"], 0.0),
    }


def align_registration_pair(fixed_slices: list, moving_slices: list, *, transform: str, np, ndimage) -> dict[str, Any]:
    started = time.time()
    transform = transform if transform in {"rigid", "translation"} else "rigid"
    try:
        import ants

        fixed = _ants_image_from_slices(fixed_slices, np, ants)
        moving = _ants_image_from_slices(moving_slices, np, ants)
        transform_name = "Rigid" if transform == "rigid" else "Translation"
        registration = ants.registration(fixed=fixed, moving=moving, type_of_transform=transform_name, verbose=False)
        warped_xyz = registration["warpedmovout"].numpy().astype(np.float32)
        warped_dhw = np.transpose(warped_xyz, (2, 1, 0))
        metrics = _masked_metrics(fixed.numpy(), warped_xyz, np)
        try:
            metrics["mutualInformation"] = float(ants.image_mutual_information(fixed, registration["warpedmovout"]))
        except Exception:
            metrics["mutualInformation"] = None
        magnitude = _transform_magnitude(ants, registration.get("fwdtransforms", []), np)
        metrics["runtimeSeconds"] = time.time() - started
        verdict = _verdict(magnitude["translationMagnitudeMm"], magnitude["rotationDeg"], metrics["dice"])
        result = {
            "volume": warped_dhw,
            "method": f"ANTsPy ants.registration type_of_transform='{transform_name}'",
            "antsVersion": str(getattr(ants, "__version__", "") or ""),
            "transformType": transform,
            "transform": magnitude,
            "metrics": metrics,
            "verdict": verdict,
            "quality": _quality(verdict, magnitude["translationMagnitudeMm"], metrics["dice"], magnitude["rotationDeg"]),
        }
    except Exception as exc:
        result = _center_of_mass_align(fixed_slices, moving_slices, transform, np, ndimage, started)
        result["fallbackReason"] = str(exc)

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
        "translation_mm": result["transform"]["translationMm"],
        "translation_magnitude_mm": result["transform"]["translationMagnitudeMm"],
        "rotation_deg": result["transform"]["rotationDeg"],
        "rotation_magnitude_mm": result["transform"]["rotationMagnitudeMm"],
        "dice": result["metrics"].get("dice"),
        "mse_normalized": result["metrics"].get("mseNormalized"),
        "mutual_information": result["metrics"].get("mutualInformation"),
        "runtime_seconds": result["metrics"].get("runtimeSeconds"),
    }
    if result.get("fallbackReason"):
        result["record"]["fallbackReason"] = result["fallbackReason"]
    return result
