from __future__ import annotations

import importlib.metadata
import json
from pathlib import Path
import sys

import numpy as np
import pytest

import projection_rtk
from projection_reconstruction import reconstruct_projection_volume
from projection_rtk import _detector_spacing_mm, configured_rtk_command
from scripts import rtk_projection_wrapper

from tests.helpers.python.manifests import circular_cbct_source

WRAPPER_PREAMBLE = """import argparse, json, numpy as np
parser = argparse.ArgumentParser()
parser.add_argument('--input-manifest')
parser.add_argument('--projections')
parser.add_argument('--output-json')
args = parser.parse_args()
volume_path = str((__import__('pathlib').Path(args.output_json).parent / 'volume.npy'))
"""

class FakeProjection:
    def __init__(self, pixel_array, instance: int, *, imager_spacing=None):
        self.pixel_array = pixel_array
        self.SeriesInstanceUID = "1.2.projection.series"
        self.StudyInstanceUID = "1.2.study"
        self.Modality = "XA"
        self.InstanceNumber = instance
        if imager_spacing is not None:
            self.ImagerPixelSpacing = imager_spacing

def fake_datasets() -> list[FakeProjection]:
    pixels = np.arange(16, dtype=np.float32).reshape(4, 4)
    return [
        FakeProjection(pixels, 1, imager_spacing=[0.4, 0.6]),
        FakeProjection(pixels + 1, 2, imager_spacing=[0.4, 0.6]),
    ]

def install_wrapper(monkeypatch, tmp_path: Path, body: str, name: str = "rtk_wrapper.py") -> Path:
    """Point the reconstruction engine at a stand-in external RTK wrapper."""
    wrapper = tmp_path / name
    _ = wrapper.write_text(body)
    monkeypatch.setenv("MRI_VIEWER_RTK_COMMAND", f"{sys.executable} {wrapper}")
    return wrapper

def test_the_external_wrapper_result_becomes_the_reconstructed_volume(monkeypatch, tmp_path: Path) -> None:
    _ = install_wrapper(monkeypatch, tmp_path, WRAPPER_PREAMBLE + """stack = np.load(args.projections, allow_pickle=False)
np.save(volume_path, np.full((3, 8, 8), float(stack.mean()), dtype=np.float32))
open(args.output_json, 'w').write(json.dumps({
    'volumePath': volume_path,
    'geometry': {'lastIPP': [0.0, 0.0, 3.0]},
    'projectionSet': {'projectionKind': 'cbct'},
    'report': {'backend': 'rtk-wrapper', 'validation': 'reference-parity'},
}))
""")

    result = reconstruct_projection_volume(fake_datasets(), circular_cbct_source(), np)

    assert result["volume"].shape == (3, 8, 8)
    assert float(result["volume"][1, 1, 1]) > 0
    assert result["geometry"]["lastIPP"] == [0.0, 0.0, 3.0]
    assert result["projectionSet"]["projectionKind"] == "cbct"
    assert result["report"]["backend"] == "rtk-wrapper"
    assert result["report"]["geometryModel"] == "circular-cbct"
    assert result["report"]["validation"] == "reference-parity"

def test_a_wrapper_without_geometry_keeps_the_requested_orientation(monkeypatch, tmp_path: Path) -> None:
    _ = install_wrapper(monkeypatch, tmp_path, WRAPPER_PREAMBLE + """np.save(volume_path, np.ones((3, 8, 8), dtype=np.float32))
open(args.output_json, 'w').write(json.dumps({'volumePath': volume_path}))
""")
    manifest = circular_cbct_source(orientation=[0.0, 1.0, 0.0, 0.0, 0.0, 1.0])

    result = reconstruct_projection_volume(fake_datasets(), manifest, np)

    assert result["geometry"]["lastIPP"] == [3.0, 0.0, 0.0]

def test_a_wrapper_validation_claim_outside_the_contract_is_clamped(monkeypatch, tmp_path: Path) -> None:
    _ = install_wrapper(monkeypatch, tmp_path, WRAPPER_PREAMBLE + """np.save(volume_path, np.ones((3, 8, 8), dtype=np.float32))
open(args.output_json, 'w').write(json.dumps({
    'volumePath': volume_path,
    'report': {'validation': 'totally-made-up'},
}))
""")

    result = reconstruct_projection_volume(fake_datasets(), circular_cbct_source(), np)

    assert result["report"]["validation"] == "external-engine"

