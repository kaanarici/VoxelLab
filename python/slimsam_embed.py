import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

_MISSING: list[str] = []
np = None
torch = None
Image = None
sam_model_registry = None
SamPredictor = None

try:
    import numpy as np
except ImportError:
    _MISSING.append("numpy")

try:
    import torch
except ImportError:
    _MISSING.append("torch")

try:
    from PIL import Image
except ImportError:
    _MISSING.append("Pillow")

try:
    from segment_anything import sam_model_registry, SamPredictor
except ImportError:
    _MISSING.append("segment-anything")

def _deps_ok() -> bool:
    if not _MISSING:
        return True
    print(
        "ERROR: missing required packages:\n"
        + f"  {', '.join(_MISSING)}\n\n"
        + "Install them with:\n"
        + "  pip install segment-anything torch torchvision Pillow numpy\n\n"
        + "The segment-anything package is Meta's official SAM library:\n"
        + "  https://github.com/facebookresearch/segment-anything",
        file=sys.stderr,
    )
    return False

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
MANIFEST = DATA / "manifest.json"

MEDSAM_HF_REPO = "flaviagiammarino/medsam-vit-b"
MEDSAM_HF_FILE = "pytorch_model.bin"

SAM_VIT_B_URL = (
    "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth"
)
SAM_VIT_B_LOCAL = ROOT / "sam_vit_b_01ec64.pth"

def _download_medsam_checkpoint() -> Path | None:

    try:
        from huggingface_hub import hf_hub_download
        path = hf_hub_download(
            repo_id=MEDSAM_HF_REPO,
            filename=MEDSAM_HF_FILE,
        )
        return Path(path)
    except Exception as e:
        print(f"  [info] could not download MedSAM from HuggingFace: {e}")
        return None

def _download_sam_vit_b() -> Path | None:

    if SAM_VIT_B_LOCAL.exists():
        return SAM_VIT_B_LOCAL
    print(f"  downloading SAM ViT-B from {SAM_VIT_B_URL} ...")
    try:
        import urllib.request
        _ = urllib.request.urlretrieve(SAM_VIT_B_URL, SAM_VIT_B_LOCAL)
        return SAM_VIT_B_LOCAL
    except Exception as e:
        print(f"  [error] failed to download SAM ViT-B: {e}")
        return None

def load_model():

    assert torch is not None
    assert sam_model_registry is not None
    assert SamPredictor is not None
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"  device: {device}")

    ckpt = _download_medsam_checkpoint()
    if ckpt is not None:
        print(f"  loading MedSAM ViT-B from {ckpt}")
        sam = sam_model_registry["vit_b"](checkpoint=str(ckpt))
        sam.to(device)
        sam.eval()
        return SamPredictor(sam)

    print("  [warn] MedSAM unavailable — falling back to standard SAM ViT-B")
    ckpt = _download_sam_vit_b()
    if ckpt is None:
        print(
            "ERROR: could not obtain any SAM checkpoint.\n"
            + "Install huggingface_hub for MedSAM:\n"
            + "  pip install huggingface_hub\n"
            + "Or manually download SAM ViT-B to:\n"
            + f"  {SAM_VIT_B_LOCAL}",
            file=sys.stderr,
        )
        return None
    sam = sam_model_registry["vit_b"](checkpoint=str(ckpt))
    sam.to(device)
    sam.eval()
    return SamPredictor(sam)

def load_slice_pngs(slug: str) -> list[Path]:

    folder = DATA / slug
    if not folder.is_dir():
        return []
    return sorted(folder.glob("*.png"))

def compute_embeddings(
    predictor: Any,
    pngs: list[Path],
    every_n: int = 1,
) -> tuple[Any, int, int]:

    assert np is not None
    assert Image is not None
    assert torch is not None

    img0 = np.array(Image.open(pngs[0]).convert("RGB"))
    width, height = img0.shape[1], img0.shape[0]

    with torch.no_grad():
        predictor.set_image(img0)
        sample = predictor.get_image_embedding().cpu().numpy()

    _, C, H_e, W_e = sample.shape

    embeddings = np.zeros((len(pngs), C, H_e, W_e), dtype=np.float16)
    embeddings[0] = sample.astype(np.float16)

    for i in range(1, len(pngs)):
        if every_n > 1 and i % every_n != 0:

            continue
        img = np.array(Image.open(pngs[i]).convert("RGB"))
        with torch.no_grad():
            predictor.set_image(img)
            emb = predictor.get_image_embedding().cpu().numpy()
        embeddings[i] = emb.astype(np.float16)
        if (i + 1) % 5 == 0 or i == len(pngs) - 1:
            print(f"    slice {i + 1}/{len(pngs)}")

    return embeddings, width, height

