import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage
from sklearn.mixture import GaussianMixture

from geometry import affine_lps_from_series, series_effective_slice_spacing
from json_store import update_manifest_series
from pipeline_paths import series_by_modality

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

ATROPOS_TO_VIEWER = np.array([0, 1, 2, 3, 2, 2, 2], dtype=np.uint8)

MIN_ATROPOS_COVERAGE = 0.50

BRIGHT_CSF = {"t2_tse", "dwi_adc"}

def load_brain_stack(slug: str) -> np.ndarray:

    folder = DATA / f"{slug}_brain"
    if not folder.is_dir():
        raise FileNotFoundError(f"no brain stack at {folder}")
    files = sorted(folder.glob("*.png"))
    if not files:
        raise FileNotFoundError(f"no PNGs in {folder}")
    arrs = [np.array(Image.open(f).convert("L"), dtype=np.uint8) for f in files]
    return np.stack(arrs)

def write_nifti(vol_dhw: np.ndarray, series_entry: dict, out_path: Path):

    import nibabel as nib

    px = series_entry["pixelSpacing"]
    row_spacing = float(px[0])
    col_spacing = float(px[1])

    affine_lps_mat = np.array(affine_lps_from_series(series_entry), dtype=np.float64)
    slice_mm = series_effective_slice_spacing(series_entry)

    lps_to_ras = np.diag([-1.0, -1.0, 1.0, 1.0])
    affine = lps_to_ras @ affine_lps_mat

    vol_xyz = np.transpose(vol_dhw, (2, 1, 0))
    img = nib.Nifti1Image(vol_xyz.astype(np.float32), affine)
    nib.save(img, str(out_path))
    return col_spacing, row_spacing, slice_mm

def run_deep_atropos(input_nii: Path, verbose: bool = True) -> tuple[np.ndarray, object, object]:

    import ants
    from antspynet.utilities import deep_atropos

    t1 = ants.image_read(str(input_nii))
    print(f"    ANTs image: {t1.shape}, spacing={t1.spacing}", flush=True)

    result = deep_atropos(
        t1,
        do_preprocessing=True,
        use_spatial_priors=1,
        do_denoising=True,
        verbose=verbose,
    )

    seg_image = result["segmentation_image"]
    seg_array = seg_image.numpy()
    return seg_array, seg_image, t1

def atropos_to_viewer_labels(seg_xyz: np.ndarray) -> np.ndarray:

    seg_clipped = np.clip(seg_xyz, 0, 6).astype(np.int32)
    return ATROPOS_TO_VIEWER[seg_clipped]

def reorient_to_match(seg_array: np.ndarray, seg_image, ref_nii_path: Path,
                      target_shape_dhw: tuple) -> np.ndarray:

    import nibabel as nib
    from nibabel.orientations import io_orientation, ornt_transform, apply_orientation
    from scipy import ndimage

    ref_img = nib.load(str(ref_nii_path))
    ref_ornt = io_orientation(ref_img.affine)

    import ants
    with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        ants.image_write(seg_image, str(tmp_path))
        seg_nib = nib.load(str(tmp_path))
        seg_ornt = io_orientation(seg_nib.affine)
        seg_data = np.asarray(seg_nib.dataobj).astype(np.int32)

        transform = ornt_transform(seg_ornt, ref_ornt)
        seg_data = apply_orientation(seg_data, transform)

        seg_dhw = np.transpose(seg_data, (2, 1, 0))

        if seg_dhw.shape != target_shape_dhw:
            print(f"    resampling {seg_dhw.shape} -> {target_shape_dhw}", flush=True)
            zoom = tuple(t / s for t, s in zip(target_shape_dhw, seg_dhw.shape))
            seg_dhw = ndimage.zoom(seg_dhw, zoom, order=0)
    finally:
        tmp_path.unlink(missing_ok=True)

    return seg_dhw