def test_a_failing_wrapper_reports_its_own_error(monkeypatch, tmp_path: Path) -> None:
    _ = install_wrapper(
        monkeypatch,
        tmp_path,
        "import sys\nsys.stderr.write('wrapper boom')\nraise SystemExit(2)\n",
        name="rtk_wrapper_fail.py",
    )

    with pytest.raises(RuntimeError, match="wrapper failed") as exc_info:
        _ = reconstruct_projection_volume(fake_datasets(), circular_cbct_source(), np)

    assert "wrapper boom" in str(exc_info.value)

def test_non_parallel_geometry_without_an_engine_fails_closed(monkeypatch) -> None:
    monkeypatch.setattr(projection_rtk, "configured_rtk_command", lambda: "")

    with pytest.raises(RuntimeError, match="requires RTK"):
        _ = reconstruct_projection_volume(
            [FakeProjection(np.ones((4, 4), dtype=np.float32), 1)],
            circular_cbct_source(anglesDeg=[0], outputShape=[8, 8, 2], outputSpacingMm=[1.0, 1.0, 1.0]),
            np,
        )

@pytest.mark.parametrize(
    ("volume", "geometry", "message"),
    [
        (np.ones((2, 8, 8)), {}, "requested grid"),
        (np.full((3, 8, 8), np.nan), {}, "finite real"),
        (np.ones((3, 8, 8)), {"pixelSpacing": [9, 9]}, "changed requested geometry"),
        (np.ones((3, 8, 8)), {"pixelSpacing": [1, 2, 3]}, "changed requested geometry"),
    ],
    ids=["wrong-shape", "non-finite-samples", "changed-spacing", "malformed-spacing"],
)
def test_a_wrapper_cannot_replace_the_requested_geometry_or_return_unusable_samples(
    tmp_path: Path, monkeypatch, volume, geometry: dict, message: str
) -> None:
    monkeypatch.setattr(projection_rtk, "configured_rtk_command", lambda: "wrapper")

    def wrapper(command, manifest_path, projections_path, output_path):
        volume_path = tmp_path / "result.npy"
        np.save(volume_path, volume)
        _ = output_path.write_text(json.dumps({"volumePath": str(volume_path), "geometry": geometry}))

    monkeypatch.setattr(projection_rtk, "_run_wrapper", wrapper)

    with pytest.raises(RuntimeError, match=message):
        _ = reconstruct_projection_volume(fake_datasets(), circular_cbct_source(), np)

@pytest.mark.parametrize("spacing", [None, [0, 1], [float("nan"), 1], [1]], ids=["missing", "zero", "not-a-number", "one-value"])
def test_detector_spacing_must_come_from_real_imager_metadata(spacing) -> None:
    dataset = FakeProjection(np.zeros((4, 4), dtype=np.float32), 1, imager_spacing=spacing)

    with pytest.raises(ValueError, match="spacing"):
        _ = _detector_spacing_mm(dataset)

def test_detector_spacing_prefers_imager_spacing_over_reconstructed_pixel_spacing() -> None:
    dataset = FakeProjection(np.zeros((4, 4), dtype=np.float32), 1, imager_spacing=[0.4, 0.6])
    dataset.PixelSpacing = [0.2, 0.3]

    assert _detector_spacing_mm(dataset) == [0.4, 0.6]

def test_the_bundled_wrapper_defaults_to_the_repository_script(monkeypatch) -> None:
    try:
        _ = importlib.metadata.version("itk-rtk")
    except importlib.metadata.PackageNotFoundError:
        pytest.skip("itk-rtk is not installed; the bundled RTK wrapper cannot be selected")
    monkeypatch.delenv("MRI_VIEWER_RTK_COMMAND", raising=False)

    assert "scripts/rtk_projection_wrapper.py" in configured_rtk_command()

def test_the_bundled_wrapper_refuses_limited_angle_tomography() -> None:
    manifest = circular_cbct_source(geometryModel="limited-angle-tomo")

    with pytest.raises(RuntimeError, match="iterative reconstruction runtime"):
        _ = rtk_projection_wrapper.reconstruct(manifest, np.zeros((2, 4, 4), dtype=np.float32))

def test_the_bundled_wrapper_requires_line_integral_projections() -> None:
    with pytest.raises(ValueError, match="inputValueDomain=line-integral"):
        _ = rtk_projection_wrapper.reconstruct(circular_cbct_source(), np.ones((2, 4, 4), dtype=np.float32))

def test_parallel_beam_reconstruction_has_no_uncalibrated_fallback() -> None:
    manifest = circular_cbct_source(geometryModel="parallel-beam-stack")

    with pytest.raises(RuntimeError, match="calibrated external reconstruction engine"):
        _ = rtk_projection_wrapper.reconstruct(manifest, np.ones((2, 4, 4), dtype=np.float32))