def write_outputs(
    slug: str,
    embeddings: Any,
    width: int,
    height: int,
    skip_compress: bool,
) -> None:

    assert np is not None
    num_slices, C, H_e, W_e = embeddings.shape
    stride = C * H_e * W_e * 2

    bin_path = DATA / f"{slug}_sam_embed.bin"
    meta_path = DATA / f"{slug}_sam_meta.json"

    embeddings.tofile(bin_path)
    total_bytes = bin_path.stat().st_size
    print(f"    wrote {bin_path.name}  ({total_bytes / 1024 / 1024:.1f} MB)")

    meta = {
        "slug": slug,
        "slices": num_slices,
        "embed_dim": int(C),
        "embed_h": int(H_e),
        "embed_w": int(W_e),
        "dtype": "float16",
        "stride": stride,
        "bytes_per_slice": stride,
        "total_bytes": total_bytes,
        "width": width,
        "height": height,
    }
    _ = meta_path.write_text(json.dumps(meta, indent=2))
    print(f"    wrote {meta_path.name}")

    if not skip_compress and shutil.which("zstd"):
        zst_path = DATA / f"{slug}_sam_embed.bin.zst"
        cmd = [
            "zstd", "-19", "--ultra", "-f", "-q",
            str(bin_path), "-o", str(zst_path),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            zst_bytes = zst_path.stat().st_size
            ratio = total_bytes / zst_bytes if zst_bytes else 0
            print(
                f"    wrote {zst_path.name}  "
                + f"({zst_bytes / 1024 / 1024:.1f} MB, {ratio:.1f}x)"
            )
        else:
            print(f"    [warn] zstd compression failed: {result.stderr}")
    elif not skip_compress:
        print("    [info] zstd not on PATH — skipping compression")

def main() -> bool:
    if not _deps_ok():
        return False

    args = sys.argv[1:]

    every_n = 1
    skip_compress = False
    slugs: list[str] = []

    i = 0
    while i < len(args):
        if args[i] == "--every" and i + 1 < len(args):
            every_n = max(1, int(args[i + 1]))
            i += 2
        elif args[i] == "--skip-compress":
            skip_compress = True
            i += 1
        elif args[i].startswith("-"):
            print(f"unknown flag: {args[i]}", file=sys.stderr)
            return False
        else:
            slugs.append(args[i])
            i += 1

    if not MANIFEST.exists():
        print(f"ERROR: manifest not found at {MANIFEST}", file=sys.stderr)
        return False
    manifest = json.loads(MANIFEST.read_text())
    all_series = manifest.get("series", [])
    if not all_series:
        print("manifest has no series — nothing to do")
        return True

    if slugs:
        wanted = set(slugs)
        series_list = [s for s in all_series if s["slug"] in wanted]
        missing = wanted - {s["slug"] for s in series_list}
        if missing:
            print(f"[warn] slugs not found in manifest: {missing}", file=sys.stderr)
    else:
        series_list = all_series

    if not series_list:
        print("no matching series — nothing to do")
        return True

    print("loading SAM model ...")
    t0 = time.time()
    predictor = load_model()
    if predictor is None:
        return False
    print(f"  model loaded in {time.time() - t0:.1f}s")

    ok = 0
    fail = 0
    for series in series_list:
        slug = series["slug"]
        print(f"\n--- {slug} ---")
        pngs = load_slice_pngs(slug)
        if not pngs:
            print(f"  [skip] no PNGs in data/{slug}/")
            continue

        try:
            t1 = time.time()
            embeddings, w, h = compute_embeddings(predictor, pngs, every_n)
            elapsed = time.time() - t1
            print(f"  encoded {embeddings.shape[0]} slices in {elapsed:.1f}s")
            write_outputs(slug, embeddings, w, h, skip_compress)
            ok += 1
        except Exception as e:
            print(f"  [ERROR] {slug} failed: {e}", file=sys.stderr)
            fail += 1

    print(f"\ndone: {ok} succeeded, {fail} failed")
    return fail == 0

if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
