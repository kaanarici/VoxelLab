"""Real-voxel access for the local Ask agent.

During /api/ask the agent runs Python in a scratch dir. The slice PNGs it can
Read are 8-bit and windowed for display; this helper hands it the true voxel
volume + geometry so any measurement or re-windowing it does is grounded.

    import sys; sys.path.insert(0, "<this dir>")
    from voxel import load_slice, load_volume, to_hu, window, spacing_mm

Raw volumes are uint16, shape (slices, height, width), C-order, at data/<slug>.raw.
CT raw encodes Hounsfield units through the fixed window [-1024, +2048] HU -> [0, 65535]
(see python/convert_ct.py); to_hu() inverts it. MR / other raw is relative intensity
with no absolute scale, so to_hu() refuses for non-CT series.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np

# Fixed HU window used when CT .raw was written (python/convert_ct.py).
_CT_LO_HU, _CT_HI_HU = -1024.0, 2048.0

DATA = Path(os.environ.get("VOXELLAB_DATA_DIR") or (Path(__file__).resolve().parents[2] / "data"))


def _meta(slug: str) -> dict:
    manifest = json.loads((DATA / "manifest.json").read_text())
    for series in manifest.get("series", []):
        if series.get("slug") == slug:
            return series
    raise ValueError(f"unknown series slug: {slug!r}")


def dims(slug: str) -> tuple[int, int, int]:
    """Volume shape as (slices D, height H, width W)."""
    meta = _meta(slug)
    return int(meta["slices"]), int(meta["height"]), int(meta["width"])


def _raw_path(slug: str) -> Path:
    path = DATA / f"{slug}.raw"
    if not path.exists():
        raise FileNotFoundError(f"no raw volume for {slug!r} (expected {path})")
    return path


def load_volume(slug: str) -> np.ndarray:
    """Full raw volume as uint16, shape (D, H, W)."""
    d, h, w = dims(slug)
    vol = np.fromfile(_raw_path(slug), dtype=np.uint16)
    if vol.size != d * h * w:
        raise ValueError(f"raw size {vol.size} != {d}*{h}*{w} for {slug!r}")
    return vol.reshape(d, h, w)


def load_slice(slug: str, idx: int) -> np.ndarray:
    """One slice as uint16, shape (H, W). Reads only that slice off disk."""
    d, h, w = dims(slug)
    if not 0 <= idx < d:
        raise IndexError(f"slice {idx} out of range [0, {d})")
    flat = np.fromfile(_raw_path(slug), dtype=np.uint16, count=h * w, offset=idx * h * w * 2)
    return flat.reshape(h, w)


def to_hu(slug: str, arr: np.ndarray) -> np.ndarray:
    """Convert CT raw uint16 to Hounsfield units (float32). CT series only."""
    if (_meta(slug).get("modality") or "").upper() != "CT":
        raise ValueError(f"{slug!r} is not CT — raw values are relative intensity, not HU")
    scaled = arr.astype(np.float32) / 65535.0
    return scaled * (_CT_HI_HU - _CT_LO_HU) + _CT_LO_HU


def window(arr: np.ndarray, center: float, width: float) -> np.ndarray:
    """Window/level any array (e.g. HU) to uint8 [0,255] for visual inspection.

    CT presets (center, width): soft (40, 400), lung (-600, 1500), bone (400, 1800).
    """
    lo = center - width / 2.0
    hi = center + width / 2.0
    norm = np.clip((arr.astype(np.float32) - lo) / (hi - lo), 0.0, 1.0)
    return (norm * 255.0).astype(np.uint8)


def spacing_mm(slug: str) -> tuple[float, float, float]:
    """Voxel spacing in mm as (z=slice, y=row, x=column)."""
    meta = _meta(slug)
    ps = meta.get("pixelSpacing") or [1.0, 1.0]
    z = float(meta.get("sliceThickness") or 1.0)
    return z, float(ps[0]), float(ps[1])
