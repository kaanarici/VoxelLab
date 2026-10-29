from __future__ import annotations

import json
from pathlib import Path

import pytest

import analyze

PNG_1X1 = b"".join([
    b"\x89PNG\r\n\x1a\n",
    b"\x00\x00\x00\rIHDR",
    b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x00\x00\x00\x00",
    b"\x3a\x7e\x9b\x55",
    b"\x00\x00\x00\x0aIDATx\x9cc`\x00\x00\x00\x02\x00\x01",
    b"\xe2!\xbc3",
    b"\x00\x00\x00\x00IEND\xaeB`\x82",
])

@pytest.fixture()
def data_dir(tmp_path: Path, monkeypatch) -> Path:
    """An analysis data directory the module writes its sidecars into."""
    directory = tmp_path / "data"
    directory.mkdir()
    monkeypatch.setattr(analyze, "DATA", directory)
    return directory

@pytest.fixture()
def slice_stack(data_dir: Path):
    def make(slug: str = "sample", slices: int = 1) -> Path:
        series_dir = data_dir / slug
        series_dir.mkdir(parents=True)
        for index in range(slices):
            _ = (series_dir / f"{index:04d}.png").write_bytes(PNG_1X1)
        return series_dir

    return make

@pytest.fixture()
def stub_provider(monkeypatch):
    """Replace the paid provider calls with deterministic local results."""
    def install(*, slice_text=lambda series_name, slice_idx, png_path: png_path.name, summary="summary"):
        monkeypatch.setattr(
            analyze,
            "analyze_slice",
            lambda series_name, slice_idx, png_path, model, **_kwargs: {
                "slice": slice_idx,
                "severity": "note",
                "text": slice_text(series_name, slice_idx, png_path),
            },
        )
        monkeypatch.setattr(
            analyze,
            "summarize",
            lambda slug, series_name, findings, model, provider=None: (
                summary(series_name) if callable(summary) else summary
            ),
        )

    return install

def coverage_of(data_dir: Path, slug: str = "sample") -> dict:
    return json.loads((data_dir / f"{slug}_analysis.json").read_text())["coverage"]

def test_an_explicit_slice_subset_never_counts_as_full_coverage(data_dir: Path, slice_stack, stub_provider) -> None:
    slice_stack(slices=5)
    stub_provider()

    complete = analyze.process(
        "sample",
        {"name": "Sample", "slices": 5},
        "test-model",
        selected_slices=[2],
        sample_count=3,
    )

    coverage = coverage_of(data_dir)
    assert complete is False
    assert coverage["overviewSlices"] == [0, 2, 4]
    assert coverage["analyzedSlices"] == [2]
    assert coverage["isComplete"] is False

def test_a_full_overview_run_is_marked_complete(data_dir: Path, slice_stack, stub_provider) -> None:
    slice_stack(slices=5)
    stub_provider()

    complete = analyze.process("sample", {"name": "Sample", "slices": 5}, "test-model", sample_count=3)

    coverage = coverage_of(data_dir)
    assert complete is True
    assert coverage["overviewSlices"] == [0, 2, 4]
    assert coverage["isComplete"] is True

def test_selecting_exactly_the_overview_slices_still_reports_a_partial_run(data_dir: Path, slice_stack, stub_provider) -> None:
    slice_stack(slices=5)
    stub_provider()

    complete = analyze.process(
        "sample",
        {"name": "Sample", "slices": 5},
        "test-model",
        selected_slices=[0, 2, 4],
        sample_count=3,
    )

    coverage = coverage_of(data_dir)
    assert complete is False
    assert coverage["overviewSlices"] == [0, 2, 4]
    assert coverage["analyzedSlices"] == [0, 2, 4]
    assert coverage["isComplete"] is False

def test_two_studies_with_the_same_slug_keep_separate_result_sidecars(data_dir: Path, slice_stack, stub_provider) -> None:
    slice_stack()
    stub_provider(slice_text=lambda series_name, _idx, _png: series_name, summary=lambda series_name: series_name)
    first_key = "v2:11111111111111111111111111111111"
    second_key = "v2:22222222222222222222222222222222"

    assert analyze.process("sample", {"name": "Study A", "slices": 1}, "test-model", analysis_key=first_key) is True
    assert analyze.process("sample", {"name": "Study B", "slices": 1}, "test-model", analysis_key=second_key) is True

    first = json.loads(analyze.analysis_output_path("sample", first_key).read_text())
    second = json.loads(analyze.analysis_output_path("sample", second_key).read_text())
    assert (first["analysisKey"], first["summary"]) == (first_key, "Study A")
    assert (second["analysisKey"], second["summary"]) == (second_key, "Study B")
    assert not (data_dir / "sample_analysis.json").exists()

