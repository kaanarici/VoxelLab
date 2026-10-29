from __future__ import annotations

import json
from pathlib import Path

import pytest

import ai_routes
import serve

from tests.helpers.python.serve_http import browser_headers, make_handler, token_headers

LOCAL_IMAGE = {
    "dataUrl": "data:image/jpeg;base64,/9j/2Q==",
    "width": 512,
    "height": 512,
    "name": "Local fixture",
    "modality": "MR",
}

@pytest.fixture(autouse=True)
def ai_ready(monkeypatch):
    """The AI routes only run once the provider reports ready."""
    monkeypatch.setattr(serve, "runtime_config", lambda: {"ai": {"enabled": True, "ready": True}})
    serve.RATE_LIMIT_BUCKETS.clear()
    yield
    serve.RATE_LIMIT_BUCKETS.clear()

def ask_post(payload: dict, path: str = "/api/ask") -> tuple[serve.Handler, dict]:
    body = json.dumps(payload).encode()
    handler, captured = make_handler(path, headers=token_headers(body), body=body)
    serve.Handler.do_POST(handler)
    return handler, captured

def test_ai_post_guard_refuses_a_disabled_assistant() -> None:
    code, body = serve.ai_post_guard({"ai": {"enabled": False}})

    assert code == 503
    assert "disabled" in body["error"].lower()

def test_ai_post_guard_reports_why_a_provider_is_not_ready() -> None:
    code, body = serve.ai_post_guard({
        "ai": {"enabled": True, "ready": False, "provider": "codex", "issues": ["config broken"]},
    })

    assert code == 503
    assert body["provider"] == "codex"
    assert "config broken" in body["error"]

def test_ask_payload_accepts_an_image_for_a_browser_local_study() -> None:
    parsed, invalid = ai_routes.validate_ask_payload({
        "slug": "local_fixture_1",
        "slice": 0,
        "question": "What is visible?",
        "localImage": LOCAL_IMAGE,
    }, set())

    assert invalid is None
    assert parsed["local_image"]["width"] == 512

def test_ask_payload_keeps_an_unknown_server_side_slug_closed() -> None:
    _parsed, invalid = ai_routes.validate_ask_payload({
        "slug": "missing",
        "slice": 0,
        "question": "What is visible?",
        "localImage": LOCAL_IMAGE,
    }, set())

    assert invalid == (400, {"error": "unknown slug: missing"})

@pytest.mark.parametrize("path", ["/api/ask", "/api/ask/stream"])
@pytest.mark.parametrize("location", [{}, {"x": 1, "y": 2}, {"region": {"x0": 1, "y0": 2, "x1": 5, "y1": 6}}])
@pytest.mark.parametrize("provider", [None, "claude", "codex"])
@pytest.mark.parametrize("local", [False, True])
def test_ask_forwards_every_supported_payload_shape(monkeypatch, path, location, provider, local) -> None:
    slug = "local_fixture_1" if local else "scan"
    payload = {"slug": slug, "slice": 4, "question": "what is this?", "provider": provider, **location}
    if provider:
        payload["model"] = "fixture-model"
    if local:
        payload["viewerContext"] = "Current slice only."
        payload["localImage"] = {"dataUrl": "data:image/jpeg;base64,/9j/2Q==", "width": 512, "height": 256}
    body = json.dumps(payload).encode()
    handler, captured = make_handler(path, headers=token_headers(body), body=body)
    rate_limit_paths = []
    response_headers = {}
    handler._enforce_rate_limit = lambda path: rate_limit_paths.append(path)
    handler.send_response = lambda code: captured.update(code=code)
    handler.send_header = lambda key, value: response_headers.update({key: value})
    handler.end_headers = lambda: None
    monkeypatch.setattr(serve, "valid_slugs", lambda: {"scan"})
    seen = {}
    result = {"cached": False, "key": "fixture", "slice": 4, "x": 1, "y": 2,
              "question": "what is this?", "answer": "ok", "crop": "fixture.jpg"}

    class FakeAsk:
        @staticmethod
        def ask(slug, slice_idx, question, *, x=None, y=None, region=None, provider=None,
                model=None, viewer_context=None, local_image=None, on_event=None):
            seen.update(slug=slug, slice_idx=slice_idx, question=question, x=x, y=y,
                        region=region, provider=provider, model=model,
                        viewer_context=viewer_context, local_image=local_image)
            if on_event:
                on_event({"type": "delta", "text": "ok"})
            return result

    monkeypatch.setattr(serve, "_lazy_ask", lambda: FakeAsk)

    serve.Handler.do_POST(handler)

    assert rate_limit_paths == ["/api/ask"]
    assert seen == {
        "slug": slug,
        "slice_idx": 4,
        "question": "what is this?",
        "x": location.get("x"),
        "y": location.get("y"),
        "region": (1, 2, 5, 6) if "region" in location else None,
        "provider": provider,
        "model": "fixture-model" if provider else None,
        "viewer_context": "Current slice only." if local else None,
        "local_image": {"data_url": "data:image/jpeg;base64,/9j/2Q==", "width": 512,
                        "height": 256, "name": slug, "modality": ""} if local else None,
    }
    if path == "/api/ask":
        assert captured == {"code": 200, "body": result}
    else:
        assert captured == {"code": 200}
        assert response_headers["Content-Type"] == "text/event-stream"
        events = [json.loads(line.removeprefix("data: "))
                  for line in handler.wfile.getvalue().decode().splitlines() if line]
        assert events == [ai_routes.version_ask_event(event) for event in [
            {"type": "delta", "text": "ok"}, {"type": "result", "result": result}, {"type": "done"},
        ]]

