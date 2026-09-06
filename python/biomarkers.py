import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pydicom
from PIL import Image
from scipy import ndimage

from geometry import series_effective_slice_spacing, sort_datasets_spatially
from json_store import update_json
from pipeline_paths import ENV_DICOM_ROOT, resolve_dicom_root, slug_source_map

DATA = Path(__file__).resolve().parents[1] / "data"

def load_brain_stack(slug: str) -> np.ndarray:

    folder = DATA / f"{slug}_brain"
    files = sorted(folder.glob("*.png"))
    if not files:
        raise FileNotFoundError(f"no brain PNGs in {folder}")
    return np.stack([np.array(Image.open(f).convert("L")) for f in files])

def read_dicom_series(source: Path, src_folder: str) -> list:

    folder = source / src_folder
    mr = []

    skip_names = {".DS_Store", "Thumbs.db", "DICOMDIR"}
    candidates = sorted(f for f in folder.iterdir()
                        if f.is_file() and f.name not in skip_names
                        and not f.name.startswith("._")
                        and f.suffix.lower() not in (".png", ".jpg", ".txt", ".json"))
    for f in candidates:
        d = pydicom.dcmread(f, stop_before_pixels=True)
        if str(getattr(d, "Modality", "")) != "MR":
            continue
        if str(getattr(d, "BodyPartExamined", "")).upper() not in ("", "BRAIN", "HEAD"):
            continue
        mr.append(d)
    return sort_datasets_spatially(mr)

def merge_stats(slug: str, extra: dict) -> None:

    p = DATA / f"{slug}_stats.json"

    def merge(current: dict) -> dict:
        current.update(extra)
        return current

    _ = update_json(p, merge, default={"slug": slug})

def _detect_microbleed_candidates(brain: np.ndarray):
    D = brain.shape[0]
    mask = brain > 5

    inv = np.zeros_like(brain, dtype=np.float32)
    inv[mask] = 255.0 - brain[mask].astype(np.float32)

    sigma_small = (0.4, 1.2, 1.2)
    sigma_large = (0.8, 2.4, 2.4)
    dog = ndimage.gaussian_filter(inv, sigma_small) - ndimage.gaussian_filter(inv, sigma_large)
    dog[~mask] = 0

    inbrain_dog = dog[mask]
    if inbrain_dog.size == 0:
        return None
    threshold = np.percentile(inbrain_dog, 99.7)
    hot = dog > threshold

    lbl, n = ndimage.label(hot)
    if n == 0:
        return [], [0] * D, n

    sizes = ndimage.sum(hot, lbl, range(1, n + 1))
    candidates = []

    for i, sz in enumerate(sizes):
        if sz < 2 or sz > 50:
            continue
        coords = np.where(lbl == (i + 1))
        cz = float(coords[0].mean())
        cy = float(coords[1].mean())
        cx = float(coords[2].mean())
        peak = float(dog[lbl == (i + 1)].max())
        candidates.append({
            "z": int(round(cz)),
            "y": int(round(cy)),
            "x": int(round(cx)),
            "voxels": int(sz),
            "score": round(peak, 2),
        })

    candidates.sort(key=lambda c: c["score"], reverse=True)
    candidates = candidates[:40]

    per_slice = [0] * D
    for c in candidates:
        per_slice[c["z"]] += 1
    return candidates, per_slice, n

def detect_microbleeds() -> None:

    slug = "swi_3d"
    print(f"\n=== {slug} microbleeds ===", flush=True)

    try:
        brain = load_brain_stack(slug)
    except FileNotFoundError as e:
        print(f"  skip: {e}", flush=True)
        return

    mask = brain > 5
    print(f"  volume: {brain.shape}, brain voxels: {mask.sum():,}", flush=True)

    result = _detect_microbleed_candidates(brain)
    if result is None:
        return
    candidates, per_slice, component_count = result
    if component_count == 0:
        merge_stats(slug, {"microbleeds": {"candidates": [], "count": 0}})
        print(f"  no candidates", flush=True)
        return

    merge_stats(slug, {
        "microbleeds": {
            "candidates": candidates,
            "count": len(candidates),
            "per_slice": per_slice,
            "method": "DoG sigma=(0.4,1.2,1.2)/(0.8,2.4,2.4), threshold=p99.7 in-brain, size 2..50 voxels",
            "disclaimer": "Unverified candidates. Includes normal vessels, perivascular spaces, and air-tissue interfaces. Not a diagnosis.",
        }
    })
    print(f"  {len(candidates)} candidates (top score={candidates[0]['score'] if candidates else '-'})", flush=True)
    print(f"  slices with candidates: {sum(1 for n in per_slice if n > 0)}", flush=True)

