from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

SAMPLE_DIR = Path(__file__).resolve().parents[1] / "test-samples" / "microscopy"
READER = {"czi": "czifile", "nd2": "nd2", "lif": "liffile"}
EXPECTED_NATIVE_PARTS = {"czi": 1, "nd2": 1, "lif": 4}

def sample_case(extension: str):
    """Skip explicitly when the local vendor sample or its reader is absent."""
    missing = []
    if not (SAMPLE_DIR / f"sample.{extension}").exists():
        missing.append(f"test-samples/microscopy/sample.{extension}")
    missing.extend(
        module
        for module in (READER[extension], "tifffile")
        if importlib.util.find_spec(module) is None
    )
    return pytest.param(
        extension,
        id=extension,
        marks=pytest.mark.skipif(bool(missing), reason=f"missing {', '.join(missing)}"),
    )

VENDOR_SAMPLES = [sample_case(extension) for extension in ("czi", "nd2", "lif")]

@pytest.mark.parametrize("extension", VENDOR_SAMPLES)
def test_a_vendor_sample_converts_to_a_calibrated_ome_tiff(extension: str, tmp_path: Path) -> None:
    import tifffile
    from microscopy_convert import convert_to_ome_tiff_with_result, read_normalized_stack

    source = str(SAMPLE_DIR / f"sample.{extension}")
    stack = read_normalized_stack(source)
    output = str(tmp_path / "out.ome.tiff")

    _ = convert_to_ome_tiff_with_result(source, output)

    assert stack.data.ndim == 5, "normalized to TCZYX"
    assert stack.source_format == extension.upper()
    assert isinstance(stack.warnings, list)
    with tifffile.TiffFile(output) as tif:
        ome = tif.ome_metadata or ""
        assert "<OME" in ome
        assert 'SizeX="' in ome
        assert 'SizeY="' in ome

@pytest.mark.parametrize("extension", VENDOR_SAMPLES)
def test_a_split_conversion_preserves_every_native_unit(extension: str, tmp_path: Path) -> None:
    from microscopy_convert import convert_to_ome_tiff_parts, list_native_series_units

    source = str(SAMPLE_DIR / f"sample.{extension}")

    units = list_native_series_units(source)
    results = convert_to_ome_tiff_parts(source, str(tmp_path / "split"), f"sample.{extension}")

    assert len(units) == EXPECTED_NATIVE_PARTS[extension]
    assert len(results) == len(units)
    assert len({result.part_id for result in results}) == len(results)
    assert len({result.file_name for result in results}) == len(results)
    for result in results:
        assert Path(result.output_path).exists()
        assert result.file_name.endswith(".ome.tiff")
        assert any("native reader" in warning for warning in result.warnings)
