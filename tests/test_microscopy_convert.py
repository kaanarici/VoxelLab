"""Pure-logic tests for the native microscopy conversion primitive.

The vendor readers (nd2/czifile/liffile) and tifffile are optional and not exercised here;
these tests pin the format-agnostic backbone: axis normalization, dispatch, and fail-closed
routing. End-to-end vendor reads are verified where the optional readers + sample files exist.
"""
import importlib.util
import subprocess
import sys
import types

import numpy as np
import pytest

from microscopy_convert import (
    CANON_AXES,
    EXTERNAL_CONVERT_EXTENSIONS,
    MAX_CONVERTER_ERROR_DETAIL_CHARS,
    NATIVE_READER_EXTENSIONS,
    NormalizedStack,
    SUPPORTED_EXTENSIONS,
    convert_to_ome_tiff,
    read_normalized_stack,
    to_tczyx,
)


def test_to_tczyx_inserts_missing_axes():
    arr = np.zeros((2, 3, 4, 5))  # C, Z, Y, X
    out = to_tczyx(arr, "CZYX")
    assert out.shape == (1, 2, 3, 4, 5)  # T inserted as size-1


def test_to_tczyx_collapses_extra_axes():
    arr = np.zeros((2, 4, 5, 3))  # C, Y, X, S(amples/RGB)
    out = to_tczyx(arr, "CYXS")
    assert out.shape == (1, 2, 1, 4, 5)  # S collapsed to index 0; T,Z inserted


def test_to_tczyx_preserves_values_after_reorder():
    arr = np.arange(2 * 2 * 2).reshape(2, 2, 2)  # C, Y, X
    out = to_tczyx(arr, "CYX")
    assert out.shape == (1, 2, 1, 2, 2)
    for c in range(2):
        for y in range(2):
            for x in range(2):
                assert out[0, c, 0, y, x] == arr[c, y, x]


def test_to_tczyx_rejects_axis_count_mismatch():
    with pytest.raises(ValueError):
        _ = to_tczyx(np.zeros((2, 3)), "CZYX")


def test_to_tczyx_rejects_empty_axis():
    with pytest.raises(ValueError, match="empty axis"):
        _ = to_tczyx(np.zeros((0, 4, 5)), "CYX")


def test_canonical_axis_order():
    assert CANON_AXES == "TCZYX"


def test_supported_extensions_separate_native_readers_from_external_converter():
    assert NATIVE_READER_EXTENSIONS == (".nd2", ".czi", ".lif")
    assert EXTERNAL_CONVERT_EXTENSIONS == (".oib", ".oif", ".lsm")
    assert SUPPORTED_EXTENSIONS == (*NATIVE_READER_EXTENSIONS, *EXTERNAL_CONVERT_EXTENSIONS)


def test_read_rejects_unsupported_extension():
    with pytest.raises(ValueError):
        _ = read_normalized_stack("/tmp/sample.tiff")


def test_external_converter_formats_require_config(monkeypatch):
    monkeypatch.delenv("VOXELLAB_BFCONVERT", raising=False)

    with pytest.raises(ImportError):
        _ = read_normalized_stack("/tmp/sample.oib")
    with pytest.raises(ImportError):
        _ = convert_to_ome_tiff("/tmp/sample.oib", "/tmp/out.ome.tiff")


@pytest.mark.skipif(
    importlib.util.find_spec("czifile") is not None,
    reason="czifile installed; the missing-reader path cannot be exercised",
)
def test_wired_format_fails_closed_without_its_reader():
    # .czi is wired, but when its optional BSD reader is not installed the primitive fails
    # closed with an install hint rather than a vague error.
    with pytest.raises(ImportError):
        _ = read_normalized_stack("/tmp/sample.czi")


def test_czi_reader_reports_empty_scene_container(monkeypatch):
    class EmptyCziFile:
        scenes = {}

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    monkeypatch.setitem(sys.modules, "czifile", types.SimpleNamespace(CziFile=lambda _path: EmptyCziFile()))

    with pytest.raises(ValueError, match="CZI file contains no scenes"):
        _ = read_normalized_stack("/tmp/sample.czi")


def test_convert_rejects_unsupported_extension():
    with pytest.raises(ValueError):
        _ = convert_to_ome_tiff("/tmp/sample.png", "/tmp/out.ome.tiff")


