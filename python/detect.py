import argparse
import json
import sys
from pathlib import Path

import numpy as np
from json_store import update_manifest_series
from PIL import Image
from scipy import ndimage

from geometry import series_effective_slice_spacing

DATA = Path(__file__).resolve().parents[1] / "data"

def load_stack(folder: Path) -> np.ndarray:

    files = sorted(folder.glob("*.png"))
    if not files:
        raise FileNotFoundError(f"no PNGs in {folder}")
    imgs = [np.array(Image.open(f).convert("L")) for f in files]
    return np.stack(imgs, axis=0)

def compute_symmetry(brain: np.ndarray, outdir: Path) -> list[float]:

    D, H, W = brain.shape
    outdir.mkdir(exist_ok=True)
    scores: list[float] = []
    for z in range(D):
        sl = brain[z].astype(np.float32)
        mask = sl > 5
        if mask.sum() < 200:

            Image.fromarray(np.zeros((H, W), dtype=np.uint8)).save(outdir / f"{z:04d}.png")
            scores.append(0.0)
            continue

        xs = np.where(mask)[1]
        cx = int(round(float(xs.mean())))

        shift = W // 2 - cx
        sl_shifted = np.roll(sl, shift, axis=1)
        mask_shifted = np.roll(mask, shift, axis=1)
        mirror = sl_shifted[:, ::-1]
        mask_mirror = mask_shifted[:, ::-1]
        both = mask_shifted & mask_mirror

        diff = np.abs(sl_shifted - mirror)
        diff[~both] = 0.0

        diff = ndimage.gaussian_filter(diff, sigma=1.0)

        diff = np.roll(diff, -shift, axis=1)

        m = float(diff.max())
        disp = np.zeros_like(diff, dtype=np.uint8)
        if m > 1:
            disp = np.clip(diff / m * 255.0, 0, 255).astype(np.uint8)
        Image.fromarray(disp).save(outdir / f"{z:04d}.png")

        scores.append(float(diff[both].mean()) if both.any() else 0.0)

    return scores

def compute_csf_stats(seg: np.ndarray, px: float, py: float, sz: float) -> dict:

    voxel_ml = (px * py * sz) / 1000.0
    csf = seg == 1
    total_voxels = int(csf.sum())

    opened_voxels = 0
    struct = np.ones((3, 3), dtype=bool)
    for z in range(csf.shape[0]):
        sl = csf[z]
        if sl.sum() < 20:
            continue
        eroded = ndimage.binary_erosion(sl, structure=struct, iterations=2)
        if eroded.sum() == 0:
            continue
        lbl, n = ndimage.label(eroded)
        if n == 0:
            continue
        sizes = ndimage.sum(eroded, lbl, range(1, n + 1))
        top = np.sort(sizes)[::-1][:2]
        opened_voxels += int(top.sum())

    return {
        "csfTotalMl":         round(total_voxels * voxel_ml, 1),
        "csfTotalVoxels":     total_voxels,
        "ventricleEstimateMl": round(opened_voxels * voxel_ml, 1),
        "ventricleNote":      "Approx: 2D-opened CSF top blobs per slice. Not a true ventricular segmentation.",
    }

def per_slice_tissue(seg: np.ndarray) -> list[dict]:
    return [
        {
            "csf": int((seg[z] == 1).sum()),
            "gm": int((seg[z] == 2).sum()),
            "wm": int((seg[z] == 3).sum()),
        }
        for z in range(seg.shape[0])
    ]

def process_series(series: dict) -> dict:
    slug = series["slug"]
    print(f"\n=== {slug} ===", flush=True)

    brain_dir = DATA / f"{slug}_brain"
    seg_dir = DATA / f"{slug}_seg"
    if not brain_dir.exists():
        print(f"  skip: no brain folder at {brain_dir}", flush=True)
        return {}

    brain = load_stack(brain_dir)
    print(f"  brain stack: {brain.shape}", flush=True)

    sym_dir = DATA / f"{slug}_sym"
    scores = compute_symmetry(brain, sym_dir)
    print(f"  symmetry: min={min(scores):.2f} max={max(scores):.2f} mean={np.mean(scores):.2f}", flush=True)
    series["hasSym"] = True

    stats = {
        "slug": slug,
        "symmetryScores": [round(s, 3) for s in scores],
    }

    if seg_dir.exists():
        seg = load_stack(seg_dir)
        vv = compute_csf_stats(
            seg,
            series["pixelSpacing"][0],
            series["pixelSpacing"][1],
            series_effective_slice_spacing(series),
        )
        stats.update(vv)
        stats["perSliceTissue"] = per_slice_tissue(seg)
        print(f"  CSF total: {vv['csfTotalMl']} mL   ventricle estimate: {vv['ventricleEstimateMl']} mL", flush=True)

    stats_path = DATA / f"{slug}_stats.json"
    _ = stats_path.write_text(json.dumps(stats))
    print(f"  wrote {stats_path.name}", flush=True)
    series["hasStats"] = True
    return stats

def main() -> bool:
    ap = argparse.ArgumentParser(description="Symmetry heatmaps + CSF/ventricle stats.")
    _ = ap.add_argument(
        "slugs",
        nargs="*",
        metavar="SLUG",
        help="Series slugs (default: all in manifest)",
    )
    args = ap.parse_args()

    path = DATA / "manifest.json"
    m = json.loads(path.read_text())
    requested = set(args.slugs) if args.slugs else set()
    updates = {}
    ok = True
    for s in m["series"]:
        if requested and s["slug"] not in requested:
            continue
        try:
            _ = process_series(s)
            updates[s["slug"]] = {"hasSym": s["hasSym"], "hasStats": s["hasStats"]}
        except Exception as e:
            print(f"  ERROR on {s['slug']}: {e}", file=sys.stderr, flush=True)
            ok = False
    _ = update_manifest_series(path, updates)
    print("\nDone. Refresh the viewer.", flush=True)
    return ok

if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
