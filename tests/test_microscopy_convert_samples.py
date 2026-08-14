"""End-to-end conversion of real vendor samples, guarded so CI (no samples, no optional
readers) skips cleanly. Run locally after downloading samples into test-samples/microscopy/
and `pip install voxellab-tooling[microscopy]`. These samples are gitignored, not demo data.
"""
import importlib.util
import os

import pytest

SAMPLE_DIR = os.path.join(os.path.dirname(__file__), "..", "test-samples", "microscopy")
READER = {"czi": "czifile", "nd2": "nd2", "lif": "liffile"}
EXPECTED_NATIVE_PARTS = {"czi": 1, "nd2": 1, "lif": 4}


def _available(ext):
    return (
        os.path.exists(os.path.join(SAMPLE_DIR, f"sample.{ext}"))
        and importlib.util.find_spec(READER[ext]) is not None
        and importlib.util.find_spec("tifffile") is not None
    )


@pytest.mark.parametrize("ext", ["czi", "nd2", "lif"])
def test_vendor_sample_converts_to_calibrated_ome_tiff(ext, tmp_path):
    if not _available(ext):
        pytest.skip(f"no local sample.{ext} or its reader/tifffile is not installed")
    from microscopy_convert import convert_to_ome_tiff_with_result, read_normalized_stack

    src = os.path.join(SAMPLE_DIR, f"sample.{ext}")
    stack = read_normalized_stack(src)
    assert stack.data.ndim == 5, "normalized to TCZYX"
    assert stack.source_format == ext.upper()
    assert isinstance(stack.warnings, list)

    out = str(tmp_path / "out.ome.tiff")
    _ = convert_to_ome_tiff_with_result(src, out)
    import tifffile

    with tifffile.TiffFile(out) as tif:
        ome = tif.ome_metadata or ""
        assert "<OME" in ome
        # Sizes reflect the normalized axes; the browser reads these via parseOmeXmlMetadata.
        assert 'SizeX="' in ome and 'SizeY="' in ome


@pytest.mark.parametrize("ext", ["czi", "nd2", "lif"])
def test_vendor_sample_split_conversion_preserves_every_native_unit(ext, tmp_path):
    if not _available(ext):
        pytest.skip(f"no local sample.{ext} or its reader/tifffile is not installed")
    from microscopy_convert import convert_to_ome_tiff_parts, list_native_series_units

    src = os.path.join(SAMPLE_DIR, f"sample.{ext}")
    units = list_native_series_units(src)
    results = convert_to_ome_tiff_parts(src, str(tmp_path / "split"), f"sample.{ext}")

    assert len(units) == EXPECTED_NATIVE_PARTS[ext]
    assert len(results) == len(units)
    assert len({result.part_id for result in results}) == len(results)
    assert len({result.file_name for result in results}) == len(results)
    for result in results:
        assert os.path.exists(result.output_path)
        assert result.file_name.endswith(".ome.tiff")
        assert any("native reader" in warning for warning in result.warnings)
