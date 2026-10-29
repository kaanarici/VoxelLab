from __future__ import annotations

import importlib.metadata
import sys
import types

import pytest

from tests.helpers.python.modal_runtime import load_modal_app

@pytest.fixture()
def modal_app(monkeypatch):
    """`modal_app` imported against a fake `modal` package."""
    return load_modal_app(monkeypatch)

def test_standard_segmentation_attempts_cover_ct_and_mr(modal_app) -> None:
    assert modal_app.totalseg_attempts_for_modality("CT") == [("total", True, modal_app.CT_ROI_SUBSET)]
    assert modal_app.totalseg_attempts_for_modality("MR") == [
        ("brain_structures", False, None),
        ("total_mr", True, None),
        ("tissue_types_mr", True, None),
    ]
    assert modal_app.totalseg_attempts_for_modality("US") == []

def test_process_function_config_clamps_requested_gpu_cpu_and_memory(monkeypatch) -> None:
    monkeypatch.setenv("MRI_VIEWER_MODAL_GPU", "L4,A10G")
    monkeypatch.setenv("MRI_VIEWER_MODAL_CPU", "2.5")
    monkeypatch.setenv("MRI_VIEWER_MODAL_MEMORY_MB", "128")
    monkeypatch.setenv("MRI_VIEWER_MODAL_EPHEMERAL_DISK_MB", "0")

    modal_app = load_modal_app(monkeypatch)

    assert modal_app.PROCESS_FUNCTION_CONFIG["gpu"] == ["L4", "A10"]
    assert modal_app.PROCESS_FUNCTION_CONFIG["cpu"] == 2.5
    assert modal_app.PROCESS_FUNCTION_CONFIG["memory"] == 512
    assert "ephemeral_disk" not in modal_app.PROCESS_FUNCTION_CONFIG

def test_deployment_knobs_stay_inside_their_bounds(monkeypatch) -> None:
    monkeypatch.setenv("MRI_VIEWER_MODAL_R2_SECRET", "custom-r2-secret")
    monkeypatch.setenv("MRI_VIEWER_R2_TRANSFER_WORKERS", "500")
    monkeypatch.setenv("MRI_VIEWER_MODAL_WEB_RETRIES", "0")

    modal_app = load_modal_app(monkeypatch)

    assert modal_app.R2_SECRET.name == "custom-r2-secret"
    assert modal_app.R2_TRANSFER_WORKERS == 16
    assert "retries" not in modal_app.WEB_FUNCTION_CONFIG

def test_container_images_pin_hashed_requirements_and_ship_pipeline_sources(modal_app) -> None:
    assert modal_app.pipeline_image.requirements == [
        ("requirements/modal-pipeline.lock", {"extra_options": "--require-hashes"}),
    ]
    assert modal_app.web_image.requirements == [
        ("requirements/modal-web.lock", {"extra_options": "--require-hashes"}),
    ]
    assert set(modal_app.PIPELINE_SOURCE_MODULES) == set(modal_app.pipeline_image.local_sources)
    assert set(modal_app.PIPELINE_SOURCE_MODULES) == set(modal_app.web_image.local_sources)

def test_runtime_verifier_fails_closed_without_cuda(modal_app, monkeypatch) -> None:
    monkeypatch.setitem(
        sys.modules,
        "torch",
        types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False), __version__="test"),
    )
    for name in ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "MODAL_AUTH_TOKEN"):
        monkeypatch.setenv(name, "configured")

    with pytest.raises(RuntimeError, match="did not expose CUDA"):
        _ = modal_app.verify_runtime()

def test_runtime_verifier_checks_both_bucket_boundaries(modal_app, monkeypatch) -> None:
    checked: list[str] = []
    monkeypatch.setitem(
        sys.modules,
        "torch",
        types.SimpleNamespace(
            cuda=types.SimpleNamespace(is_available=lambda: True, get_device_name=lambda _index: "test-gpu"),
            __version__="test",
        ),
    )
    monkeypatch.setattr(modal_app, "get_r2_client", lambda: types.SimpleNamespace(head_bucket=lambda *, Bucket: checked.append(Bucket)))
    monkeypatch.setattr(modal_app.shutil, "which", lambda _name: "/usr/bin/TotalSegmentator")
    monkeypatch.setattr(importlib.metadata, "version", lambda _name: "test")
    for name in (
        "R2_ENDPOINT",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "R2_UPLOAD_BUCKET",
        "R2_RESULTS_BUCKET",
        "MODAL_AUTH_TOKEN",
    ):
        monkeypatch.setenv(name, "configured")

    result = modal_app.verify_runtime()

    assert checked == ["scan-inputs", "scan-results"]
    assert result["status"] == "ok"
    assert result["bucketsReachable"] is True
    assert result["versions"]["zstandard"] == "test"
