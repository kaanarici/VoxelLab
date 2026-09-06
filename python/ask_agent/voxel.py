from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np

_CT_LO_HU, _CT_HI_HU = -1024.0, 2048.0

DATA = Path(os.environ.get("VOXELLAB_DATA_DIR") or (Path(__file__).resolve().parents[2] / "data"))

def _meta(slug: str) -> dict:
    manifest = json.loads((DATA / "manifest.json").read_text())
    for series in manifest.get("series", []):
        if series.get("slug") == slug:
            return series
    raise ValueError(f"unknown series slug: {slug!r}")

def dims(slug: str) -> tuple[int, int, int]:

    meta = _meta(slug)
    return int(meta["slices"]), int(meta["height"]), int(meta["width"])

def _raw_path(slug: str) -> Path:
    path = DATA / f"{slug}.raw"
    if not path.exists():
        raise FileNotFoundError(f"no raw volume for {slug!r} (expected {path})")
    return path

def load_volume(slug: str) -> np.ndarray:

    d, h, w = dims(slug)
    vol = np.fromfile(_raw_path(slug), dtype=np.uint16)
    if vol.size != d * h * w:
        raise ValueError(f"raw size {vol.size} != {d}*{h}*{w} for {slug!r}")
    return vol.reshape(d, h, w)

def load_slice(slug: str, idx: int) -> np.ndarray:

    d, h, w = dims(slug)
    if not 0 <= idx < d:
        raise IndexError(f"slice {idx} out of range [0, {d})")
    flat = np.fromfile(_raw_path(slug), dtype=np.uint16, count=h * w, offset=idx * h * w * 2)
    return flat.reshape(h, w)

def to_hu(slug: str, arr: np.ndarray) -> np.ndarray:

    if (_meta(slug).get("modality") or "").upper() != "CT":
        raise ValueError(f"{slug!r} is not CT — raw values are relative intensity, not HU")
    scaled = arr.astype(np.float32) / 65535.0
    return scaled * (_CT_HI_HU - _CT_LO_HU) + _CT_LO_HU

def window(arr: np.ndarray, center: float, width: float) -> np.ndarray:

    lo = center - width / 2.0
    hi = center + width / 2.0
    norm = np.clip((arr.astype(np.float32) - lo) / (hi - lo), 0.0, 1.0)
    return (norm * 255.0).astype(np.uint8)

def spacing_mm(slug: str) -> tuple[float, float, float]:

    meta = _meta(slug)
    ps = meta.get("pixelSpacing") or [1.0, 1.0]
    z = float(meta.get("sliceThickness") or 1.0)
    return z, float(ps[0]), float(ps[1])
