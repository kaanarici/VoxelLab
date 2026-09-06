from __future__ import annotations

import json
import os
import re
from pathlib import Path

ENV_DICOM_ROOT = "MRI_VIEWER_DICOM_ROOT"
DATA = Path(__file__).resolve().parents[1] / "data"

SKIP_NAMES = {".DS_Store", "Thumbs.db", "DICOMDIR"}
SKIP_TREE_NAMES = {*SKIP_NAMES, "__MACOSX"}

def resolve_dicom_root(cli_path: Path | None) -> Path | None:

    if cli_path is not None:
        p = cli_path.expanduser().resolve()
        return p if p.is_dir() else None
    env = os.environ.get(ENV_DICOM_ROOT)
    if env:
        p = Path(env).expanduser().resolve()
        return p if p.is_dir() else None
    return None

def slugify(text: str) -> str:

    s = text.lower().strip()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = s.strip("_")
    return s or "unknown"

def is_skipped_path(path: Path, root: Path) -> bool:
    return any(part in SKIP_TREE_NAMES or part.startswith(".") for part in path.relative_to(root).parts)

def candidate_dicom_files(folder: Path) -> list[Path]:

    return sorted(
        path for path in folder.iterdir()
        if path.is_file()
        and not is_skipped_path(path, folder)
        and path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".txt", ".json"}
    )

def load_manifest(data_dir: Path | None = None, *, allow_empty: bool = False) -> dict:

    path = (data_dir or DATA) / "manifest.json"
    if not path.exists():
        if allow_empty:
            return {"patient": "anonymous", "studyDate": "", "series": []}
        raise RuntimeError(f"manifest.json is missing ({path})")
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"manifest.json is malformed ({path}): {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("series"), list):
        raise RuntimeError(f"manifest.json has invalid series data ({path})")
    return data

def slug_source_map(data_dir: Path | None = None) -> dict[str, str]:

    m = load_manifest(data_dir)
    return {
        s["slug"]: s["sourceFolder"]
        for s in m.get("series", [])
        if s.get("sourceFolder")
    }

def series_by_modality(modality: str, data_dir: Path | None = None) -> list[str]:

    m = load_manifest(data_dir)
    return [s["slug"] for s in m.get("series", []) if s.get("modality") == modality]
