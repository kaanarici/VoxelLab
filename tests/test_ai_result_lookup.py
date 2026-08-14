from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlparse

import ai_routes


class JsonHandler:
    def __init__(self) -> None:
        self.response: tuple[int, dict] | None = None

    def _json(self, code: int, body: dict) -> None:
        self.response = (code, body)


def lookup(path: str, data_dir: Path) -> tuple[int, dict]:
    handler = JsonHandler()
    handled = ai_routes.handle_ai_get(
        handler,
        urlparse(path),
        data_dir,
        lambda: False,
        lambda _analysis_key=None: {},
    )
    assert handled is True
    assert handler.response is not None
    return handler.response


def test_missing_analysis_result_is_an_empty_success(tmp_path: Path) -> None:
    key = "v2:cccccccccccccccccccccccccccccccc"

    assert lookup(f"/api/analyze/result?analysisKey={key}", tmp_path) == (200, {})


def test_analysis_result_lookup_returns_source_keyed_payload(tmp_path: Path) -> None:
    key = "v2:dddddddddddddddddddddddddddddddd"
    payload = {"analysisKey": key, "slug": "scan", "summary": "cached", "findings": []}
    _ = (tmp_path / ai_routes.analysis_result_filename(key)).write_text(json.dumps(payload))

    assert lookup(f"/api/analyze/result?analysisKey={key}", tmp_path) == (200, payload)


def test_analysis_result_lookup_rejects_invalid_identity(tmp_path: Path) -> None:
    assert lookup("/api/analyze/result?analysisKey=..%2F..%2Fescape", tmp_path) == (
        400,
        {"error": "invalid analysis key"},
    )
