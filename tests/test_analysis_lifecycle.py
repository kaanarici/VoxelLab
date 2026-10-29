from __future__ import annotations

import json
from pathlib import Path
import threading
import types
from urllib.parse import urlparse

import pytest

import ai_routes
import serve

from tests.helpers.python.serve_http import browser_headers, make_handler, token_headers

RUNNING_KEY = "v2:11111111111111111111111111111111"

class FakeProc:
    def __init__(self, lines: list[str] | None = None, exit_code: int = 0):
        self.stdout = iter(lines or ())
        self.exit_code = exit_code
        self.waited = False

    def wait(self) -> int:
        self.waited = True
        return self.exit_code

    def poll(self) -> int:
        return self.exit_code

@pytest.fixture(autouse=True)
def isolated_analysis_state(monkeypatch):
    """`serve.RUNNING` and the rate limit buckets are process-wide state."""
    serve.RUNNING.clear()
    serve.RATE_LIMIT_BUCKETS.clear()
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})
    yield
    serve.RUNNING.clear()
    serve.RATE_LIMIT_BUCKETS.clear()

@pytest.fixture()
def jobs():
    """A private analysis registry with the lock `start_analysis` expects."""
    return {"running": {}, "lock": threading.Lock()}

def start_analysis(root: Path, jobs: dict, *, key: str, slug: str = "scan", now: float = 123.0, slugs=("scan",)):
    return ai_routes.start_analysis(
        root,
        "python",
        types.SimpleNamespace(time=lambda: now),
        slug,
        analysis_key=key,
        force=False,
        slices=None,
        valid_slugs=lambda: set(slugs),
        running=jobs["running"],
        lock=jobs["lock"],
        stream_tail=lambda *_args: None,
    )

def analyze_post(query: str, body: bytes = b"") -> dict:
    handler, captured = make_handler(f"/api/analyze?{query}", headers=token_headers(body), body=body)
    serve.Handler.do_POST(handler)
    return captured

def analyze_status_get(query: str = "") -> dict:
    path = "/api/analyze/status" + (f"?{query}" if query else "")
    handler, captured = make_handler(path, headers=browser_headers())
    serve.Handler.do_GET(handler)
    return captured

def result_lookup(path: str, data_dir: Path) -> tuple[int, dict]:
    class JsonHandler:
        response: tuple[int, dict] | None = None

        def _json(self, code: int, body: dict) -> None:
            self.response = (code, body)

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

def test_analyze_reports_an_unknown_slug_with_its_result_url(monkeypatch) -> None:
    monkeypatch.setattr(serve, "start_analysis", lambda slug, **_kwargs: (400, f"unknown slug: {slug}"))

    captured = analyze_post(f"slug=missing&analysisKey={RUNNING_KEY}")

    assert captured == {"code": 400, "body": {
        "message": "unknown slug: missing",
        "slug": "missing",
        "analysisKey": RUNNING_KEY,
        "resultUrl": "./data/analysis-v2-11111111111111111111111111111111.json",
    }}

def test_analyze_parses_slice_ranges_before_starting_the_job(monkeypatch) -> None:
    key = "v2:22222222222222222222222222222222"
    seen = {}
    monkeypatch.setattr(serve, "series_meta", lambda slug: {"slug": slug, "slices": 5})
    monkeypatch.setattr(
        serve,
        "start_analysis",
        lambda slug, *, analysis_key, force=False, slices=None: seen.update(
            {"slug": slug, "analysis_key": analysis_key, "force": force, "slices": slices}
        ) or (202, "started: scan (force)"),
    )

    captured = analyze_post(f"slug=scan&analysisKey={key}&slices=0,2-3&force=1")

    assert seen == {"slug": "scan", "analysis_key": key, "force": True, "slices": [0, 2, 3]}
    assert captured == {"code": 202, "body": {
        "message": "started: scan (force)",
        "slug": "scan",
        "analysisKey": key,
        "resultUrl": "./data/analysis-v2-22222222222222222222222222222222.json",
    }}

@pytest.mark.parametrize(
    "identity",
    ["", "../../escape", "v2:ABCDEF", "v3:" + "0" * 32],
    ids=["blank", "path-like", "wrong-digest", "unknown-version"],
)
def test_analyze_rejects_an_identity_it_cannot_turn_into_a_result_path(identity: str) -> None:
    assert analyze_post(f"slug=scan&analysisKey={identity}") == {
        "code": 400,
        "body": {"error": "invalid analysis key"},
    }