def segment_gmm_improved(slug: str, brain: np.ndarray) -> np.ndarray:

    print("  fallback: running improved GMM with spatial regularization", flush=True)

    brain_mask = brain > 0
    samples = brain[brain_mask].astype(np.float32).reshape(-1, 1)
    if samples.size < 300:
        raise RuntimeError("too few brain voxels for GMM")

    if samples.size > 200_000:
        rng = np.random.RandomState(0)
        idx = rng.choice(samples.shape[0], 200_000, replace=False)
        fit_samples = samples[idx]
    else:
        fit_samples = samples

    gmm = GaussianMixture(
        n_components=3, random_state=0,
        covariance_type="full", max_iter=200
    )
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

    out = np.zeros_like(brain, dtype=np.uint8)
    out[brain_mask] = relabeled

    struct = ndimage.generate_binary_structure(3, 1)
    for label_val in [1, 2, 3]:
        mask = out == label_val

        opened = ndimage.binary_opening(mask, structure=struct, iterations=1)

        closed = ndimage.binary_closing(opened, structure=struct, iterations=1)

        out[brain_mask & (mask != closed)] = 0

    unlabeled = brain_mask & (out == 0)
    if unlabeled.any():

        for label_val in [1, 2, 3]:
            mask = out == label_val
            if mask.any():
                dilated = ndimage.binary_dilation(
                    mask, structure=struct, iterations=3
                )
                newly_claimed = dilated & unlabeled
                out[newly_claimed] = label_val
                unlabeled = unlabeled & ~newly_claimed

    for label_val in [1, 2, 3]:
        mask = out == label_val
        labeled_arr, n_components = ndimage.label(mask, structure=struct)
        if n_components > 0:
            sizes = ndimage.sum(mask, labeled_arr, range(1, n_components + 1))
            for comp_id, size in enumerate(sizes, start=1):
                if size < 50:
                    out[labeled_arr == comp_id] = 0

    unlabeled = brain_mask & (out == 0)
    if unlabeled.any():

        for _ in range(5):
            if not unlabeled.any():
                break
            for label_val in [1, 2, 3]:
                mask = out == label_val
                dilated = ndimage.binary_dilation(mask, structure=struct, iterations=1)
                newly_claimed = dilated & unlabeled
                out[newly_claimed] = label_val
                unlabeled = unlabeled & ~newly_claimed

    n_brain = brain_mask.sum()
    for lbl, name in [(1, "CSF"), (2, "GM"), (3, "WM")]:
        count = (out == lbl).sum()
        pct = count / max(1, n_brain) * 100
        print(f"  class {lbl} ({name:3s}): {pct:5.1f}% of brain  [GMM+morphology]",
              flush=True)

    return out

def save_seg_stack(slug: str, labels: np.ndarray) -> Path:

    out_dir = DATA / f"{slug}_seg"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir()
    for i, sl in enumerate(labels):
        Image.fromarray(sl.astype(np.uint8), mode="L").save(
            out_dir / f"{i:04d}.png", optimize=True
        )
    return out_dir

