import argparse
import json
import sys
from pathlib import Path
import numpy as np
from json_store import update_manifest_series

DATA = Path(__file__).resolve().parents[1] / "data"
TARGET = 128

def downsample(vol, target_shape):

    D, H, W = vol.shape
    td, th, tw = target_shape

    bd = max(1, D // td)
    bh = max(1, H // th)
    bw = max(1, W // tw)

    vol = vol[:td * bd, :th * bh, :tw * bw]

    return vol.reshape(td, bd, th, bh, tw, bw).mean(axis=(1, 3, 5))

def process(series):
    slug = series["slug"]
    raw_path = DATA / f"{slug}.raw"
    if not raw_path.exists():
        return False

    W, H, D = series["width"], series["height"], series["slices"]
    u16 = np.fromfile(raw_path, dtype=np.uint16)
    if u16.size != W * H * D:
        print(f"  [skip] size mismatch: {u16.size} vs {W*H*D}", file=sys.stderr)
        return False

    vol = u16.reshape(D, H, W).astype(np.float32) / 65535.0

    max_dim = max(D, H, W)
    scale = TARGET / max_dim
    td = max(1, round(D * scale))
    th = max(1, round(H * scale))
    tw = max(1, round(W * scale))

    print(f"  {W}×{H}×{D} → {tw}×{th}×{td}")

    preview = downsample(vol, (td, th, tw))

    preview_u8 = (np.clip(preview, 0, 1) * 255).astype(np.uint8)

    out_path = DATA / f"{slug}_preview.raw"
    _ = out_path.write_bytes(preview_u8.tobytes())
    size_kb = out_path.stat().st_size / 1024
    print(f"  wrote {out_path.name} ({size_kb:.0f} KB)")

    series["hasPreview"] = True
    series["previewDims"] = [tw, th, td]
    return True

def main() -> bool:
    ap = argparse.ArgumentParser(description="Downsample .raw volumes to uint8 previews for fast 3D load.")
    _ = ap.add_argument(
        "slugs",
        nargs="*",
        metavar="SLUG",
        help="Series slugs (default: all with hasRaw)",
    )
    args = ap.parse_args()

    manifest_path = DATA / "manifest.json"
    m = json.loads(manifest_path.read_text())
    requested = set(args.slugs) if args.slugs else set()

    ok = True
    updates = {}
    for s in m["series"]:
        if requested and s["slug"] not in requested:
            continue
        if not s.get("hasRaw"):
            continue
        print(f"\n=== {s['slug']} ===")
        try:
            if process(s):
                updates[s["slug"]] = {"hasPreview": True, "previewDims": s["previewDims"]}
        except Exception as e:
            print(f"  ERROR: {e}", file=sys.stderr)
            ok = False

    _ = update_manifest_series(manifest_path, updates)
    print("\nDone.")
    return ok

if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