def test_analyze_rejects_a_malformed_json_body() -> None:
    assert analyze_post("slug=scan", b'{"unexpected":') == {
        "code": 400,
        "body": {"error": "invalid JSON body"},
    }

def test_a_second_request_waits_out_the_first_launch_instead_of_spawning_again(monkeypatch, tmp_path: Path, jobs) -> None:
    first_popen_started = threading.Event()
    release_first_popen = threading.Event()
    popen_calls = []
    first_result = {}

    def fake_popen(cmd, **kwargs):
        call_index = len(popen_calls)
        popen_calls.append((cmd, kwargs))
        if call_index == 0:
            first_popen_started.set()
            assert release_first_popen.wait(2), "timed out releasing first Popen"
        return FakeProc()

    monkeypatch.setattr(ai_routes.subprocess, "Popen", fake_popen)
    first_thread = threading.Thread(
        target=lambda: first_result.update(
            {"value": start_analysis(tmp_path, jobs, key=RUNNING_KEY)},
        ),
    )
    first_thread.start()
    assert first_popen_started.wait(2), "first Popen did not start"

    try:
        second = start_analysis(tmp_path, jobs, key=RUNNING_KEY, now=124.0)

        payload = ai_routes.status_payload(jobs["running"], jobs["lock"])[RUNNING_KEY]
        assert payload["running"] is True
        assert payload["last"] == "starting..."
        assert second == (409, "already running for this source series")
        assert len(popen_calls) == 1
    finally:
        release_first_popen.set()
        first_thread.join(2)

    assert not first_thread.is_alive()
    assert first_result["value"] == (202, "started: scan")

def test_a_failed_spawn_releases_the_launch_reservation(monkeypatch, tmp_path: Path, jobs) -> None:
    monkeypatch.setattr(
        ai_routes.subprocess,
        "Popen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("boom")),
    )

    result = start_analysis(tmp_path, jobs, key="v2:44444444444444444444444444444444")

    assert result == (500, "failed to start analysis: boom")
    assert jobs["running"] == {}

def test_distinct_source_identities_run_concurrently_up_to_the_job_limit(monkeypatch, tmp_path: Path, jobs) -> None:
    launched = []
    monkeypatch.setattr(
        ai_routes.subprocess,
        "Popen",
        lambda cmd, **kwargs: launched.append((cmd, kwargs)) or FakeProc(),
    )
    keys = ["v2:77777777777777777777777777777777", "v2:88888888888888888888888888888888"]

    for key in keys:
        assert start_analysis(tmp_path, jobs, key=key) == (202, "started: scan")

    assert len(launched) == 2
    assert set(jobs["running"]) == set(keys)
    assert all("--analysis-key" in cmd for cmd, _kwargs in launched)
    assert all(cmd[:3] == ["python", "-u", str(tmp_path / "python" / "analyze.py")] for cmd, _kwargs in launched)
    assert all(kwargs["cwd"] == str(tmp_path) for _cmd, kwargs in launched)

    third = start_analysis(tmp_path, jobs, key="v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", now=124.0)

    assert third == (429, "too many analysis jobs are already running")
    assert len(launched) == 2

def test_an_analysis_key_stays_bound_to_the_slug_that_claimed_it(monkeypatch, tmp_path: Path, jobs) -> None:
    launched = []
    monkeypatch.setattr(
        ai_routes.subprocess,
        "Popen",
        lambda cmd, **kwargs: launched.append((cmd, kwargs)) or FakeProc(),
    )
    key = "v2:99999999999999999999999999999999"

    assert start_analysis(tmp_path, jobs, key=key, slugs=("scan", "other")) == (202, "started: scan")
    assert start_analysis(tmp_path, jobs, key=key, slug="other", now=2.0, slugs=("scan", "other")) == (
        409,
        "analysis key is already bound to another slug",
    )
    assert len(launched) == 1
    assert jobs["running"][key]["slug"] == "scan"

def test_status_route_returns_the_running_payload(monkeypatch) -> None:
    monkeypatch.setattr(serve, "status_payload", lambda: {"scan": {"running": True, "last": "working"}})

    assert analyze_status_get() == {"code": 200, "body": {"scan": {"running": True, "last": "working"}}}

