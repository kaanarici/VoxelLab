import json
from pathlib import Path

import numpy as np
import pydicom
import pytest

from geometry import geometry_from_slices, sort_datasets_spatially
from modal_dicom import expand_primary_stack, mpr_geometry_error

FIXTURES = Path(__file__).parent / "fixtures" / "accuracy" / "dicom"

@pytest.mark.parametrize("name", ["axial-regular", "oblique-iop", "reversed-slice-order", "enhanced-multiframe"])
def test_native_pydicom_geometry_matches_patient_space_oracle(name):
    expected = json.loads((FIXTURES / f"{name}.golden.json").read_text())["expectedVoxelLab"]["series"]
    datasets = [pydicom.dcmread(path) for path in sorted((FIXTURES / name).glob("*.dcm"))]
    slices, error = expand_primary_stack(datasets)
    assert not error
    slices = sort_datasets_spatially(slices)
    assert not mpr_geometry_error(slices)
    geometry = geometry_from_slices(slices)
    for key in ["pixelSpacing", "orientation", "firstIPP", "lastIPP", "sliceSpacing"]:
        np.testing.assert_allclose(geometry[key], expected[key], rtol=0, atol=1e-6)

@pytest.mark.parametrize("name", ["duplicate-ipp", "mixed-frame-of-reference"])
def test_native_pydicom_invalid_stacks_fail_before_processing(name):
    datasets = [pydicom.dcmread(path) for path in sorted((FIXTURES / name).glob("*.dcm"))]
    assert mpr_geometry_error(datasets)
