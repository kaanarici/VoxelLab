from __future__ import annotations

import json
from pathlib import Path

import pytest

import ask


def test_ask_rejects_coordinates_outside_series_bounds(monkeypatch, tmp_path: Path) -> None:
    data = tmp_path / "data"
    data.mkdir()
    _ = (data / "manifest.json").write_text(json.dumps({
        "series": [{
            "slug": "t2_tse",
            "slices": 2,
            "width": 4,
            "height": 4,
        }],
    }))
    monkeypatch.setattr(ask, "DATA", data)

    with pytest.raises(ValueError, match="coordinates out of range"):
        _ = ask.ask("t2_tse", 0, "what is this?", x=5, y=1)


def test_ask_rejects_invalid_slug_before_path_construction(monkeypatch, tmp_path: Path) -> None:
    data = tmp_path / "data"
    data.mkdir()
    _ = (data / "manifest.json").write_text(json.dumps({"series": []}))
    monkeypatch.setattr(ask, "DATA", data)

    with pytest.raises(ValueError, match="invalid slug"):
        _ = ask.ask("../etc", 0, "what is this?", x=0, y=0)


def test_ask_cache_requires_matching_context_fingerprint() -> None:
    data = {
        "entries": [
            {
                "key": "0:0:0:abc",
                "slice": 0,
                "x": 1,
                "y": 1,
                "question": "what is this?",
                "answer": "old context-free answer",
                "crop": "data/sample_asks/0000_1_1_abc.png",
            },
            {
                "key": "0:0:0:abc",
                "slice": 0,
                "x": 1,
                "y": 1,
                "question": "what is this?",
                "answer": "context answer",
                "crop": "data/sample_asks/0000_1_1_abc.png",
                "contextFingerprint": "ctx1",
            },
        ],
    }

    assert ask._cached_ask(data, "0:0:0:abc", None)["answer"] == "old context-free answer"
    assert ask._cached_ask(data, "0:0:0:abc", "ctx1")["answer"] == "context answer"
    assert ask._cached_ask(data, "0:0:0:abc", "ctx2") is None


def test_build_ask_prompt_includes_approximate_point_context() -> None:
    prompt = ask.build_ask_prompt(
        crop_path=Path("data/sample_asks/crop.png"),
        slice_png=Path("data/sample/0000.png"),
        slug="sample",
        slice_idx=0,
        width=2,
        height=2,
        x=1,
        y=1,
        question="what is this?",
        point_context_text="Approximate point context:\n- Region: label 7; approximate.",
    )

    assert "Approximate point context" in prompt
    assert "approximate" in prompt
    assert "Do not diagnose" in prompt


def test_build_ask_prompt_keeps_viewer_context_separate_from_question() -> None:
    context_text, fingerprint = ask._viewer_context_prompt("Viewer cloud/action context:\n- Cloud action ready.")
    prompt = ask.build_ask_prompt(
        crop_path=Path("data/sample_asks/crop.png"),
        slice_png=Path("data/sample/0000.png"),
        slug="sample",
        slice_idx=0,
        width=2,
        height=2,
        x=1,
        y=1,
        question="What changed?",
        point_context_text="Approximate point context:\n- Region: label 7; approximate.",
        viewer_context_text=context_text,
    )

    assert fingerprint
    assert '"What changed?"' in prompt
    assert "Viewer workflow context supplied by the app" in prompt
    assert "Cloud action ready" in prompt
    assert "not additional user-authored question text" in prompt


