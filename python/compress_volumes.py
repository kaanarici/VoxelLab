import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ENV_FZSTD_NODE = "VOXELLAB_FZSTD_NODE_PATH"
LEGACY_ENV_FZSTD_NODE = "MRI_VIEWER_FZSTD_NODE_PATH"

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
OUT = ROOT / "data_compressed"

DEFAULT_LEVEL = 19
VERIFY_CHUNK_BYTES = 1024 * 1024

_FZSTD_SKIP_LOGGED = False

def have_zstd() -> bool:
    return shutil.which("zstd") is not None

def zstd_compress(src: Path, dst: Path, level: int) -> None:

    cmd = [
        "zstd",
        f"-{level}",
        "--ultra",
        "-f",
        "-q",
        str(src),
        "-o",
        str(dst),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"zstd failed on {src.name}: {result.stderr}")

def zstd_verify(src: Path, dst: Path) -> None:

    decompress_cmd = ["zstd", "-d", "-c", "-q", str(dst)]
    proc = subprocess.Popen(decompress_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.stdout is None or proc.stderr is None:
        raise RuntimeError("zstd verify failed to open decompressor pipes")
    offset = 0
    try:
        with src.open("rb") as original:
            while True:
                expected = original.read(VERIFY_CHUNK_BYTES)
                actual = proc.stdout.read(VERIFY_CHUNK_BYTES)
                if not expected and not actual:
                    break
                if len(expected) != len(actual):
                    if expected and len(actual) < len(expected):
                        stderr = proc.stderr.read()
                        if proc.wait() != 0:
                            raise RuntimeError(
                                f"zstd verify decompress failed on {dst.name}: "
                                + f"{stderr.decode(errors='replace')}"
                            )
                    else:
                        proc.kill()
                        _ = proc.wait()
                    raise RuntimeError(
                        f"size mismatch after roundtrip: {src.name} "
                        + f"mismatch at offset {offset}"
                    )
                if expected != actual:
                    proc.kill()
                    _ = proc.wait()
                    for index, value in enumerate(expected):
                        if value != actual[index]:
                            raise RuntimeError(
                                f"byte-exact verify FAILED on {src.name}: "
                                + f"first diff at offset {offset + index}"
                            )
                    raise RuntimeError(f"unknown verify failure on {src.name}")
                offset += len(expected)
        stderr = proc.stderr.read()
        if proc.wait() != 0:
            raise RuntimeError(
                f"zstd verify decompress failed on {dst.name}: "
                + f"{stderr.decode(errors='replace')}"
            )
    finally:
        if proc.poll() is None:
            proc.kill()
            _ = proc.wait()

def fzstd_verify(src: Path, dst: Path) -> None:

    node = shutil.which("node")
    global _FZSTD_SKIP_LOGGED
    raw = (os.environ.get(ENV_FZSTD_NODE) or os.environ.get(LEGACY_ENV_FZSTD_NODE) or "").strip()
    fzstd_pkg = Path(raw) if raw else None
    if not fzstd_pkg or not fzstd_pkg.exists():
        if not _FZSTD_SKIP_LOGGED:
            print(
                f"    [warn] fzstd JS check skipped "
                + f"(set {ENV_FZSTD_NODE} to node_modules/fzstd and ensure node is on PATH)",
                file=sys.stderr,
            )
            _FZSTD_SKIP_LOGGED = True
        return
    if not node:
        if not _FZSTD_SKIP_LOGGED:
            print(
                "    [warn] fzstd JS check skipped (node not on PATH)",
                file=sys.stderr,
            )
            _FZSTD_SKIP_LOGGED = True
        return

    req_path = str(fzstd_pkg.resolve()).replace("\\", "\\\\")
    script = (
        "const fs=require('fs');"
        f"const fzstd=require({json.dumps(req_path)});"
        "const c=fs.readFileSync(process.argv[1]);"
        "const o=fzstd.decompress(c);"
        "const orig=fs.readFileSync(process.argv[2]);"
        "if(o.length!==orig.length){console.error('len mismatch',o.length,orig.length);process.exit(2);}"
        "const buf=Buffer.from(o.buffer,o.byteOffset,o.byteLength);"
        "for(let i=0;i<orig.length;i++){if(orig[i]!==buf[i]){console.error('diff at',i);process.exit(3);}}"
        "console.log('OK');"
    )
    result = subprocess.run(
        [node, "-e", script, str(dst), str(src)],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"fzstd verify FAILED on {src.name}: "
            + f"{result.stderr.strip() or result.stdout.strip()}"
        )

def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def main() -> bool:
    ap = argparse.ArgumentParser(description="Compress data/*.raw volumes with zstd for R2 upload.")
    _ = ap.add_argument(
        "slugs",
        nargs="*",
        metavar="SLUG",
        help="Volume stem names (e.g. flair, ct_1); default: all .raw in data/",
    )
    _ = ap.add_argument(
        "--level",
        type=int,
        default=DEFAULT_LEVEL,
        metavar="N",
        help=f"zstd level (default: {DEFAULT_LEVEL})",
    )
    args = ap.parse_args()
    level = args.level

    if not have_zstd():
        print("ERROR: zstd CLI not found on PATH. Install it first:", file=sys.stderr)
        print("  brew install zstd", file=sys.stderr)
        return False

    OUT.mkdir(exist_ok=True)

    raw_files = sorted(p for p in DATA.glob("*.raw") if not p.stem.endswith("_mask"))
    if args.slugs:
        wanted = set(args.slugs)
        raw_files = [p for p in raw_files if p.stem in wanted or p.name in wanted]
    if not raw_files:
        print("no .raw files found — nothing to do")
        return True

    index: dict[str, dict] = {}
    total_src = 0
    total_dst = 0
    ok = True
    print(f"compressing {len(raw_files)} volumes at zstd level {level} ...")
    for src in raw_files:
        dst = OUT / f"{src.name}.zst"
        try:
            zstd_compress(src, dst, level)

            zstd_verify(src, dst)
            fzstd_verify(src, dst)
        except Exception as e:
            print(f"ERROR: {src.name}: {e}", file=sys.stderr)
            ok = False
            continue
        src_sz = src.stat().st_size
        dst_sz = dst.stat().st_size
        ratio = src_sz / dst_sz if dst_sz else 0
        total_src += src_sz
        total_dst += dst_sz

        key = src.stem
        index[key] = {
            "source": src.name,
            "compressed": dst.name,
            "src_bytes": src_sz,
            "zst_bytes": dst_sz,
            "sha256_src": sha256_of(src),
            "sha256_zst": sha256_of(dst),
        }
        print(
            f"  {src.name:30s}  {src_sz / 1024 / 1024:6.1f} MB → "
            + f"{dst_sz / 1024 / 1024:6.1f} MB  ({ratio:.1f}×)"
        )

    index_path = OUT / "index.json"
    _ = index_path.write_text(json.dumps(index, indent=2, sort_keys=True))
    print(
        f"\ntotal: {total_src / 1024 / 1024:.1f} MB → "
        + f"{total_dst / 1024 / 1024:.1f} MB  "
        + f"({total_src / total_dst:.2f}× overall)"
    )
    print(f"wrote {index_path}")
    return ok

if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
