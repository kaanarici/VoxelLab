import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from sklearn.mixture import GaussianMixture

from json_store import update_json

DATA = Path(__file__).resolve().parents[1] / "data"

BRIGHT_CSF = {"t2_tse", "dwi_adc"}

def load_brain_stack(slug: str) -> np.ndarray:
    folder = DATA / f"{slug}_brain"
    if not folder.is_dir():
        raise FileNotFoundError(f"no brain stack at {folder} — run brain_extract.py first")
    files = sorted(folder.glob("*.png"))
    arrs = [np.array(Image.open(f), dtype=np.uint8) for f in files]
    return np.stack(arrs)

def segment(slug: str, stack: np.ndarray) -> np.ndarray:

    brain_mask = stack > 0
    samples = stack[brain_mask].astype(np.float32).reshape(-1, 1)
    if samples.size < 300:
        raise RuntimeError("too few brain voxels — is the brain mask correct?")

    if samples.size > 200_000:
        idx = np.random.RandomState(0).choice(samples.shape[0], 200_000, replace=False)
        fit_samples = samples[idx]
    else:
        fit_samples = samples

    gmm = GaussianMixture(n_components=3, random_state=0, covariance_type="full", max_iter=200)
    _ = gmm.fit(fit_samples)

    predictions = gmm.predict(samples)

    means = gmm.means_.flatten()
    order = np.argsort(means)
    if slug in BRIGHT_CSF:

        order = order[::-1]
    remap = np.zeros(3, dtype=np.int32)
    for out_label, comp in enumerate(order):
        remap[comp] = out_label + 1

    relabeled = remap[predictions]

    out = np.zeros_like(stack, dtype=np.uint8)
    out[brain_mask] = relabeled
    return out

def save_seg_stack(slug: str, labels: np.ndarray):
    out_dir = DATA / f"{slug}_seg"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir()

    for i, sl in enumerate(labels):
        Image.fromarray(sl, mode="L").save(out_dir / f"{i:04d}.png", optimize=True)
    return out_dir

def process(slug: str):
    print(f"\n=== {slug} ===")
    stack = load_brain_stack(slug)
    labels = segment(slug, stack)

    n_brain = (stack > 0).sum()
    for lbl, name in [(1, "CSF/low"), (2, "GM/mid"), (3, "WM/high")]:
        pct = (labels == lbl).sum() / max(1, n_brain) * 100
        print(f"  class {lbl} ({name:8s}): {pct:5.1f}% of brain")

    out_dir = save_seg_stack(slug, labels)
    print(f"  wrote {labels.shape[0]} label slices → {out_dir}")

def update_manifest(slugs):
    path = DATA / "manifest.json"

    def mark_segmented(manifest: dict) -> dict:
        for series in manifest["series"]:
            if series["slug"] in slugs:
                series["hasSeg"] = True
        return manifest

    _ = update_json(path, mark_segmented)

def main() -> bool:
    ap = argparse.ArgumentParser(description="GMM tissue segmentation (3-class) from brain PNGs.")
    _ = ap.add_argument(
        "slugs",
        nargs="*",
        metavar="SLUG",
        help="Series slugs (default: all in manifest)",
    )
    args = ap.parse_args()

    m = json.loads((DATA / "manifest.json").read_text())
    requested = args.slugs or [s["slug"] for s in m["series"]]

    ok = []
    success = True
    for slug in requested:
        meta = next((s for s in m["series"] if s["slug"] == slug), None)
        if not meta:
            print(f"unknown slug: {slug}", file=sys.stderr)
            success = False
            continue
        if not meta.get("hasBrain"):
            print(f"[{slug}] skipped: no brain mask (run brain_extract.py first)", file=sys.stderr)
            success = False
            continue
        try:
            process(slug)
            ok.append(slug)
        except Exception as e:
            print(f"[{slug}] ERROR: {e}", file=sys.stderr)
            success = False

    update_manifest(ok)
    print("\nDone. Refresh the viewer and click Segment.")
    return success

if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