@pytest.mark.parametrize(
    ("payload", "error"),
    [
        (
            {"slug": "scan", "slice": 0, "question": "   ", "x": 1, "y": 2},
            "empty question",
        ),
        (
            {"slug": "scan", "slice": -1, "question": "what is this?", "x": 1, "y": 2},
            "slice must be a non-negative integer",
        ),
        (
            {
                "slug": "scan",
                "slice": 4,
                "question": "what is this?",
                "x": 1,
                "y": 2,
                "region": {"x0": 1, "y0": 2, "x1": 5, "y1": 6},
            },
            "give at most one location: {x, y} OR {region:{x0,y0,x1,y1}}, or neither to ask about the whole study",
        ),
        (
            {"slug": "scan", "slice": 4, "question": "what is this?", "region": {"x0": 5, "y0": 2, "x1": 1, "y1": 6}},
            "region coordinates must define a non-empty top-left to bottom-right box",
        ),
    ],
    ids=["empty-question", "negative-slice", "point-and-region", "inverted-region"],
)
def test_ask_rejects_unusable_requests(monkeypatch, payload: dict, error: str) -> None:
    monkeypatch.setattr(serve, "valid_slugs", lambda: {"scan"})
    monkeypatch.setattr(
        serve,
        "_lazy_ask",
        lambda: (_ for _ in ()).throw(AssertionError("the provider must not be called")),
    )

    _handler, captured = ask_post(payload)

    assert captured == {"code": 400, "body": {"error": error}}

def test_ask_rejects_a_malformed_json_body() -> None:
    body = b'{"slug":'
    handler, captured = make_handler("/api/ask", headers=token_headers(body), body=body)

    serve.Handler.do_POST(handler)

    assert captured == {"code": 400, "body": {"error": "invalid JSON body"}}

def test_consult_returns_the_cached_result(monkeypatch, tmp_path: Path) -> None:
    consult = {
        "disclaimer": "Research use only.",
        "provider": "claude",
        "model": "opus",
        "impression": "Stable.",
        "ask_radiologist": [],
        "limitations": "None.",
    }
    _ = (tmp_path / "consult.json").write_text(json.dumps(consult))
    handler, captured = make_handler("/api/consult", headers=browser_headers())
    monkeypatch.setattr(serve, "DATA", tmp_path)

    serve.Handler.do_GET(handler)

    assert captured == {"code": 200, "body": {"cached": True, **consult}}

def test_consult_reports_an_invalid_cache_with_a_regeneration_path(monkeypatch, tmp_path: Path) -> None:
    _ = (tmp_path / "consult.json").write_text("[1,2,3]")
    handler, captured = make_handler("/api/consult", headers=browser_headers())
    monkeypatch.setattr(serve, "DATA", tmp_path)

    serve.Handler.do_GET(handler)

    assert captured["code"] == 409
    assert captured["body"]["error"] == "consult cache is invalid"
    assert captured["body"]["regeneratePath"] == "/api/consult?force=1"

def test_consult_forwards_the_force_flag_to_the_provider(monkeypatch) -> None:
    handler, captured = make_handler("/api/consult?force=1", headers=browser_headers())
    monkeypatch.setattr(serve, "consult_ready", lambda: True)
    seen = {}

    class FakeAsk:
        @staticmethod
        def consult(force=False):
            seen["force"] = force
            return {"impression": "ok", "ask_radiologist": [], "limitations": ""}

    monkeypatch.setattr(serve, "_lazy_ask", lambda: FakeAsk)

    serve.Handler.do_POST(handler)

    assert seen == {"force": True}
    assert captured == {"code": 200, "body": {"impression": "ok", "ask_radiologist": [], "limitations": ""}}

def test_consult_refuses_to_run_without_analysis_data(monkeypatch) -> None:
    handler, captured = make_handler("/api/consult", headers=browser_headers())
    monkeypatch.setattr(serve, "consult_ready", lambda: False)

    serve.Handler.do_POST(handler)

    assert captured == {
        "code": 400,
        "body": {"error": "no analysis data to consult on — run analyze.py first"},
    }

def test_model_catalog_route_returns_the_cli_catalog(monkeypatch) -> None:
    catalog = {
        "models": [{"key": "claude:opus", "provider": "claude", "model": "opus", "label": "Opus", "group": "Claude Code"}],
        "providers": [{
            "provider": "claude",
            "ready": True,
            "issues": [],
            "catalog": {
                "status": "ready",
                "source": "claude_help",
                "issues": [],
                "model_count": 1,
                "timeout_seconds": 8,
            },
        }],
    }
    handler, captured = make_handler("/api/ai/models", headers=browser_headers())
    monkeypatch.setattr(ai_routes, "list_cli_models", lambda: catalog)

    serve.Handler.do_GET(handler)

    assert captured == {"code": 200, "body": catalog}