def test_external_converter_writes_ome_tiff(monkeypatch, tmp_path):
    converter = tmp_path / "fake-bfconvert.py"
    converter.write_text(
        """#!/usr/bin/env python3
import pathlib, sys
pathlib.Path(sys.argv[2]).write_bytes(b'II*\\x00ome-tiff')
""",
        encoding="utf-8",
    )
    converter.chmod(0o755)
    source = tmp_path / "sample.lsm"
    source.write_bytes(b"lsm")
    output = tmp_path / "out.ome.tiff"
    monkeypatch.setenv("VOXELLAB_BFCONVERT", str(converter))

    assert convert_to_ome_tiff(str(source), str(output)) == str(output)
    assert output.read_bytes() == b"II*\x00ome-tiff"


def test_external_converter_rejects_empty_ome_tiff(monkeypatch, tmp_path):
    converter = tmp_path / "fake-empty-bfconvert.py"
    converter.write_text(
        """#!/usr/bin/env python3
import pathlib, sys
pathlib.Path(sys.argv[2]).write_bytes(b'')
""",
        encoding="utf-8",
    )
    converter.chmod(0o755)
    source = tmp_path / "sample.oib"
    source.write_bytes(b"oib")
    monkeypatch.setenv("VOXELLAB_BFCONVERT", str(converter))

    with pytest.raises(RuntimeError, match="did not write an output OME-TIFF"):
        _ = convert_to_ome_tiff(str(source), str(tmp_path / "empty.ome.tiff"))


def test_external_converter_rejects_non_tiff_output(monkeypatch, tmp_path):
    converter = tmp_path / "fake-text-bfconvert.py"
    converter.write_text(
        """#!/usr/bin/env python3
import pathlib, sys
pathlib.Path(sys.argv[2]).write_bytes(b'not a tiff')
""",
        encoding="utf-8",
    )
    converter.chmod(0o755)
    source = tmp_path / "sample.oif"
    source.write_bytes(b"oif")
    monkeypatch.setenv("VOXELLAB_BFCONVERT", str(converter))

    with pytest.raises(RuntimeError, match="did not write a TIFF/OME-TIFF file"):
        _ = convert_to_ome_tiff(str(source), str(tmp_path / "text.ome.tiff"))


def test_external_converter_failure_detail_is_bounded(monkeypatch, tmp_path):
    converter = tmp_path / "fake-noisy-bfconvert.py"
    converter.write_text(
        "#!/usr/bin/env python3\nimport sys\nsys.stderr.write('x' * 5000)\nsys.exit(2)\n",
        encoding="utf-8",
    )
    converter.chmod(0o755)
    source = tmp_path / "sample.lsm"
    source.write_bytes(b"lsm")
    monkeypatch.setenv("VOXELLAB_BFCONVERT", str(converter))

    with pytest.raises(RuntimeError) as exc_info:
        _ = convert_to_ome_tiff(str(source), str(tmp_path / "out.ome.tiff"))

    message = str(exc_info.value)
    assert message.startswith("external microscopy converter failed: ")
    assert len(message) <= len("external microscopy converter failed: ") + MAX_CONVERTER_ERROR_DETAIL_CHARS + 3


def test_external_converter_timeout_reports_conversion_error(monkeypatch, tmp_path):
    converter = tmp_path / "fake-slow-bfconvert.py"
    converter.write_text("#!/usr/bin/env python3\n", encoding="utf-8")
    converter.chmod(0o755)
    source = tmp_path / "sample.lsm"
    source.write_bytes(b"lsm")
    monkeypatch.setenv("VOXELLAB_BFCONVERT", str(converter))

    def fake_run(*_args, **_kwargs):
        raise subprocess.TimeoutExpired(cmd=[str(converter)], timeout=300)

    monkeypatch.setattr(subprocess, "run", fake_run)

    with pytest.raises(RuntimeError, match="timed out after 300 seconds"):
        _ = convert_to_ome_tiff(str(source), str(tmp_path / "out.ome.tiff"))


def test_external_converter_requires_absolute_executable(monkeypatch, tmp_path):
    source = tmp_path / "sample.oif"
    source.write_bytes(b"oif")
    monkeypatch.setenv("VOXELLAB_BFCONVERT", "bfconvert")

    with pytest.raises(ImportError):
        _ = convert_to_ome_tiff(str(source), str(tmp_path / "out.ome.tiff"))


def test_normalized_stack_defaults():
    s = NormalizedStack(data=np.zeros((1, 1, 1, 2, 2)))
    assert s.channel_names == []
    assert s.physical_size_x is None
    assert s.source_format == ""
