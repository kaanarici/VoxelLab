from __future__ import annotations

import json
import subprocess
import threading
import traceback
from pathlib import Path


RUNNING: dict = {}
LOCK = threading.Lock()


def lazy_ask():
    import ask as ask_mod
    return ask_mod


def valid_slugs(data_dir: Path) -> set[str]:
    try:
        m = json.loads((data_dir / "manifest.json").read_text())
        return {s["slug"] for s in m.get("series", [])}
    except Exception:
        return set()


def validate_ask_payload(body, known_slugs: set[str]) -> tuple[dict, tuple[int, dict] | None]:
    if not isinstance(body, dict):
        return {}, (400, {"error": "expected JSON object body"})
    try:
        slug = str(body["slug"])
        slice_idx = int(body["slice"])
        question = str(body["question"]).strip()
    except (KeyError, ValueError, TypeError):
        return {}, (400, {"error": "expected body {slug, slice, question} and either {x, y} or {region:{x0,y0,x1,y1}}"})

    has_region = body.get("region") is not None
    has_point = body.get("x") is not None or body.get("y") is not None
    if has_region and has_point:
        return {}, (400, {"error": "give at most one location: {x, y} OR {region:{x0,y0,x1,y1}}, or neither to ask about the whole study"})

    parsed = {
        "slug": slug,
        "slice_idx": slice_idx,
        "question": question,
        "x": None,
        "y": None,
        "region": None,
        "viewer_context": "",
    }

    if has_region:
        try:
            reg = body["region"]
            x0 = int(reg["x0"])
            y0 = int(reg["y0"])
            x1 = int(reg["x1"])
            y1 = int(reg["y1"])
        except (KeyError, ValueError, TypeError):
            return {}, (400, {"error": "expected body {slug, slice, question} and either {x, y} or {region:{x0,y0,x1,y1}}"})
        if min(x0, y0, x1, y1) < 0:
            return {}, (400, {"error": "region coordinates must be non-negative integers"})
        if x1 < x0 or y1 < y0:
            return {}, (400, {"error": "region coordinates must define a non-empty top-left to bottom-right box"})
        parsed["region"] = (x0, y0, x1, y1)
    elif has_point:
        try:
            x = int(body["x"])
            y = int(body["y"])
        except (KeyError, ValueError, TypeError):
            return {}, (400, {"error": "expected body {slug, slice, question} and either {x, y} or {region:{x0,y0,x1,y1}}"})
        parsed["x"] = x
        parsed["y"] = y
    # else: neither location → study-scope question (x/y/region stay None)

    if slug not in known_slugs:
        return {}, (400, {"error": f"unknown slug: {slug}"})
    if slice_idx < 0:
        return {}, (400, {"error": "slice must be a non-negative integer"})
    if not question:
        return {}, (400, {"error": "empty question"})
    if len(question) > 2000:
        return {}, (400, {"error": "question too long (max 2000 chars)"})
    viewer_context = body.get("viewerContext", "")
    if viewer_context is not None and not isinstance(viewer_context, str):
        return {}, (400, {"error": "viewerContext must be a string"})
    viewer_context = str(viewer_context or "").strip()
    if len(viewer_context) > 8000:
        return {}, (400, {"error": "viewerContext too long (max 8000 chars)"})
    parsed["viewer_context"] = viewer_context
    provider = body.get("provider")
    if provider is not None and provider not in ("claude", "codex"):
        return {}, (400, {"error": "provider must be 'claude' or 'codex'"})
    model = body.get("model")
    if model is not None and (not isinstance(model, str) or len(model) > 64):
        return {}, (400, {"error": "invalid model"})
    parsed["provider"] = provider
    parsed["model"] = model if isinstance(model, str) and model else None
    return parsed, None


def analysis_status_entry(
    time_module,
    *,
    proc: subprocess.Popen | None,
    status: str,
    last: str,
    exit_code: int | None = None,
    error: str | None = None,
) -> dict:
    return {
        "proc": proc,
        "status": status,
        "last": last,
        "exitCode": exit_code,
        "error": error,
        "lastUpdated": time_module.time(),
    }


def stream_tail(proc: subprocess.Popen, slug: str, running: dict, lock, time_module) -> None:
    assert proc.stdout is not None
    last = "starting..."
    last_error = ""
    try:
        for raw in proc.stdout:
            line = raw.rstrip("\n")
            if not line:
                continue
            last = line
            if line.startswith("ERROR:") or " ERROR:" in line or "analysis failed:" in line:
                last_error = line
            with lock:
                entry = running.get(slug)
                if entry is not None:
                    entry["last"] = line
                    entry["lastUpdated"] = time_module.time()
        exit_code = proc.wait()
    except Exception as exc:
        exit_code = proc.poll()
        last = str(exc)
        if exit_code is None:
            exit_code = -1
    with lock:
        if exit_code == 0:
            running[slug] = analysis_status_entry(
                time_module,
                proc=None,
                status="done",
                last=last or "done",
                exit_code=0,
            )
        else:
            detail = last_error or (last if last and last != "starting..." else "no error output")
            error = f"analyze.py exited with code {exit_code}: {detail}"
            running[slug] = analysis_status_entry(
                time_module,
                proc=None,
                status="error",
                last=detail,
                exit_code=exit_code,
                error=error,
            )