def process_series(slug: str, manifest: dict) -> bool:

    print(f"\n=== {slug} (deep_atropos tissue segmentation) ===", flush=True)

    series_entry = next((s for s in manifest["series"] if s["slug"] == slug), None)
    if series_entry is None:
        print(f"  ERROR: {slug} not in manifest", flush=True)
        return False

    brain_dir = DATA / f"{slug}_brain"
    if not brain_dir.exists():
        print(f"  skip: no brain folder at {brain_dir}", flush=True)
        return False

    brain = load_brain_stack(slug)
    D, H, W = brain.shape
    print(f"  loaded {D} slices, {W}x{H}", flush=True)

    use_gmm_fallback = False
    viewer_labels = None

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        input_nii = td / f"{slug}.nii.gz"

        px_x, px_y, slice_mm = write_nifti(
            brain.astype(np.float32), series_entry, input_nii
        )
        print(f"  wrote NIfTI, spacing=({px_x:.2f}, {px_y:.2f}, {slice_mm:.2f}) mm",
              flush=True)

        print("  running deep_atropos...", flush=True)
        try:
            seg_array, seg_image, t1_img = run_deep_atropos(input_nii, verbose=True)

            seg_dhw = reorient_to_match(seg_array, seg_image, input_nii, (D, H, W))

            viewer_labels = atropos_to_viewer_labels(seg_dhw)

            n_brain = int((brain > 0).sum())
            n_labeled = int((viewer_labels > 0).sum())
            coverage = n_labeled / max(1, n_brain)
            print(f"  atropos coverage: {coverage:.1%} of brain voxels", flush=True)

            if coverage < MIN_ATROPOS_COVERAGE:
                print(
                    f"  WARNING: deep_atropos coverage ({coverage:.1%}) below "
                    + f"threshold ({MIN_ATROPOS_COVERAGE:.0%})",
                    flush=True,
                )
                print(f"  This is expected for non-T1 contrasts (T2, DWI).", flush=True)
                use_gmm_fallback = True
            else:

                for lbl, name in [(1, "CSF"), (2, "GM"), (3, "WM")]:
                    count = (viewer_labels == lbl).sum()
                    pct = count / max(1, n_brain) * 100
                    print(f"  class {lbl} ({name:3s}): {pct:5.1f}% of brain  [deep_atropos]",
                          flush=True)

                print("  6-class breakdown:", flush=True)
                for lbl, name in [(1, "CSF"), (2, "cortical GM"), (3, "WM"),
                                   (4, "deep GM"), (5, "brainstem"), (6, "cerebellum")]:
                    count = (seg_dhw == lbl).sum()
                    if count > 0:
                        pct = count / max(1, n_brain) * 100
                        print(f"    atropos {lbl} ({name:12s}): {pct:5.1f}%", flush=True)

        except Exception as e:
            print(f"  deep_atropos failed: {e}", flush=True)
            use_gmm_fallback = True

    if use_gmm_fallback:
        viewer_labels = segment_gmm_improved(slug, brain)

    out_dir = save_seg_stack(slug, viewer_labels)
    print(f"  wrote {D} label slices -> {out_dir}", flush=True)

    series_entry["hasSeg"] = True
    return True

def main() -> bool:
    mr_series = series_by_modality("MR")

    ap = argparse.ArgumentParser(description="ANTs deep_atropos tissue segmentation (+ GMM fallback).")
    _ = ap.add_argument(
        "slugs",
        nargs="*",
        metavar="SLUG",
        help=f"Series to process (default: {' '.join(mr_series) or 'all MR in manifest'})",
    )
    args = ap.parse_args()

    manifest_path = DATA / "manifest.json"
    if not manifest_path.exists():
        print(f"ERROR: manifest not found at {manifest_path}", file=sys.stderr, flush=True)
        return False

    manifest = json.loads(manifest_path.read_text())

    requested = set(args.slugs) if args.slugs else set(mr_series)

    successes = []
    failures = []

    for slug in mr_series:
        if slug not in requested:
            continue
        meta = next((s for s in manifest["series"] if s["slug"] == slug), None)
        if not meta:
            print(f"  unknown slug: {slug}", file=sys.stderr, flush=True)
            continue
        if not meta.get("hasBrain"):
            print(f"  [{slug}] skipped: no brain mask", flush=True)
            continue
        try:
            if process_series(slug, manifest):
                successes.append(slug)
            else:
                failures.append(slug)
        except Exception as e:
            import traceback
            print(f"  ERROR on {slug}: {e}", file=sys.stderr, flush=True)
            traceback.print_exc(file=sys.stderr)
            failures.append(slug)

    updates = {slug: {"hasSeg": True} for slug in successes}
    _ = update_manifest_series(manifest_path, updates)

    print(f"\n=== deep_atropos tissue segmentation summary ===", flush=True)
    print(f"  successes: {successes}", flush=True)
    print(f"  failures:  {failures}", flush=True)

    if failures:
        print(
            f"\n  NOTE: For failed series, the existing GMM segmentation "
            + "in data/<slug>_seg/ is preserved.",
            flush=True,
        )
        return False

    print("\nDone. Refresh the viewer.", flush=True)
    return True

if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
