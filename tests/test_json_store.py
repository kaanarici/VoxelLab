from __future__ import annotations

import json
import multiprocessing
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

import analyze
import ask
import context
import json_store


def _series() -> dict:
    return {
        "slug": "sample",
        "name": "Sample",
        "description": "Sample series",
        "slices": 1,
        "width": 2,
        "height": 2,
        "pixelSpacing": [1.0, 1.0],
        "sliceThickness": 1.0,
        "hasBrain": False,
        "hasSeg": False,
        "hasRaw": False,
    }


def _ask_entry(key: str) -> dict:
    return {
        "key": key,
        "slice": 0,
        "x": 1,
        "y": 1,
        "question": f"question {key}",
        "answer": f"answer {key}",
        "crop": f"data/sample_asks/{key}.png",
    }


def _increment_json(path: str, count: int) -> None:
    for _index in range(count):
        def increment(current: dict) -> dict:
            current["count"] += 1
            return current

        _ = json_store.update_json(Path(path), increment, default={"count": 0})


def _run_analysis_process(data_path: str, started, release, paid_calls) -> None:
    analyze.DATA = Path(data_path)

    def fake_analyze_slice(*_args, **_kwargs):
        with paid_calls.get_lock():
            paid_calls.value += 1
        started.set()
        if not release.wait(timeout=10):
            raise TimeoutError("test analysis release timed out")
        return {"slice": 0, "severity": "note", "text": "done"}

    analyze.analyze_slice = fake_analyze_slice
    analyze.summarize = lambda *_args, **_kwargs: "summary"
    analyze.configured_provider = lambda _provider=None: "codex"
    analyze.resolve_model = lambda _model=None, _provider=None: "test"
    if not analyze.process("sample", {**_series(), "modality": "MR"}, "test", sample_count=1):
        raise AssertionError("analysis did not complete")


def test_concurrent_ask_saves_retain_both_answers(tmp_path: Path, monkeypatch) -> None:
    data = tmp_path / "data"
    data.mkdir()
    manifest = {"patient": "anonymous", "studyDate": "", "series": [_series()]}
    _ = (data / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setattr(ask, "DATA", data)

    with ThreadPoolExecutor(max_workers=2) as pool:
        _ = list(pool.map(lambda key: ask._save_asks("sample", {"entries": [_ask_entry(key)]}), ["a", "b"]))

    saved = json.loads((data / "sample_asks.json").read_text(encoding="utf-8"))
    assert {entry["key"] for entry in saved["entries"]} == {"a", "b"}
    assert json.loads((data / "manifest.json").read_text(encoding="utf-8"))["series"][0]["hasAskHistory"] is True


def test_concurrent_manifest_updates_retain_independent_flags(tmp_path: Path, monkeypatch) -> None:
    data = tmp_path / "data"
    data.mkdir()
    manifest_path = data / "manifest.json"
    _ = manifest_path.write_text(json.dumps({
        "patient": "anonymous",
        "studyDate": "",
        "series": [_series()],
    }), encoding="utf-8")
    monkeypatch.setattr(analyze, "DATA", data)

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(analyze.update_manifest, ["sample"]),
            pool.submit(context.set_has_context, manifest_path, {"sample"}),
        ]
        for future in futures:
            future.result()

    series = json.loads(manifest_path.read_text(encoding="utf-8"))["series"][0]
    assert series["hasAnalysis"] is True
    assert series["hasContext"] is True


def test_failed_atomic_replace_preserves_previous_json(tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "state.json"
    original = {"status": "complete", "answers": [1, 2]}
    json_store.atomic_write_json(path, original)

    def fail_replace(_source, _destination):
        raise OSError("simulated interruption")

    monkeypatch.setattr(json_store.os, "replace", fail_replace)

    with pytest.raises(OSError, match="simulated interruption"):
        json_store.atomic_write_json(path, {"status": "partial"})

    assert json.loads(path.read_text(encoding="utf-8")) == original
    assert list(tmp_path.glob(".state.json.*.tmp")) == []


def test_update_json_requires_existing_file_without_explicit_default(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        _ = json_store.update_json(tmp_path / "manifest.json", lambda manifest: manifest)

    assert not (tmp_path / "manifest.json").exists()


def test_json_updates_are_serialized_across_processes(tmp_path: Path) -> None:
    path = tmp_path / "counter.json"
    json_store.atomic_write_json(path, {"count": 0})
    context = multiprocessing.get_context("spawn")
    processes = [context.Process(target=_increment_json, args=(str(path), 20)) for _index in range(3)]

    for process in processes:
        process.start()
    for process in processes:
        process.join(timeout=15)
        assert process.exitcode == 0

    assert json.loads(path.read_text(encoding="utf-8")) == {"count": 60}


def test_analysis_operation_lock_prevents_duplicate_paid_work_across_processes(tmp_path: Path) -> None:
    data = tmp_path / "data"
    series_dir = data / "sample"
    series_dir.mkdir(parents=True)
    _ = (series_dir / "0000.png").write_bytes(b"fixture")
    process_context = multiprocessing.get_context("spawn")
    started = process_context.Event()
    release = process_context.Event()
    paid_calls = process_context.Value("i", 0)
    first = process_context.Process(target=_run_analysis_process, args=(str(data), started, release, paid_calls))
    second = process_context.Process(target=_run_analysis_process, args=(str(data), started, release, paid_calls))

    first.start()
    assert started.wait(timeout=10)
    second.start()
    release.set()
    for process in (first, second):
        process.join(timeout=15)
        assert process.exitcode == 0

    assert paid_calls.value == 1
    saved = json.loads((data / "sample_analysis.json").read_text(encoding="utf-8"))
    assert [finding["slice"] for finding in saved["findings"]] == [0]