def test_stream_ai_maps_codex_deltas(monkeypatch) -> None:
    def fake_stream(**kwargs):
        yield {"type": "codex_event", "method": "item/agentMessage/delta", "params": {"delta": "{\"answer\":\"The"}}
        yield {"type": "codex_event", "method": "item/agentMessage/delta", "params": {"delta": " hippocampus"}}
        yield {"type": "codex_event", "method": "item/commandExecution/outputDelta", "params": {"itemId": "cmd-1", "delta": "stdout"}}
        yield {"type": "result", "output": {"answer": "The hippocampus"}}

    events = []
    monkeypatch.setattr(ask, "stream_structured", fake_stream)

    result = ask._stream_ai(
        "prompt",
        "system",
        {"type": "object"},
        model=None,
        provider="codex",
        images=[],
        add_dirs=[],
        timeout=1,
        on_event=events.append,
    )

    assert result == {"answer": "The hippocampus"}
    assert events == [
        {"type": "delta", "text": "The"},
        {"type": "delta", "text": " hippocampus"},
        {"type": "tool_output", "id": "cmd-1", "text": "stdout"},
    ]


def test_ask_bypasses_context_free_cache_when_valid_context_exists(monkeypatch, tmp_path: Path) -> None:
    Image = pytest.importorskip("PIL.Image")

    data = tmp_path / "data"
    data.mkdir()
    (data / "sample").mkdir()
    (data / "sample_seg").mkdir()
    (data / "sample_regions").mkdir()
    Image.new("L", (2, 2), 100).save(data / "sample" / "0000.png")
    Image.new("L", (2, 2), 1).save(data / "sample_seg" / "0000.png")
    Image.new("L", (2, 2), 7).save(data / "sample_regions" / "0000.png")
    _ = (data / "manifest.json").write_text(json.dumps({
        "series": [{
            "slug": "sample",
            "slices": 1,
            "width": 2,
            "height": 2,
            "pixelSpacing": [1.0, 1.0],
            "firstIPP": [0.0, 0.0, 0.0],
            "lastIPP": [0.0, 0.0, 0.0],
            "orientation": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "hasContext": True,
        }],
    }))
    _ = (data / "sample_context.json").write_text(json.dumps({
        "slug": "sample",
        "version": 1,
        "slices": [{
            "index": 0,
            "centerMm": [0.5, 0.5, 0.0],
            "intensity": {"source": "base_png", "units": "display_uint8", "mean": 100.0},
            "regions": [{"label": 7, "name": "Approx region", "areaPx": 4, "areaMm2": 4.0}],
        }],
    }))
    key = ask._ask_key(0, 1, 1, "what is this?")
    _ = (data / "sample_asks.json").write_text(json.dumps({
        "slug": "sample",
        "entries": [{
            "key": key,
            "slice": 0,
            "x": 1,
            "y": 1,
            "question": "what is this?",
            "answer": "stale",
            "crop": "data/sample_asks/0000_1_1_6561768b93.png",
        }],
    }))
    prompts = []
    monkeypatch.setattr(ask, "DATA", data)
    monkeypatch.setattr(ask, "ROOT", tmp_path)
    monkeypatch.setattr(ask, "require_provider_ready", lambda provider=None: {"provider": provider or "claude", "ready": True})
    monkeypatch.setattr(
        ask,
        "_call_ai",
        lambda prompt, system, schema, model="test", provider=None, images=None, timeout=240, allow_agent_tools=False, add_dirs=None, on_event=None: prompts.append(prompt) or {"answer": "fresh"},
    )

    result = ask.ask("sample", 0, "what is this?", x=1, y=1, model="test", provider="codex")

    assert result["cached"] is False
    assert result["answer"] == "fresh"
    assert result["contextFingerprint"]
    assert "Approx region" in prompts[0]
    manifest = json.loads((data / "manifest.json").read_text())
    assert manifest["series"][0]["hasAskHistory"] is True