def series_meta(data_dir: Path, slug: str) -> dict | None:
    try:
        m = json.loads((data_dir / "manifest.json").read_text())
    except Exception:
        return None
    return next((s for s in m.get("series", []) if s.get("slug") == slug), None)


def parse_analysis_slices(raw: str, slug: str, series_meta) -> tuple[list[int] | None, str | None]:
    meta = series_meta(slug)
    if not meta:
        return None, f"unknown slug: {slug}"
    total = int(meta.get("slices", 0))
    selected: set[int] = set()
    try:
        for raw_part in raw.split(","):
            part = raw_part.strip()
            if not part:
                continue
            if "-" in part:
                start_s, end_s = part.split("-", 1)
                start, end = int(start_s), int(end_s)
                if end < start:
                    return None, f"slice range is reversed: {part}"
                values = range(start, end + 1)
            else:
                values = [int(part)]
            for value in values:
                if value < 0 or value >= total:
                    return None, f"slice out of range: {value} (valid 0-{total - 1})"
                selected.add(value)
    except ValueError:
        return None, "slices must be zero-based integers or ranges"
    if not selected:
        return None, "no slices selected"
    return sorted(selected), None


def start_analysis(
    root: Path,
    python_executable: str,
    time_module,
    slug: str,
    *,
    force: bool,
    slices: list[int] | None,
    valid_slugs,
    running: dict,
    lock,
    stream_tail,
) -> tuple[int, str]:
    if slug not in valid_slugs():
        return 400, f"unknown slug: {slug}"
    with lock:
        if running.get(slug, {}).get("status") == "running":
            return 409, f"already running: {slug}"
    cmd = [python_executable, "-u", str(root / "analyze.py")]
    if force:
        cmd.append("--force")
    if slices is not None:
        cmd += ["--slices", ",".join(str(s) for s in slices)]
    cmd += ["--", slug]
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            cwd=str(root),
        )
    except OSError as exc:
        return 500, f"failed to start analysis: {exc}"
    with lock:
        running[slug] = analysis_status_entry(time_module, proc=proc, status="running", last="starting...")
    threading.Thread(target=stream_tail, args=(proc, slug), daemon=True).start()
    return 202, f"started: {slug}{' (force)' if force else ''}"


def status_payload(running: dict, lock) -> dict:
    with lock:
        return {
            slug: {
                "status": entry.get("status", "running"),
                "running": entry.get("status", "running") == "running",
                "last": entry["last"],
                "exitCode": entry.get("exitCode"),
                "error": entry.get("error"),
                "lastUpdated": entry.get("lastUpdated"),
            }
            for slug, entry in running.items()
        }


def consult_ready(data_dir: Path) -> bool:
    try:
        manifest = json.loads((data_dir / "manifest.json").read_text())
    except Exception:
        return False
    for series in manifest.get("series", []):
        slug = str((series or {}).get("slug") or "").strip()
        if not slug:
            continue
        try:
            analysis = json.loads((data_dir / f"{slug}_analysis.json").read_text())
        except Exception:
            continue
        if analysis.get("findings"):
            return True
    return False


def ai_post_guard(config: dict | None, runtime_config) -> tuple[int, dict] | None:
    status = dict((config or runtime_config()).get("ai") or {})
    if not status.get("enabled", True):
        return 503, {"error": "AI features are disabled in config."}
    if status.get("ready"):
        return None
    issues = status.get("issues") or ["AI provider is not ready."]
    return 503, {
        "error": f"AI unavailable: {'; '.join(str(issue) for issue in issues)}",
        "provider": status.get("provider"),
    }


