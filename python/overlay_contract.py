"""Canonical overlay loader-dir contract. Keep in lockstep with schemas/overlay-contract.json."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

_OVERLAY = json.loads((Path(__file__).resolve().parent.parent / "schemas" / "overlay-contract.json").read_text())


def dump_overlay_contract() -> dict[str, Any]:
    return copy.deepcopy(_OVERLAY)