def test_ask_viewer_context_reaches_prompt_without_polluting_question(monkeypatch, tmp_path: Path) -> None:
    Image = pytest.importorskip("PIL.Image")

    data = tmp_path / "data"
    data.mkdir()
    (data / "sample").mkdir()
    Image.new("L", (2, 2), 100).save(data / "sample" / "0000.png")
    _ = (data / "manifest.json").write_text(json.dumps({
        "series": [{
            "slug": "sample",
            "slices": 1,
            "width": 2,
            "height": 2,
        }],
    }))
    prompts = []
    monkeypatch.setattr(ask, "DATA", data)
    monkeypatch.setattr(ask, "ROOT", tmp_path)
    monkeypatch.setattr(ask, "require_provider_ready", lambda provider=None: {"provider": provider or "claude", "ready": True})
    monkeypatch.setattr(
        ask,
        "_call_ai",
        lambda prompt, system, schema, model="test", provider=None, images=None, timeout=240, allow_agent_tools=False, add_dirs=None, on_event=None: prompts.append(prompt) or {"answer": "fresh"},
    )

    result = ask.ask(
        "sample",
        0,
        "What changed?",
        x=1,
        y=1,
        model="test",
        provider="codex",
        viewer_context=(
            "Viewer cloud/action context:\n"
            "- Cloud workflow operator summary: 4 action slots; runtime-ready 1; setup-required 0; blocked 0.\n"
            "- Cloud workflow next step: Cloud CT/MR segmentation: use Upload study to select DICOM stack and run Process CT/MR on cloud GPU; loaded study: CT/MR source volume candidates: Active Local CT.\n"
            "- Cloud action ready."
        ),
    )

    saved = json.loads((data / "sample_asks.json").read_text())["entries"][0]
    assert result["question"] == "What changed?"
    assert result["contextFingerprint"].startswith("viewer:")
    assert saved["question"] == "What changed?"
    assert saved["contextFingerprint"] == result["contextFingerprint"]
    assert "Cloud action ready" in prompts[0]
    assert result["actions"] == [{
        "id": "open-cloud-workflow",
        "label": "Open Cloud GPU",
        "detail": "Cloud CT/MR segmentation: use Upload study to select DICOM stack and run Process CT/MR on cloud GPU; loaded study: CT/MR source volume candidates: Active Local CT.",
    }]
    assert saved["actions"] == result["actions"]


def test_ask_viewer_context_adds_cloud_results_action() -> None:
    actions = ask._ask_actions_for_viewer_context(
        "\n".join([
            "Viewer cloud/action context:",
            "- Completed cloud actions in loaded study: 2.",
            "- Active completed cloud action: Cloud CT/MR segmentation; series Cloud Segmentation Result; job job_fixture_cloud_123; status partial.",
            "- Cloud workflow operator summary: 4 action slots; runtime-ready 1; setup-required 0; blocked 0.",
            "- Cloud workflow next step: Cloud CT/MR segmentation: use Upload study to select DICOM stack and run Process CT/MR on cloud GPU; loaded study: CT/MR source volume candidates: Active Local CT.",
        ])
    )

    assert actions[0] == {
        "id": "open-cloud-results",
        "label": "Open Cloud Results",
        "detail": "Active completed cloud action: Cloud CT/MR segmentation; series Cloud Segmentation Result; job job_fixture_cloud_123; status partial.",
    }
    assert actions[1]["id"] == "open-cloud-workflow"


def test_ask_viewer_context_adds_registration_compare_action_before_workflow_action() -> None:
    actions = ask._ask_actions_for_viewer_context(
        "\n".join([
            "Viewer cloud/action context:",
            "- Active registration evidence: series Moving; verdict slightly off; displacement 3.25 mm; source data/registration.json; inspect Metadata panel Compare opens fixed/moving compare with Fixed as fixed image.",
            "- Cloud workflow operator summary: 4 action slots; runtime-ready 1; setup-required 0; blocked 0.",
            "- Cloud workflow next step: Cloud registration/alignment: use Upload study to select fixed and moving DICOM stacks plus voxellab.source.json.",
        ])
    )

    assert actions[0] == {
        "id": "open-registration-compare",
        "label": "Open Registration Compare",
        "detail": "Active registration evidence: series Moving; verdict slightly off; displacement 3.25 mm; source data/registration.json; inspect Metadata panel Compare opens fixed/moving compare with Fixed as fixed image.",
    }
    assert actions[1] == {
        "id": "open-cloud-workflow",
        "label": "Open Cloud GPU",
        "detail": "Cloud registration/alignment: use Upload study to select fixed and moving DICOM stacks plus voxellab.source.json.",
    }