def handle_ai_post(
    handler,
    parsed,
    qs: dict,
    current_config: dict,
    ai_post_guard,
    parse_analysis_slices,
    start_analysis,
    validate_ask_payload,
    valid_slugs,
    lazy_ask,
    consult_ready,
) -> None:
    ai_guard = ai_post_guard(current_config)
    if ai_guard is not None:
        handler._json(*ai_guard)
        return

    if parsed.path == "/api/analyze":
        limited = handler._enforce_rate_limit(parsed.path)
        if limited is not None:
            handler._json(*limited)
            return
        try:
            content_length = int(handler.headers.get("Content-Length") or 0)
        except ValueError:
            content_length = 0
        if content_length > 0:
            body = handler._read_json_payload_or_error()
            if body is None:
                return
        slug = (qs.get("slug") or [""])[0]
        force = (qs.get("force") or ["0"])[0] in ("1", "true")
        raw_slices = (qs.get("slices") or [""])[0]
        if not slug:
            handler._json(400, {"error": "missing slug"})
            return
        slices = None
        if raw_slices:
            slices, error = parse_analysis_slices(raw_slices, slug)
            if error:
                handler._json(400, {"error": error})
                return
        code, msg = start_analysis(slug, force=force, slices=slices)
        handler._json(code, {"message": msg, "slug": slug})
        return

    if parsed.path == "/api/ask":
        limited = handler._enforce_rate_limit(parsed.path)
        if limited is not None:
            handler._json(*limited)
            return
        body = handler._read_json_payload_or_error()
        if body is None:
            return
        ask_req, invalid = validate_ask_payload(body, valid_slugs())
        if invalid is not None:
            handler._json(*invalid)
            return
        try:
            if ask_req["region"] is not None:
                kwargs = {
                    "region": ask_req["region"],
                    "provider": ask_req.get("provider"),
                    "model": ask_req.get("model"),
                }
                if ask_req.get("viewer_context"):
                    kwargs["viewer_context"] = ask_req["viewer_context"]
                result = lazy_ask().ask(ask_req["slug"], ask_req["slice_idx"], ask_req["question"], **kwargs)
            else:
                kwargs = {
                    "x": ask_req["x"],
                    "y": ask_req["y"],
                    "provider": ask_req.get("provider"),
                    "model": ask_req.get("model"),
                }
                if ask_req.get("viewer_context"):
                    kwargs["viewer_context"] = ask_req["viewer_context"]
                result = lazy_ask().ask(ask_req["slug"], ask_req["slice_idx"], ask_req["question"], **kwargs)
            handler._json(200, result)
        except ValueError as e:
            handler._json(400, {"error": str(e)})
        except Exception as e:
            traceback.print_exc()
            handler._json(500, {"error": str(e)})
        return

    if parsed.path == "/api/ask/stream":
        limited = handler._enforce_rate_limit("/api/ask")
        if limited is not None:
            handler._json(*limited)
            return
        body = handler._read_json_payload_or_error()
        if body is None:
            return
        ask_req, invalid = validate_ask_payload(body, valid_slugs())
        if invalid is not None:
            handler._json(*invalid)
            return
        # Server-Sent Events: each tool call and the final answer stream as they
        # happen. The browser reads the response body progressively.
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Cache-Control", "no-cache")
        handler.send_header("X-Accel-Buffering", "no")
        handler.send_header("Connection", "close")
        handler.end_headers()

        def emit(event: dict) -> None:
            handler.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
            handler.wfile.flush()

        loc: dict = {}
        if ask_req["region"] is not None:
            loc["region"] = ask_req["region"]
        elif ask_req["x"] is not None:
            loc["x"], loc["y"] = ask_req["x"], ask_req["y"]
        if ask_req.get("viewer_context"):
            loc["viewer_context"] = ask_req["viewer_context"]
        try:
            result = lazy_ask().ask(
                ask_req["slug"], ask_req["slice_idx"], ask_req["question"], on_event=emit,
                provider=ask_req.get("provider"), model=ask_req.get("model"), **loc,
            )
            emit({"type": "result", "result": result})
        except (BrokenPipeError, ConnectionResetError):
            return  # client navigated away mid-stream
        except Exception as e:
            traceback.print_exc()
            try:
                emit({"type": "error", "error": str(e)})
            except OSError:
                return
        try:
            emit({"type": "done"})
        except OSError:
            pass
        return

    if parsed.path == "/api/consult":
        force = (qs.get("force") or ["0"])[0] in ("1", "true")
        if not consult_ready():
            handler._json(400, {"error": "no analysis data to consult on — run analyze.py first"})
            return
        try:
            result = lazy_ask().consult(force=force)
            handler._json(200, result)
        except ValueError as e:
            handler._json(400, {"error": str(e)})
        except Exception as e:
            traceback.print_exc()
            handler._json(500, {"error": str(e)})
        return


def handle_ai_get(handler, parsed, data_dir: Path, has_local_api_token, status_payload) -> bool:
    if parsed.path == "/api/analyze/status":
        if not has_local_api_token():
            handler._json(403, {"error": "missing or invalid local api token"})
            return True
        handler._json(200, status_payload())
        return True
    if parsed.path == "/api/consult":
        if not has_local_api_token():
            handler._json(403, {"error": "missing or invalid local api token"})
            return True
        p = data_dir / "consult.json"
        if p.exists():
            try:
                cached = json.loads(p.read_text())
                if not isinstance(cached, dict):
                    raise ValueError("consult cache is not a JSON object")
                handler._json(200, {"cached": True, **cached})
                return True
            except Exception as exc:
                handler._json(409, {
                    "error": "consult cache is invalid",
                    "cacheError": str(exc),
                    "regeneratePath": "/api/consult?force=1",
                })
                return True
        handler._json(200, {})
        return True
    return False
