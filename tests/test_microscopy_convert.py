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

import microscopy_convert
from microscopy_convert import (
    CANON_AXES,
    EXTERNAL_CONVERT_EXTENSIONS,
    MAX_CONVERTER_ERROR_DETAIL_CHARS,
    MAX_NATIVE_SERIES_PARTS,
    NATIVE_READER_EXTENSIONS,
    NativeSeriesUnit,
    NormalizedStack,
    REASON_CONVERTER_NOT_CONFIGURED,
    REASON_CONVERTER_PATH_MISSING,
    REASON_CONVERTER_PATH_NOT_EXECUTABLE,
    REASON_CONVERSION_RESOURCE_LIMIT,
    REASON_EXTERNAL_PROCESS_FAILURE,
    REASON_EXTERNAL_SPLIT_UNSUPPORTED,
    REASON_OPTIONAL_PYTHON_READER_MISSING,
    REASON_TOO_MANY_NATIVE_SERIES,
    REASON_UNSUPPORTED_MULTISERIES_AXIS,
    REASON_UNSUPPORTED_FORMAT,
    SUPPORTED_EXTENSIONS,
    convert_to_ome_tiff_parts,
    convert_to_ome_tiff_with_result,
    list_native_series_units,
    read_native_series_unit,
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
    with pytest.raises(ValueError) as exc_info:
        _ = read_normalized_stack("/tmp/sample.tiff")
    assert exc_info.value.reason == REASON_UNSUPPORTED_FORMAT


def test_external_converter_formats_require_config(monkeypatch):
    monkeypatch.delenv("VOXELLAB_BFCONVERT", raising=False)

    with pytest.raises(ImportError) as read_error:
        _ = read_normalized_stack("/tmp/sample.oib")
    assert read_error.value.reason == REASON_CONVERTER_NOT_CONFIGURED
    with pytest.raises(ImportError) as convert_error:
        _ = convert_to_ome_tiff_with_result("/tmp/sample.oib", "/tmp/out.ome.tiff")
    assert convert_error.value.reason == REASON_CONVERTER_NOT_CONFIGURED


@pytest.mark.skipif(
    importlib.util.find_spec("czifile") is not None,
    reason="czifile installed; the missing-reader path cannot be exercised",
)
def test_wired_format_fails_closed_without_its_reader():
    # .czi is wired, but when its optional BSD reader is not installed the primitive fails
    # closed with an install hint rather than a vague error.
    with pytest.raises(ImportError) as exc_info:
        _ = read_normalized_stack("/tmp/sample.czi")
    assert exc_info.value.reason == REASON_OPTIONAL_PYTHON_READER_MISSING


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


class FakeCziImage:
    axes = "YX"
    shape = (2, 2)
    sizes = {"Y": 2, "X": 2}

    def __init__(self, value=0, name="Scene"):
        self.value = value
        self.name = name

    def asarray(self):
        return np.full((2, 2), self.value)


class FakeCziFile:
    def __init__(self, scenes):
        self.scenes = scenes

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def test_czi_reader_reports_no_warnings_for_one_scene(monkeypatch):
    scenes = {"Scene 1": FakeCziImage()}
    monkeypatch.setitem(sys.modules, "czifile", types.SimpleNamespace(CziFile=lambda _path: FakeCziFile(scenes)))

    stack = read_normalized_stack("/tmp/sample.czi")

    assert stack.warnings == []


def test_czi_reader_warns_when_multiple_scenes_are_reduced(monkeypatch):
    scenes = {"Scene 1": FakeCziImage(), "Scene 2": FakeCziImage()}
    monkeypatch.setitem(sys.modules, "czifile", types.SimpleNamespace(CziFile=lambda _path: FakeCziFile(scenes)))

    stack = read_normalized_stack("/tmp/sample.czi")

    assert stack.warnings == ["CZI contains 2 scenes; only the first scene was imported."]


def test_split_czi_reader_preserves_every_scene(monkeypatch):
    scenes = {
        "Scene 1": FakeCziImage(11, "Left well"),
        "Scene 2": FakeCziImage(22, "Right well"),
    }
    monkeypatch.setitem(sys.modules, "czifile", types.SimpleNamespace(CziFile=lambda _path: FakeCziFile(scenes)))

    units = list_native_series_units("/tmp/sample.czi")
    stacks = [read_native_series_unit("/tmp/sample.czi", unit) for unit in units]

    assert [unit.part_id for unit in units] == ["czi-scene-0", "czi-scene-1"]
    assert [unit.file_token for unit in units] == ["scene-001", "scene-002"]
    assert [stack.data.shape for stack in stacks] == [(1, 1, 1, 2, 2)] * 2
    assert [int(stack.data[0, 0, 0, 0, 0]) for stack in stacks] == [11, 22]


class FakeLifImage:
    dims = "YX"
    coords = {}

    def asarray(self):
        return np.zeros((2, 2))


class FakeLifFile:
    def __init__(self, images):
        self.images = images

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def test_lif_reader_warns_when_multiple_images_are_reduced(monkeypatch, tmp_path):
    images = [FakeLifImage(), FakeLifImage()]
    monkeypatch.setitem(sys.modules, "liffile", types.SimpleNamespace(LifFile=lambda _path: FakeLifFile(images)))

    stack = read_normalized_stack("/tmp/sample.lif")
    result = convert_to_ome_tiff_with_result("/tmp/sample.lif", str(tmp_path / "out.ome.tiff"))

    assert stack.warnings == ["LIF contains 2 images; only the first image was imported."]
    assert result.warnings == stack.warnings


def test_split_lif_reader_preserves_images_and_m_positions(monkeypatch):
    class SplitLifFrames:
        dims = ("T", "Z", "C", "Y", "X")
        sizes = {"T": 1, "Z": 1, "C": 1, "Y": 2, "X": 2}
        shape = (1, 1, 1, 2, 2)
        dtype = np.dtype(np.uint16)
        coords = {}

        def __init__(self, value):
            self.value = value

        def asarray(self):
            return np.full(self.shape, self.value, dtype=self.dtype)

    class SplitLifImage:
        dims = ("T", "M", "Z", "C", "Y", "X")
        sizes = {"T": 1, "M": 2, "Z": 1, "C": 1, "Y": 2, "X": 2}
        coords = {}

        def __init__(self, base, name):
            self.base = base
            self.name = name

        def frames(self, *, M):
            return SplitLifFrames(self.base + M)

        def asarray(self):
            pytest.fail("split M reads must not materialize the full LIF image")

    images = [SplitLifImage(10, "Image A"), SplitLifImage(20, "Image B")]
    monkeypatch.setitem(sys.modules, "liffile", types.SimpleNamespace(LifFile=lambda _path: FakeLifFile(images)))

    units = list_native_series_units("/tmp/sample.lif")
    stacks = [read_native_series_unit("/tmp/sample.lif", unit) for unit in units]

    assert len(units) == 4
    assert [unit.part_id for unit in units] == [
        "lif-image-0-m-0",
        "lif-image-0-m-1",
        "lif-image-1-m-0",
        "lif-image-1-m-1",
    ]
    assert [int(stack.data[0, 0, 0, 0, 0]) for stack in stacks] == [10, 11, 20, 21]


def test_split_lif_reader_limits_and_decodes_each_m_position_independently(monkeypatch):
    selected_positions = []
    full_asarray_calls = []

    class SelectedFrames:
        dims = ("T", "Z", "C", "Y", "X")
        sizes = {"T": 1, "Z": 1, "C": 1, "Y": 2, "X": 2}
        shape = (1, 1, 1, 2, 2)
        dtype = np.dtype(np.uint16)
        coords = {}

        def __init__(self, position):
            self.position = position

        def asarray(self):
            return np.full(self.shape, 40 + self.position, dtype=self.dtype)

    class MultiPositionImage:
        dims = ("T", "M", "Z", "C", "Y", "X")
        sizes = {"T": 1, "M": 2, "Z": 1, "C": 1, "Y": 2, "X": 2}
        nbytes = 16
        name = "Positions"

        def frames(self, *, M):
            selected_positions.append(M)
            return SelectedFrames(M)

        def asarray(self):
            full_asarray_calls.append(True)
            pytest.fail("split M reads must not materialize the aggregate LIF image")

    monkeypatch.setitem(
        sys.modules,
        "liffile",
        types.SimpleNamespace(LifFile=lambda _path: FakeLifFile([MultiPositionImage()])),
    )
    monkeypatch.setattr(microscopy_convert, "MAX_NATIVE_DECODED_STACK_BYTES", 10)

    units = list_native_series_units("/tmp/sample.lif")
    stacks = [read_native_series_unit("/tmp/sample.lif", unit) for unit in units]

    assert [int(stack.data[0, 0, 0, 0, 0]) for stack in stacks] == [40, 41]
    assert selected_positions == [0, 1]
    assert full_asarray_calls == []


def test_split_nd2_reader_preserves_every_position(monkeypatch):
    class FakeNd2File:
        sizes = {"P": 2, "Y": 2, "X": 2}
        metadata = types.SimpleNamespace(channels=[])

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def asarray(self, position=None):
            assert position in {0, 1}
            return np.full((1, 2, 2), 30 + position, dtype=np.uint16)

        def voxel_size(self):
            return types.SimpleNamespace(x=1, y=2, z=3)

    monkeypatch.setitem(sys.modules, "nd2", types.SimpleNamespace(ND2File=lambda _path: FakeNd2File()))

    units = list_native_series_units("/tmp/sample.nd2")
    stacks = [read_native_series_unit("/tmp/sample.nd2", unit) for unit in units]

    assert [unit.part_id for unit in units] == ["nd2-position-0", "nd2-position-1"]
    assert [int(stack.data[0, 0, 0, 0, 0]) for stack in stacks] == [30, 31]


def test_split_reader_rejects_unknown_non_singleton_axis(monkeypatch):
    image = FakeCziImage()
    image.axes = "QYX"
    image.shape = (2, 2, 2)
    image.sizes = {"Q": 2, "Y": 2, "X": 2}
    monkeypatch.setitem(
        sys.modules,
        "czifile",
        types.SimpleNamespace(CziFile=lambda _path: FakeCziFile({"Scene 1": image})),
    )

    with pytest.raises(ValueError) as exc_info:
        _ = list_native_series_units("/tmp/sample.czi")
    assert exc_info.value.reason == REASON_UNSUPPORTED_MULTISERIES_AXIS


def test_split_reader_rejects_oversized_scene_before_materializing_pixels(monkeypatch):
    image = FakeCziImage()
    image.nbytes = 11
    image.asarray = lambda: pytest.fail("oversized CZI scene should not be materialized")
    monkeypatch.setitem(
        sys.modules,
        "czifile",
        types.SimpleNamespace(CziFile=lambda _path: FakeCziFile({"Scene 1": image})),
    )
    monkeypatch.setattr(microscopy_convert, "MAX_NATIVE_DECODED_STACK_BYTES", 10)
    unit = list_native_series_units("/tmp/sample.czi")[0]

    with pytest.raises(ValueError) as exc_info:
        _ = read_native_series_unit("/tmp/sample.czi", unit)
    assert exc_info.value.reason == REASON_CONVERSION_RESOURCE_LIMIT


def test_split_reader_caps_independent_series(monkeypatch):
    class ManyPositionNd2:
        sizes = {"P": MAX_NATIVE_SERIES_PARTS + 1, "Y": 1, "X": 1}

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    monkeypatch.setitem(sys.modules, "nd2", types.SimpleNamespace(ND2File=lambda _path: ManyPositionNd2()))

    with pytest.raises(ValueError) as exc_info:
        _ = list_native_series_units("/tmp/sample.nd2")
    assert exc_info.value.reason == REASON_TOO_MANY_NATIVE_SERIES


def test_split_mode_rejects_external_only_formats():
    with pytest.raises(ValueError) as exc_info:
        _ = list_native_series_units("/tmp/sample.oib")
    assert exc_info.value.reason == REASON_EXTERNAL_SPLIT_UNSUPPORTED


@pytest.mark.parametrize(
    ("part_limit", "total_limit"),
    [(5, 20), (10, 10)],
    ids=["per-part", "aggregate"],
)
def test_split_conversion_caps_output_and_cleans_parts(monkeypatch, tmp_path, part_limit, total_limit):
    units = [
        NativeSeriesUnit("czi-scene-0", "Scene 1 of 2", "CZI", file_token="scene-001"),
        NativeSeriesUnit("czi-scene-1", "Scene 2 of 2", "CZI", file_token="scene-002"),
    ]
    monkeypatch.setattr(microscopy_convert, "list_native_series_units", lambda _path: units)
    monkeypatch.setattr(
        microscopy_convert,
        "read_native_series_unit",
        lambda _path, _unit: NormalizedStack(np.zeros((1, 1, 1, 1, 1), dtype=np.uint8), source_format="CZI"),
    )

    def fake_write_ome_tiff(_stack, path):
        with open(path, "wb") as output:
            _ = output.write(b"123456")
        return path

    monkeypatch.setattr(microscopy_convert, "write_ome_tiff", fake_write_ome_tiff)
    monkeypatch.setattr(microscopy_convert, "MAX_CONVERTED_PART_BYTES", part_limit)
    monkeypatch.setattr(microscopy_convert, "MAX_CONVERTED_TOTAL_BYTES", total_limit)
    prefix = str(tmp_path / "converted")

    with pytest.raises(ValueError) as exc_info:
        _ = convert_to_ome_tiff_parts("/tmp/sample.czi", prefix, "sample.czi")

    assert exc_info.value.reason == REASON_CONVERSION_RESOURCE_LIMIT
    assert not list(tmp_path.iterdir())


def test_convert_rejects_unsupported_extension():
    with pytest.raises(ValueError):
        _ = convert_to_ome_tiff_with_result("/tmp/sample.png", "/tmp/out.ome.tiff")


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

    assert convert_to_ome_tiff_with_result(str(source), str(output)).output_path == str(output)
    assert output.read_bytes() == b"II*\x00ome-tiff"
    result_output = tmp_path / "out-result.ome.tiff"
    result = convert_to_ome_tiff_with_result(str(source), str(result_output))
    assert result.output_path == str(result_output)
    assert result.warnings == []


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

    with pytest.raises(RuntimeError, match="did not write an output OME-TIFF") as exc_info:
        _ = convert_to_ome_tiff_with_result(str(source), str(tmp_path / "empty.ome.tiff"))
    assert exc_info.value.reason == REASON_EXTERNAL_PROCESS_FAILURE


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
        _ = convert_to_ome_tiff_with_result(str(source), str(tmp_path / "text.ome.tiff"))


def test_external_converter_failure_detail_stays_in_local_log(monkeypatch, tmp_path, capsys):
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
        _ = convert_to_ome_tiff_with_result(str(source), str(tmp_path / "out.ome.tiff"))

    message = str(exc_info.value)
    assert message == "external microscopy converter failed; check the local server log for converter output"
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.startswith("[microscopy-converter] external process failed: ")
    assert len(captured.err) <= len("[microscopy-converter] external process failed: ") + MAX_CONVERTER_ERROR_DETAIL_CHARS + 4


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
        _ = convert_to_ome_tiff_with_result(str(source), str(tmp_path / "out.ome.tiff"))


def test_external_converter_requires_absolute_executable(monkeypatch, tmp_path):
    source = tmp_path / "sample.oif"
    source.write_bytes(b"oif")
    monkeypatch.setenv("VOXELLAB_BFCONVERT", "bfconvert")

    with pytest.raises(ImportError) as exc_info:
        _ = convert_to_ome_tiff_with_result(str(source), str(tmp_path / "out.ome.tiff"))
    assert exc_info.value.reason == "converter_path_not_absolute"


def test_external_converter_reports_missing_and_non_executable_paths(monkeypatch, tmp_path):
    source = tmp_path / "sample.oif"
    source.write_bytes(b"oif")
    missing = tmp_path / "missing-bfconvert"
    monkeypatch.setenv("VOXELLAB_BFCONVERT", str(missing))

    with pytest.raises(ImportError) as missing_error:
        _ = convert_to_ome_tiff_with_result(str(source), str(tmp_path / "missing.ome.tiff"))
    assert missing_error.value.reason == REASON_CONVERTER_PATH_MISSING

    non_executable = tmp_path / "not-executable"
    non_executable.write_text("#!/bin/sh\n", encoding="utf-8")
    monkeypatch.setenv("VOXELLAB_BFCONVERT", str(non_executable))
    with pytest.raises(ImportError) as executable_error:
        _ = convert_to_ome_tiff_with_result(str(source), str(tmp_path / "non-executable.ome.tiff"))
    assert executable_error.value.reason == REASON_CONVERTER_PATH_NOT_EXECUTABLE


def test_normalized_stack_defaults():
    s = NormalizedStack(data=np.zeros((1, 1, 1, 2, 2)))
    assert s.channel_names == []
    assert s.warnings == []
    assert s.physical_size_x is None
    assert s.source_format == ""
