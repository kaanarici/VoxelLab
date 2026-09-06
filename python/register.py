from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import ants
import numpy as np
import pydicom

from geometry import sort_datasets_spatially
from registration_alignment import ants_image_from_slices, registration_transform
from pipeline_paths import ENV_DICOM_ROOT, candidate_dicom_files, resolve_dicom_root, slug_source_map

DATA = Path(__file__).resolve().parents[1] / "data"

REFERENCE = "t1_se"
MOVING_SLUGS = ["t2_tse", "flair", "dwi_adc", "swi_3d"]

def load_series(source: Path, slug: str, sources: dict[str, str]):

    src = sources.get(slug)
    if not src:
        print(f"  [{slug}] no sourceFolder in manifest", file=sys.stderr)
        return None
    folder = source / src
    files = candidate_dicom_files(folder)

    mr = []
    for f in files:
        try:
            d = pydicom.dcmread(f)
        except Exception:
            continue
        if str(getattr(d, "Modality", "")) != "MR":
            continue
        mr.append(d)
    mr = sort_datasets_spatially(mr)

    if not mr:
        print(f"no MR slices found for {slug} in {folder}", file=sys.stderr)
        return None

    img = ants_image_from_slices(mr, np, ants)
    print(f"  [{slug}] shape={img.shape} spacing={img.spacing} origin={img.origin}", flush=True)
    return img

def alignment_metrics(fixed: ants.core.ants_image.ANTsImage,
                      warped: ants.core.ants_image.ANTsImage) -> dict:

    f = fixed.numpy()
    w = warped.numpy()

    if f.shape != w.shape:

        raise RuntimeError(f"shape mismatch: fixed={f.shape} warped={w.shape}")

    fmax = float(f.max()) if f.size else 1.0
    wmax = float(w.max()) if w.size else 1.0
    if fmax <= 0:
        fmax = 1.0
    if wmax <= 0:
        wmax = 1.0

    f_mask = f > 0
    w_mask = w > 0
    inter = f_mask & w_mask

    if inter.any():
        f_in = f[inter] / fmax
        w_in = w[inter] / wmax
        mse_norm = float(np.mean((f_in - w_in) ** 2))
    else:
        mse_norm = float("nan")

    try:
        mi = float(ants.image_mutual_information(fixed, warped))
    except Exception as e:
        print(f"    (mutual_information failed: {e})", flush=True)
        mi = float("nan")

    f_bin = f > (0.05 * fmax)
    w_bin = w > (0.05 * wmax)
    denom = f_bin.sum() + w_bin.sum()
    if denom > 0:
        dice = float(2.0 * (f_bin & w_bin).sum() / denom)
    else:
        dice = float("nan")

    return {
        "mse_normalized":     mse_norm,
        "mutual_information": mi,
        "dice":               dice,
    }

def transform_magnitude(tform_paths: list[str]) -> dict:
    transform = registration_transform(ants, tform_paths, np)
    return {
        "translation_mm": transform["translationMm"],
        "translation_reference": transform["translationReference"],
        "translation_magnitude_mm": transform["translationMagnitudeMm"],
        "rotation_deg": transform["rotationDeg"],
    }

def main() -> bool:
    ap = argparse.ArgumentParser(description="Rigid registration metrics for Compare mode.")
    _ = ap.add_argument(
        "--source",
        "-s",
        type=Path,
        default=None,
        help=f"DICOM root (default: {ENV_DICOM_ROOT})",
    )
    _ = ap.add_argument(
        "slugs",
        nargs="*",
        metavar="SLUG",
        help="Series to include (default: t1_se + all moving); reference is added if any moving is listed",
    )
    args = ap.parse_args()

    source = resolve_dicom_root(args.source)
    if source is None:
        print(
            f"Missing DICOM root. Set {ENV_DICOM_ROOT} or pass --source DIR",
            file=sys.stderr,
        )
        return False

    if args.slugs:
        slugs = set(args.slugs)
        if any(m in slugs for m in MOVING_SLUGS):
            slugs.add(REFERENCE)
        to_load = [s for s in [REFERENCE] + MOVING_SLUGS if s in slugs]
    else:
        to_load = [REFERENCE] + MOVING_SLUGS

    print("Loading brain MR series", flush=True)
    sources = slug_source_map()
    imgs = {}
    for slug in to_load:
        img = load_series(source, slug, sources)
        if img is not None:
            imgs[slug] = img
        else:
            print(f"  [{slug}] FAILED to load", file=sys.stderr, flush=True)

    if REFERENCE not in imgs:
        print(
            f"reference {REFERENCE} failed to load — aborting",
            file=sys.stderr,
        )
        return False

    fixed = imgs[REFERENCE]

    pairs = {}
    runtimes = {}
    print("\nRegistering each moving series to t1_se", flush=True)
    for slug in MOVING_SLUGS:
        if slug not in imgs:
            print(f"  [{slug}] skipped (not loaded)", flush=True)
            pairs[slug] = {"error": "failed to load"}
            continue
        moving = imgs[slug]

        t0 = time.time()
        try:
            reg = ants.registration(
                fixed=fixed,
                moving=moving,
                type_of_transform="Rigid",
                verbose=False,
            )
        except Exception as e:
            print(f"  [{slug}] registration FAILED: {e}", flush=True)
            pairs[slug] = {"error": f"registration failed: {e}"}
            continue
        elapsed = time.time() - t0
        runtimes[slug] = elapsed

        warped = reg["warpedmovout"]
        tform_paths = reg["fwdtransforms"]

        metrics = alignment_metrics(fixed, warped)
        magnitude = transform_magnitude(tform_paths)

        v = "alignment unverified"

        pairs[slug] = {
            "translation_mm":          magnitude["translation_mm"],
            "translation_reference": magnitude["translation_reference"],
            "translation_magnitude_mm": magnitude["translation_magnitude_mm"],
            "rotation_deg":            magnitude["rotation_deg"],
            "mse_normalized":          metrics["mse_normalized"],
            "mutual_information":      metrics["mutual_information"],
            "dice":                    metrics["dice"],
            "verdict":                 v,
            "runtime_seconds":         elapsed,
        }
        print(f"  [{slug:8s}] done in {elapsed:.1f}s  verdict={v}", flush=True)

    out = {
        "reference": REFERENCE,
        "pairs":     pairs,
        "method":    "ANTsPy ants.registration type_of_transform='Rigid' to t1_se",
        "ants_version": ants.__version__,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }

    out_path = DATA / "registration.json"
    _ = out_path.write_text(json.dumps(out, indent=2))
    print(f"\nWrote {out_path}  ({out_path.stat().st_size} bytes)", flush=True)

    print("\nPer-pair summary:")
    for slug in MOVING_SLUGS:
        if slug not in imgs:
            continue
        p = pairs.get(slug, {})
        if "error" in p:
            print(f"  {slug:8s}  ERROR: {p['error']}")
            continue
        print(
            f"  {slug:8s}  "
            + f"translation={p['translation_magnitude_mm']:.2f} mm   "
            + f"rotation={p['rotation_deg']:.2f} deg   "
            + f"dice={p['dice']:.3f}   "
            + f"verdict={p['verdict']}"
        )
    return True

if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
