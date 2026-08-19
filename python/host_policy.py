"""Static-asset allowlist and CSP from schemas/host-policy.json."""

from __future__ import annotations

import json
from pathlib import Path

_POLICY = json.loads((Path(__file__).resolve().parent.parent / "schemas" / "host-policy.json").read_text())

STATIC_ROOT_FILES = frozenset(_POLICY["staticRootFiles"])
STATIC_ROOT_DIRECTORIES = tuple(_POLICY["staticRootDirectories"])
STATIC_PACKAGE_PATHS = tuple(_POLICY["staticPackagePaths"])


def content_security_policy(variant: str = "browser") -> str:
    directives = list(_POLICY["csp"]["shared"])
    directives.extend(_POLICY["csp"][variant])
    return "; ".join(directives)