def _compute_wmh_stats(brain: np.ndarray, voxel_ml: float):
    D = brain.shape[0]
    mask = brain > 5
    inbrain = brain[mask]
    if inbrain.size == 0:
        return None

    threshold = np.percentile(inbrain, 98)
    hot = (brain >= threshold) & mask

    lbl, n = ndimage.label(hot)
    if n == 0:
        return {"volume_ml": 0.0, "voxels": 0}, n

    sizes = ndimage.sum(hot, lbl, range(1, n + 1))
    kept_labels = np.where(sizes >= 3)[0] + 1
    kept_mask = np.isin(lbl, kept_labels)

    voxels = int(kept_mask.sum())
    ml = round(voxels * voxel_ml, 2)
    per_slice = [int(kept_mask[z].sum() * voxel_ml * 100) / 100 for z in range(D)]
    return {
        "volume_ml": ml,
        "voxels": voxels,
        "per_slice_ml": per_slice,
        "threshold_percentile": 98,
        "method": "in-brain voxels above p98, min component size 3",
        "disclaimer": "Approximate WMH burden, not a diagnostic Fazekas score.",
    }, n

def compute_wmh_burden() -> None:

    slug = "flair"
    print(f"\n=== {slug} WMH burden ===", flush=True)

    try:
        brain = load_brain_stack(slug)
    except FileNotFoundError as e:
        print(f"  skip: {e}", flush=True)
        return

    m = json.loads((DATA / "manifest.json").read_text())
    s = next(s for s in m["series"] if s["slug"] == slug)
    voxel_ml = (s["pixelSpacing"][0] * s["pixelSpacing"][1] * series_effective_slice_spacing(s)) / 1000.0

    result = _compute_wmh_stats(brain, voxel_ml)
    if result is None:
        return
    stats, component_count = result
    if component_count == 0:
        merge_stats(slug, {"wmh": stats})
        print(f"  no hot voxels", flush=True)
        return
    merge_stats(slug, {"wmh": stats})
    print(f"  WMH burden: {stats['volume_ml']} mL ({stats['voxels']} voxels)", flush=True)

def _adc_physical_values(raw_values: np.ndarray, slope: float, intercept: float) -> np.ndarray:
    return raw_values.astype(np.float64) * slope + intercept

def extract_adc_physical(source: Path) -> None:

    slug = "dwi_adc"
    print(f"\n=== {slug} ADC physical units ===", flush=True)

    src = slug_source_map().get(slug)
    if not src:
        return
    try:
        mr = read_dicom_series(source, src)
    except Exception as e:
        print(f"  skip: {e}", flush=True)
        return
    if not mr:
        print(f"  no DICOMs", flush=True)
        return

    d = mr[0]
    slope = float(getattr(d, "RescaleSlope", 1.0))
    intercept = float(getattr(d, "RescaleIntercept", 0.0))
    units = str(getattr(d, "Units", "") or getattr(d, "RescaleType", "")).strip()

    hr_meta_path = DATA / f"{slug}_hr.json"
    if not hr_meta_path.exists():
        print(f"  skip: {hr_meta_path} missing — run rehires.py first", flush=True)
        return
    hr_meta = json.loads(hr_meta_path.read_text())
    lo_raw = float(hr_meta["rescale"]["lo"])
    hi_raw = float(hr_meta["rescale"]["hi"])

    physical_range = _adc_physical_values(np.array([lo_raw, hi_raw], dtype=np.float64), slope, intercept)
    lo_physical = float(physical_range[0])
    hi_physical = float(physical_range[1])

    merge_stats(slug, {
        "adc": {
            "rescale_slope":     slope,
            "rescale_intercept": intercept,
            "units":             units or "10^-6 mm^2/s",

            "hr_lo_raw":         lo_raw,
            "hr_hi_raw":         hi_raw,
            "raw_range":         [lo_raw, hi_raw],
            "physical_range":    [lo_physical, hi_physical],

            "display_unit":      "×10⁻³ mm²/s",
            "display_divisor":   1000.0,
        }
    })
    print(f"  slope={slope}, intercept={intercept}, units='{units or '(none)'}'", flush=True)
    print(f"  hr rescale range: {lo_raw:.0f}..{hi_raw:.0f}", flush=True)
    print(f"  displayed as: {lo_physical/1000:.2f}..{hi_physical/1000:.2f} ×10⁻³ mm²/s", flush=True)

def main() -> bool:
    ap = argparse.ArgumentParser(
        description="Image-math biomarkers (microbleeds / WMH / ADC units).",
    )
    _ = ap.add_argument(
        "--source",
        "-s",
        type=Path,
        default=None,
        help=f"DICOM root for ADC rescale lookup (default: {ENV_DICOM_ROOT})",
    )
    _ = ap.add_argument(
        "parts",
        nargs="*",
        metavar="PART",
        help="microbleeds | wmh | adc (default: all three), or series slugs swi_3d/flair/dwi_adc",
    )
    args = ap.parse_args()

    source = resolve_dicom_root(args.source)
    if source is None:
        print(
            f"Missing DICOM root. Set {ENV_DICOM_ROOT} or pass --source DIR",
            file=sys.stderr,
        )
        return False

    tokens = set(args.parts)
    slug_alias = {"swi_3d": "microbleeds", "flair": "wmh", "dwi_adc": "adc"}
    for s, alias in slug_alias.items():
        if s in tokens:
            tokens.add(alias)
    do_all = not tokens
    if do_all or "microbleeds" in tokens:
        detect_microbleeds()
    if do_all or "wmh" in tokens:
        compute_wmh_burden()
    if do_all or "adc" in tokens:
        extract_adc_physical(source)
    print("\nDone.", flush=True)
    return True

if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