def test_a_result_identity_cannot_be_reused_for_another_series(data_dir: Path, slice_stack, stub_provider) -> None:
    slice_stack("sample")
    slice_stack("other")
    stub_provider(slice_text=lambda series_name, _idx, _png: series_name, summary=lambda series_name: series_name)
    key = "v2:33333333333333333333333333333333"
    assert analyze.process("sample", {"name": "Study A", "slices": 1}, "test-model", analysis_key=key) is True

    with pytest.raises(ValueError, match="already bound to another result identity"):
        _ = analyze.process("other", {"name": "Study B", "slices": 1}, "test-model", analysis_key=key, force=True)

    persisted = json.loads(analyze.analysis_output_path("sample", key).read_text())
    assert persisted["slug"] == "sample"
    assert persisted["summary"] == "Study A"

def test_a_path_like_result_identity_fails_closed(data_dir: Path) -> None:
    with pytest.raises(ValueError, match="invalid analysis key"):
        _ = analyze.analysis_output_path("sample", "../../escape")

def test_a_failing_slice_stops_the_run_and_names_the_slice(data_dir: Path, slice_stack, monkeypatch) -> None:
    slice_stack()
    monkeypatch.setattr(
        analyze,
        "analyze_slice",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("provider unavailable")),
    )
    monkeypatch.setattr(analyze, "summarize", lambda *_args, **_kwargs: "summary")

    with pytest.raises(RuntimeError, match="slice 0 failed: provider unavailable"):
        _ = analyze.process("sample", {"name": "Sample", "slices": 1}, "test-model", sample_count=1)

def test_a_missing_slice_image_stops_the_run(data_dir: Path) -> None:
    (data_dir / "sample").mkdir()

    with pytest.raises(RuntimeError, match="slice 0 image is missing"):
        _ = analyze.process("sample", {"name": "Sample", "slices": 1}, "test-model", sample_count=1)

def test_a_failing_summary_stops_the_run(data_dir: Path, slice_stack, monkeypatch) -> None:
    slice_stack()
    monkeypatch.setattr(
        analyze,
        "analyze_slice",
        lambda series_name, slice_idx, png_path, model, **_kwargs: {
            "slice": slice_idx,
            "severity": "note",
            "text": "ok",
        },
    )
    monkeypatch.setattr(
        analyze,
        "summarize",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("summary provider unavailable")),
    )

    with pytest.raises(RuntimeError, match="summary failed: summary provider unavailable"):
        _ = analyze.process("sample", {"name": "Sample", "slices": 1}, "test-model", sample_count=1)

def test_the_slice_prompt_marks_derived_context_as_approximate() -> None:
    prompt, labels, fingerprint = analyze.build_analysis_prompt(
        {"name": "Sample", "slices": 2},
        1,
        {
            "index": 1,
            "centerMm": [1.0, 2.0, 3.0],
            "intensity": {"source": "base_png", "units": "display_uint8", "mean": 12.0},
            "regions": [{"label": 3, "name": "L lateral ventricle", "areaPx": 10}],
            "symmetry": {"score": 4.2, "rankWithinSeries": 0.5},
        },
    )

    assert "Approximate derived context" in prompt
    assert "display_uint8" in prompt
    assert "pipeline-derived" in prompt
    assert "Do not classify anatomy as normal or abnormal" in prompt
    assert "infer restricted diffusion" in prompt
    assert labels == {3}
    assert fingerprint

def test_a_finding_may_only_reference_region_labels_it_was_given(monkeypatch) -> None:
    monkeypatch.setattr(
        analyze,
        "call_ai",
        lambda prompt, schema, model, provider, images=None, timeout=180: {
            "severity": "note",
            "text": "Educational observation.",
            "regions_referenced": [3, 999, 3],
        },
    )

    finding = analyze.analyze_slice(
        "Sample",
        0,
        Path("data/sample/0000.png"),
        "test-model",
        provider="codex",
        series_meta={"name": "Sample", "slices": 1},
        context={
            "slices": [{
                "index": 0,
                "regions": [{"label": 3, "name": "Known", "areaPx": 1}],
                "intensity": {"source": "base_png", "units": "display_uint8", "mean": 1.0},
            }],
        },
    )

    assert finding["regions_referenced"] == [3]
    assert "contextFingerprint" in finding