def test_status_route_filters_by_the_validated_analysis_key(monkeypatch) -> None:
    key = "v2:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    seen = []
    monkeypatch.setattr(
        serve,
        "status_payload",
        lambda analysis_key=None: seen.append(analysis_key) or {analysis_key: {"running": True, "slug": "scan"}},
    )

    captured = analyze_status_get(f"analysisKey={key}")

    assert seen == [key]
    assert captured == {"code": 200, "body": {key: {"running": True, "slug": "scan"}}}

@pytest.mark.parametrize(
    "query",
    ["analysisKey=", "analysisKey=..%2F..%2Fescape", "analysisKey=v2%3AABCDEF"],
    ids=["blank", "path-like", "wrong-digest"],
)
def test_status_route_rejects_an_invalid_analysis_key(query: str) -> None:
    assert analyze_status_get(query) == {"code": 400, "body": {"error": "invalid analysis key"}}

@pytest.mark.parametrize(
    ("lines", "exit_code", "status", "error"),
    [
        (
            ["working\n", "ERROR: provider offline\n", "later success-looking output\n"],
            2,
            "error",
            "provider offline",
        ),
        (["Done. Refresh the viewer.\n"], 0, "done", None),
    ],
    ids=["failed-run", "successful-run"],
)
def test_a_finished_run_persists_its_terminal_state(lines: list[str], exit_code: int, status: str, error: str | None) -> None:
    key = "v2:55555555555555555555555555555555"
    proc = FakeProc(lines, exit_code)
    serve.RUNNING[key] = serve._analysis_status_entry(
        proc=proc,
        status="running",
        last="starting...",
        analysis_key=key,
        slug="scan",
    )

    serve._stream_tail(proc, key, "scan")

    payload = serve.status_payload()[key]
    assert payload["status"] == status
    assert payload["running"] is False
    assert payload["exitCode"] == exit_code
    if error is None:
        assert payload["error"] is None
    else:
        assert error in payload["error"]

def test_terminal_status_history_is_bounded_without_evicting_live_jobs(jobs) -> None:
    running = jobs["running"]
    for index in range(ai_routes.MAX_TERMINAL_ANALYSIS_STATUS_ENTRIES + 7):
        key = f"v2:{index:032x}"
        running[key] = ai_routes.analysis_status_entry(
            types.SimpleNamespace(time=lambda index=index: float(index)),
            proc=None,
            status="done",
            last=f"done-{index}",
            analysis_key=key,
            slug=f"scan-{index}",
        )
    live_key = "v2:ffffffffffffffffffffffffffffffff"
    running[live_key] = ai_routes.analysis_status_entry(
        types.SimpleNamespace(time=lambda: 999.0),
        proc=object(),
        status="running",
        last="working",
        analysis_key=live_key,
        slug="current-scan",
    )

    payload = ai_routes.status_payload(running, jobs["lock"])

    terminal = [entry for entry in payload.values() if not entry["running"]]
    assert len(terminal) == ai_routes.MAX_TERMINAL_ANALYSIS_STATUS_ENTRIES
    assert payload[live_key]["slug"] == "current-scan"
    assert payload[live_key]["last"] == "working"
    assert "v2:00000000000000000000000000000000" not in payload
    assert f"v2:{ai_routes.MAX_TERMINAL_ANALYSIS_STATUS_ENTRIES + 6:032x}" in payload

    exact = ai_routes.status_payload(running, jobs["lock"], live_key)
    assert list(exact) == [live_key]
    assert exact[live_key]["slug"] == "current-scan"

def test_a_missing_analysis_result_is_an_empty_success(tmp_path: Path) -> None:
    key = "v2:cccccccccccccccccccccccccccccccc"

    assert result_lookup(f"/api/analyze/result?analysisKey={key}", tmp_path) == (200, {})

def test_an_analysis_result_is_returned_from_its_identity_keyed_sidecar(tmp_path: Path) -> None:
    key = "v2:dddddddddddddddddddddddddddddddd"
    payload = {"analysisKey": key, "slug": "scan", "summary": "cached", "findings": []}
    _ = (tmp_path / ai_routes.analysis_result_filename(key)).write_text(json.dumps(payload))

    assert result_lookup(f"/api/analyze/result?analysisKey={key}", tmp_path) == (200, payload)

def test_an_analysis_result_lookup_rejects_a_path_like_identity(tmp_path: Path) -> None:
    assert result_lookup("/api/analyze/result?analysisKey=..%2F..%2Fescape", tmp_path) == (
        400,
        {"error": "invalid analysis key"},
    )
