from __future__ import annotations

import base64
import io
import json
from pathlib import Path

import pytest

import ask

VIEWER_CLOUD_CONTEXT = "\n".join([
    "Viewer cloud/action context:",
    "- Cloud workflow operator summary: 4 action slots; runtime-ready 1; setup-required 0; blocked 0.",
    "- Cloud workflow next step: Cloud CT/MR segmentation: use Upload study to select DICOM stack and run Process CT/MR on cloud GPU; loaded study: CT/MR source volume candidates: Active Local CT.",
    "- Cloud action ready.",
])

class AskWorkspace:
    """A data directory plus provider stubs for one `ask.ask` scenario."""

    def __init__(self, root: Path, monkeypatch) -> None:
        self.root = root
        self.data = root / "data"
        self.data.mkdir()
        self.prompts: list[str] = []
        self.calls: list[dict] = []
        monkeypatch.setattr(ask, "DATA", self.data)
        monkeypatch.setattr(ask, "ROOT", root)
        self._monkeypatch = monkeypatch

    def write_manifest(self, *series: dict) -> None:
        _ = (self.data / "manifest.json").write_text(json.dumps({"series": list(series)}))

    def write_sidecar(self, name: str, payload: dict) -> None:
        _ = (self.data / name).write_text(json.dumps(payload))

    def write_slice(self, folder: str, index: int, value: int, size: tuple[int, int] = (2, 2)) -> None:
        image = pytest.importorskip("PIL.Image")
        (self.data / folder).mkdir(exist_ok=True)
        image.new("L", size, value).save(self.data / folder / f"{index:04d}.png")

    def stub_provider(self, answer: str = "fresh") -> None:
        def call_ai(prompt, _system, _schema, **kwargs):
            self.prompts.append(prompt)
            self.calls.append(kwargs)
            return {"answer": answer}

        self._monkeypatch.setattr(
            ask,
            "require_provider_ready",
            lambda provider=None: {"provider": provider or "claude", "ready": True},
        )
        self._monkeypatch.setattr(ask, "_call_ai", call_ai)

@pytest.fixture()
def workspace(tmp_path: Path, monkeypatch) -> AskWorkspace:
    return AskWorkspace(tmp_path, monkeypatch)

def local_image_payload() -> dict:
    image = pytest.importorskip("PIL.Image")
    buffer = io.BytesIO()
    image.new("L", (8, 6), 100).save(buffer, format="PNG")
    return {
        "data_url": f"data:image/png;base64,{base64.b64encode(buffer.getvalue()).decode()}",
        "width": 8,
        "height": 6,
        "name": "Local MR",
        "modality": "MR",
    }

def test_a_browser_local_study_asks_about_the_current_slice_only(workspace: AskWorkspace) -> None:
    workspace.stub_provider(answer="Visible slice description.")

    result = ask.ask(
        "local_fixture_1",
        2,
        "What is visible?",
        local_image=local_image_payload(),
        provider="codex",
    )

    assert result["answer"] == "Visible slice description."
    assert result["cached"] is False
    assert result["crop"] == "local-current-slice"
    assert "rest of the locally opened study was not transmitted" in workspace.prompts[0]
    assert len(workspace.calls[0]["images"]) == 1

def test_coordinates_outside_the_series_bounds_are_rejected(workspace: AskWorkspace) -> None:
    workspace.write_manifest({"slug": "t2_tse", "slices": 2, "width": 4, "height": 4})

    with pytest.raises(ValueError, match="coordinates out of range"):
        _ = ask.ask("t2_tse", 0, "what is this?", x=5, y=1)

def test_a_path_like_slug_is_rejected_before_any_path_is_built(workspace: AskWorkspace) -> None:
    workspace.write_manifest()

    with pytest.raises(ValueError, match="invalid slug"):
        _ = ask.ask("../etc", 0, "what is this?", x=0, y=0)

def test_cached_answers_are_reused_only_for_a_matching_context_fingerprint() -> None:
    entries = {
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

    assert ask._cached_ask(entries, "0:0:0:abc", None)["answer"] == "old context-free answer"
    assert ask._cached_ask(entries, "0:0:0:abc", "ctx1")["answer"] == "context answer"
    assert ask._cached_ask(entries, "0:0:0:abc", "ctx2") is None

def test_the_prompt_marks_point_context_as_approximate_and_forbids_diagnosis() -> None:
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
    assert "Do not classify anatomy as normal or abnormal" in ask.ASK_SYSTEM
    assert "Do not classify the study as normal or abnormal" in ask.CONSULT_SYSTEM

def test_viewer_context_stays_separate_from_the_users_question_in_the_prompt() -> None:
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

def test_streamed_provider_deltas_become_viewer_events(monkeypatch) -> None:
    def fake_stream(**_kwargs):
        yield {"type": "codex_event", "method": "item/agentMessage/delta", "params": {"delta": '{"answer":"The'}}
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

def test_a_context_free_cached_answer_is_bypassed_once_context_exists(workspace: AskWorkspace) -> None:
    workspace.write_slice("sample", 0, 100)
    workspace.write_slice("sample_seg", 0, 1)
    workspace.write_slice("sample_regions", 0, 7)
    workspace.write_manifest({
        "slug": "sample",
        "slices": 1,
        "width": 2,
        "height": 2,
        "pixelSpacing": [1.0, 1.0],
        "firstIPP": [0.0, 0.0, 0.0],
        "lastIPP": [0.0, 0.0, 0.0],
        "orientation": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        "hasContext": True,
    })
    workspace.write_sidecar("sample_context.json", {
        "slug": "sample",
        "version": 1,
        "slices": [{
            "index": 0,
            "centerMm": [0.5, 0.5, 0.0],
            "intensity": {"source": "base_png", "units": "display_uint8", "mean": 100.0},
            "regions": [{"label": 7, "name": "Approx region", "areaPx": 4, "areaMm2": 4.0}],
        }],
    })
    workspace.write_sidecar("sample_asks.json", {
        "slug": "sample",
        "entries": [{
            "key": ask._ask_key(0, 1, 1, "what is this?"),
            "slice": 0,
            "x": 1,
            "y": 1,
            "question": "what is this?",
            "answer": "stale",
            "crop": "data/sample_asks/0000_1_1_6561768b93.png",
        }],
    })
    workspace.stub_provider()

    result = ask.ask("sample", 0, "what is this?", x=1, y=1, model="test", provider="codex")

    manifest = json.loads((workspace.data / "manifest.json").read_text())
    assert result["cached"] is False
    assert result["answer"] == "fresh"
    assert result["contextFingerprint"]
    assert "Approx region" in workspace.prompts[0]
    assert manifest["series"][0]["hasAskHistory"] is True

def test_viewer_context_reaches_the_prompt_and_the_saved_history(workspace: AskWorkspace) -> None:
    workspace.write_slice("sample", 0, 100)
    workspace.write_manifest({"slug": "sample", "slices": 1, "width": 2, "height": 2})
    workspace.stub_provider()

    result = ask.ask(
        "sample",
        0,
        "What changed?",
        x=1,
        y=1,
        model="test",
        provider="codex",
        viewer_context=VIEWER_CLOUD_CONTEXT,
    )

    saved = json.loads((workspace.data / "sample_asks.json").read_text())["entries"][0]
    assert result["question"] == "What changed?"
    assert result["contextFingerprint"].startswith("viewer:")
    assert saved["question"] == "What changed?"
    assert saved["contextFingerprint"] == result["contextFingerprint"]
    assert "Cloud action ready" in workspace.prompts[0]
    assert result["actions"] == [{
        "id": "open-cloud-workflow",
        "label": "Open Cloud GPU",
        "detail": "Cloud CT/MR segmentation: use Upload study to select DICOM stack and run Process CT/MR on cloud GPU; loaded study: CT/MR source volume candidates: Active Local CT.",
    }]
    assert saved["actions"] == result["actions"]

def test_completed_cloud_work_offers_the_results_action_first() -> None:
    actions = ask._ask_actions_for_viewer_context("\n".join([
        "Viewer cloud/action context:",
        "- Completed cloud actions in loaded study: 2.",
        "- Active completed cloud action: Cloud CT/MR segmentation; series Cloud Segmentation Result; job job_fixture_cloud_123; status partial.",
        "- Cloud workflow operator summary: 4 action slots; runtime-ready 1; setup-required 0; blocked 0.",
        "- Cloud workflow next step: Cloud CT/MR segmentation: use Upload study to select DICOM stack and run Process CT/MR on cloud GPU; loaded study: CT/MR source volume candidates: Active Local CT.",
    ]))

    assert actions[0] == {
        "id": "open-cloud-results",
        "label": "Open Cloud Results",
        "detail": "Active completed cloud action: Cloud CT/MR segmentation; series Cloud Segmentation Result; job job_fixture_cloud_123; status partial.",
    }
    assert actions[1]["id"] == "open-cloud-workflow"

def test_active_registration_evidence_offers_compare_before_the_workflow_action() -> None:
    actions = ask._ask_actions_for_viewer_context("\n".join([
        "Viewer cloud/action context:",
        "- Active registration evidence: series Moving; verdict slightly off; displacement 3.25 mm; source data/registration.json; inspect Metadata panel Compare opens fixed/moving compare with Fixed as fixed image.",
        "- Cloud workflow operator summary: 4 action slots; runtime-ready 1; setup-required 0; blocked 0.",
        "- Cloud workflow next step: Cloud registration/alignment: use Upload study to select fixed and moving DICOM stacks plus voxellab.source.json.",
    ]))

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
