"""Microscopy vendor bridge → OME-TIFF for the browser microscopy import path.

Native CZI/ND2/LIF parsing leans on permissive BSD pure-Python readers (nd2, czifile,
liffile). OIB/OIF/LSM and optionally native-reader misses can use a configured external
OME-TIFF converter. Every vendor format then flows through the same browser OME-TIFF →
dataset-model → measurement/analysis path as a plain OME-TIFF.

Readers are optional and imported lazily: `pip install voxellab-tooling[microscopy]`.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from math import prod

CANON_AXES = "TCZYX"
NATIVE_READER_EXTENSIONS = (".nd2", ".czi", ".lif")
EXTERNAL_CONVERT_EXTENSIONS = (".oib", ".oif", ".lsm")
SUPPORTED_EXTENSIONS = (*NATIVE_READER_EXTENSIONS, *EXTERNAL_CONVERT_EXTENSIONS)
EXTERNAL_CONVERTER_ENV = "VOXELLAB_BFCONVERT"
TIFF_SIGNATURES = (b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+")
MAX_CONVERTER_ERROR_DETAIL_CHARS = 1000
MAX_NATIVE_SERIES_PARTS = 64
MAX_NATIVE_DECODED_STACK_BYTES = 512 * 1024 * 1024
MAX_CONVERTED_PART_BYTES = 512 * 1024 * 1024
MAX_CONVERTED_TOTAL_BYTES = 512 * 1024 * 1024

REASON_CONVERTER_NOT_CONFIGURED = "converter_not_configured"
REASON_CONVERTER_PATH_NOT_ABSOLUTE = "converter_path_not_absolute"
REASON_CONVERTER_PATH_MISSING = "converter_path_missing"
REASON_CONVERTER_PATH_NOT_EXECUTABLE = "converter_path_not_executable"
REASON_OPTIONAL_PYTHON_READER_MISSING = "optional_python_reader_missing"
REASON_EXTERNAL_PROCESS_FAILURE = "external_process_failure"
REASON_UNSUPPORTED_FORMAT = "unsupported_format"
REASON_EXTERNAL_SPLIT_UNSUPPORTED = "external_converter_multiscene_unsupported"
REASON_UNSUPPORTED_MULTISERIES_AXIS = "unsupported_multiseries_axis"
REASON_TOO_MANY_NATIVE_SERIES = "too_many_native_series"
REASON_CONVERSION_RESOURCE_LIMIT = "conversion_resource_limit"


class MicroscopyConversionError(Exception):
    """Conversion failure with a stable reason for the local upload API."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


class MicroscopyConverterSetupError(MicroscopyConversionError, ImportError):
    pass


class MicroscopyOptionalReaderError(MicroscopyConversionError, ImportError):
    pass


class MicroscopyExternalProcessError(MicroscopyConversionError, RuntimeError):
    pass


class MicroscopyUnsupportedFormatError(MicroscopyConversionError, ValueError):
    pass


class MicroscopySplitModeError(MicroscopyConversionError, ValueError):
    pass


class MicroscopyResourceLimitError(MicroscopyConversionError, ValueError):
    pass


@dataclass
class NormalizedStack:
    """Vendor-agnostic intermediate: a TCZYX array plus the calibration we can trust."""
    data: object  # numpy.ndarray, axis order == CANON_AXES
    physical_size_x: float | None = None  # micrometers/pixel
    physical_size_y: float | None = None
    physical_size_z: float | None = None
    channel_names: list[str] = field(default_factory=list)
    source_format: str = ""
    warnings: list[str] = field(default_factory=list)


@dataclass
class ConversionResult:
    output_path: str
    warnings: list[str] = field(default_factory=list)
    part_id: str = ""
    file_name: str = ""


@dataclass(frozen=True)
class NativeSeriesUnit:
    part_id: str
    label: str
    source_format: str
    selection: tuple[tuple[str, int], ...] = ()
    file_token: str = "series"


def to_tczyx(arr, axes):
    """Reorder/normalize an array with arbitrary labelled `axes` (e.g. 'CZYX', 'TCZYXS') into
    canonical TCZYX. Axes outside TCZYX (block/scene/sample/RGB dims) collapse to index 0;
    missing axes become size-1. Pure (numpy only), so it is unit-tested without any reader."""
    import numpy as np

    axes = list(axes)
    if len(axes) != getattr(arr, "ndim", len(axes)):
        raise ValueError(f"axes {axes!r} do not match array with {arr.ndim} dims")
    slicer = []
    present = []
    for ax in axes:
        if ax in CANON_AXES:
            slicer.append(slice(None))
            present.append(ax)
        else:
            slicer.append(0)  # collapse non-spatial/non-channel/non-time dims
    a = arr[tuple(slicer)]
    for ax in CANON_AXES:
        if ax not in present:
            a = np.expand_dims(a, 0)
            present.insert(0, ax)
    order = [present.index(ax) for ax in CANON_AXES]
    normalized = np.transpose(a, order)
    if any(size <= 0 for size in normalized.shape):
        raise ValueError("microscopy stack contains an empty axis")
    return normalized


def _strict_selected_tczyx(arr, axes, selection=()):
    """Select declared scene axes, reject every other non-singleton extra axis, then normalize."""
    axes = [str(axis).upper() for axis in axes]
    if len(axes) != getattr(arr, "ndim", len(axes)):
        raise ValueError(f"axes {axes!r} do not match array with {arr.ndim} dims")
    selected = dict(selection)
    slicer = []
    retained_axes = []
    for index, axis in enumerate(axes):
        size = int(arr.shape[index])
        if axis in selected:
            selected_index = int(selected.pop(axis))
            if selected_index < 0 or selected_index >= size:
                raise ValueError(f"axis {axis} selection {selected_index} is outside size {size}")
            slicer.append(selected_index)
        elif axis in CANON_AXES:
            slicer.append(slice(None))
            retained_axes.append(axis)
        elif size == 1:
            slicer.append(0)
        else:
            raise MicroscopySplitModeError(
                REASON_UNSUPPORTED_MULTISERIES_AXIS,
                f"native microscopy axis {axis} has size {size}; split-mode does not know how to preserve it",
            )
    if selected:
        missing = ", ".join(sorted(selected))
        raise ValueError(f"native microscopy selection references missing axes: {missing}")
    return to_tczyx(arr[tuple(slicer)], retained_axes)


def _assert_supported_extra_axes(sizes, allowed=()):
    allowed_axes = {str(axis).upper() for axis in allowed}
    for raw_axis, raw_size in dict(sizes).items():
        axis = str(raw_axis).upper()
        size = int(raw_size)
        if axis in CANON_AXES or axis in allowed_axes or size == 1:
            continue
        raise MicroscopySplitModeError(
            REASON_UNSUPPORTED_MULTISERIES_AXIS,
            f"native microscopy axis {axis} has size {size}; split-mode does not know how to preserve it",
        )


def _bounded_native_units(units):
    units = list(units)
    if not units:
        raise ValueError("native microscopy file contains no image series")
    _ensure_native_series_count(len(units))
    return units


def _ensure_native_series_count(count: int) -> None:
    if count > MAX_NATIVE_SERIES_PARTS:
        raise MicroscopyResourceLimitError(
            REASON_TOO_MANY_NATIVE_SERIES,
            f"native microscopy file contains {count} independent series; the limit is {MAX_NATIVE_SERIES_PARTS}",
        )


def _list_nd2_units(path):
    import nd2

    with nd2.ND2File(path) as f:
        sizes = dict(f.sizes)
        _assert_supported_extra_axes(sizes, {"P"})
        count = max(1, int(sizes.get("P", 1)))
        _ensure_native_series_count(count)
    return _bounded_native_units([
        NativeSeriesUnit(
            part_id=f"nd2-position-{index}",
            label=f"Position {index + 1} of {count}",
            source_format="ND2",
            selection=(("P", index),) if "P" in sizes else (),
            file_token=f"position-{index + 1:03d}",
        )
        for index in range(count)
    ])


def _list_czi_units(path):
    import czifile

    with czifile.CziFile(path) as f:
        scenes = list((getattr(f, "scenes", None) or {}).values())
        if not scenes:
            raise ValueError("CZI file contains no scenes")
        _ensure_native_series_count(len(scenes))
        units = []
        for index, image in enumerate(scenes):
            sizes = dict(getattr(image, "sizes", {}) or zip(image.axes, image.shape))
            _assert_supported_extra_axes(sizes)
            name = str(getattr(image, "name", "") or f"Scene {index + 1}")
            units.append(NativeSeriesUnit(
                part_id=f"czi-scene-{index}",
                label=f"Scene {index + 1} of {len(scenes)} · {name}",
                source_format="CZI",
                selection=(("scene", index),),
                file_token=f"scene-{index + 1:03d}",
            ))
    return _bounded_native_units(units)


def _list_lif_units(path):
    import liffile

    with liffile.LifFile(path) as lif:
        images = list(lif.images)
        if not images:
            raise ValueError("LIF file contains no images")
        units = []
        for image_index, image in enumerate(images):
            sizes = {str(axis).upper(): int(size) for axis, size in dict(image.sizes).items()}
            _assert_supported_extra_axes(sizes, {"M"})
            position_count = max(1, int(sizes.get("M", 1)))
            _ensure_native_series_count(len(units) + position_count)
            image_name = str(getattr(image, "name", "") or f"Image {image_index + 1}")
            for position_index in range(position_count):
                position_label = (
                    f" · position {position_index + 1} of {position_count}"
                    if position_count > 1 else ""
                )
                position_token = (
                    f"-position-{position_index + 1:03d}"
                    if position_count > 1 else ""
                )
                units.append(NativeSeriesUnit(
                    part_id=f"lif-image-{image_index}-m-{position_index}",
                    label=f"Image {image_index + 1} of {len(images)} · {image_name}{position_label}",
                    source_format="LIF",
                    selection=(
                        (("image", image_index), ("M", position_index))
                        if "M" in sizes else (("image", image_index),)
                    ),
                    file_token=f"image-{image_index + 1:03d}{position_token}",
                ))
    return _bounded_native_units(units)


_UNIT_LISTERS = {
    ".nd2": _list_nd2_units,
    ".czi": _list_czi_units,
    ".lif": _list_lif_units,
}


def list_native_series_units(input_path):
    ext = os.path.splitext(input_path)[1].lower()
    if ext in EXTERNAL_CONVERT_EXTENSIONS:
        raise MicroscopySplitModeError(
            REASON_EXTERNAL_SPLIT_UNSUPPORTED,
            f"split-mode is unavailable for external-converter format {ext}",
        )
    lister = _UNIT_LISTERS.get(ext)
    if lister is None:
        raise MicroscopyUnsupportedFormatError(
            REASON_UNSUPPORTED_FORMAT,
            f"unsupported microscopy format: {ext or '(none)'}",
        )
    try:
        return lister(input_path)
    except ImportError as exc:
        raise MicroscopyOptionalReaderError(
            REASON_OPTIONAL_PYTHON_READER_MISSING,
            f"split-mode for {ext} needs optional Python microscopy readers; install voxellab-tooling[microscopy]",
        ) from exc


def _read_nd2(path):
    import nd2

    with nd2.ND2File(path) as f:
        stack = to_tczyx(f.asarray(), list(f.sizes.keys()))
        voxel = f.voxel_size()  # named tuple (x, y, z) in micrometers
        channels = []
        meta = getattr(f, "metadata", None)
        for ch in getattr(meta, "channels", None) or []:
            name = getattr(getattr(ch, "channel", None), "name", None)
            channels.append(name or f"Channel {len(channels) + 1}")
    return NormalizedStack(
        data=stack,
        physical_size_x=_positive(getattr(voxel, "x", None)),
        physical_size_y=_positive(getattr(voxel, "y", None)),
        physical_size_z=_positive(getattr(voxel, "z", None)),
        channel_names=channels,
        source_format="ND2",
    )


def _positive(value):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if v > 0 else None


def _read_czi(path):
    # czifile API traced to czifile==2026.4.30 (CziFile.scenes → CziImage.asarray/.axes;
    # physical sizes from Scaling/Items/Distance XML in meters; channel names from the
    # Information/Image Channels XML). The 2026 API differs from czifile ≤2019.
    import czifile

    with czifile.CziFile(path) as f:
        scenes = getattr(f, "scenes", None) or {}
        if not scenes:
            raise ValueError("CZI file contains no scenes")
        warnings = []
        scene_count = len(scenes)
        if scene_count > 1:
            warnings.append(f"CZI contains {scene_count} scenes; only the first scene was imported.")
        image = next(iter(scenes.values()))
        stack = to_tczyx(image.asarray(), image.axes)
        try:
            root = f.xml_element
        except Exception:
            root = None
        size_x = size_y = size_z = None
        channels = []
        if root is not None:
            scale_m = {}
            for dist in root.findall(".//Scaling/Items/Distance"):
                axis = dist.get("Id")
                value = dist.findtext("Value")
                if axis and value:
                    try:
                        scale_m[axis] = float(value)
                    except ValueError:
                        pass
            size_x = _positive(scale_m["X"] * 1e6) if "X" in scale_m else None
            size_y = _positive(scale_m["Y"] * 1e6) if "Y" in scale_m else None
            size_z = _positive(scale_m["Z"] * 1e6) if "Z" in scale_m else None
            for ch in root.findall(".//Information/Image/Dimensions/Channels/Channel"):
                name = ch.get("Name") or ch.findtext("Name")
                channels.append(name or f"Channel {len(channels) + 1}")
    return NormalizedStack(
        data=stack,
        physical_size_x=size_x,
        physical_size_y=size_y,
        physical_size_z=size_z,
        channel_names=channels,
        source_format="CZI",
        warnings=warnings,
    )


def _read_lif(path):
    # liffile API traced to liffile==2026.4.11 (LifFile.images[0].asarray/.dims; per-axis
    # physical spacing from coords[label] linspace in meters; channel names from coords['C']).
    # v1 reads the first image/series only — a LIF can hold many independent series.
    import liffile

    with liffile.LifFile(path) as lif:
        images = lif.images
        if len(images) == 0:
            raise ValueError("LIF file contains no images")
        warnings = []
        if len(images) > 1:
            warnings.append(f"LIF contains {len(images)} images; only the first image was imported.")
        image = images[0]
        stack = to_tczyx(image.asarray(), list(image.dims))
        coords = getattr(image, "coords", None) or {}

        def um_per_px(label):
            arr = coords.get(label)
            if arr is None or getattr(arr, "size", 0) < 2:
                return None
            return _positive(float(arr[1] - arr[0]) * 1e6)

        c_names = coords.get("C")
        channels = [str(n) for n in c_names] if c_names is not None else []
        return NormalizedStack(
            data=stack,
            physical_size_x=um_per_px("X"),
            physical_size_y=um_per_px("Y"),
            physical_size_z=um_per_px("Z"),
            channel_names=channels,
            source_format="LIF",
            warnings=warnings,
        )


def _bounded_stack(stack: NormalizedStack) -> NormalizedStack:
    decoded_bytes = int(getattr(stack.data, "nbytes", 0) or 0)
    _ensure_native_decoded_bytes(decoded_bytes)
    return stack


def _ensure_native_decoded_bytes(decoded_bytes: int) -> None:
    if decoded_bytes > MAX_NATIVE_DECODED_STACK_BYTES:
        raise MicroscopyResourceLimitError(
            REASON_CONVERSION_RESOURCE_LIMIT,
            f"decoded native series needs {decoded_bytes} bytes; the limit is {MAX_NATIVE_DECODED_STACK_BYTES}",
        )


def _read_nd2_unit(path, unit: NativeSeriesUnit):
    import nd2

    selection = dict(unit.selection)
    position = selection.get("P")
    with nd2.ND2File(path) as f:
        position_count = max(1, int(f.sizes.get("P", 1)))
        _ensure_native_decoded_bytes(int(getattr(f, "nbytes", 0) or 0) // position_count)
        source = f.asarray(position=position) if position is not None else f.asarray()
        array_selection = (("P", 0),) if "P" in f.sizes else ()
        stack = _strict_selected_tczyx(source, list(f.sizes.keys()), array_selection)
        voxel = f.voxel_size()
        channels = []
        meta = getattr(f, "metadata", None)
        for ch in getattr(meta, "channels", None) or []:
            name = getattr(getattr(ch, "channel", None), "name", None)
            channels.append(name or f"Channel {len(channels) + 1}")
    return _bounded_stack(NormalizedStack(
        data=stack,
        physical_size_x=_positive(getattr(voxel, "x", None)),
        physical_size_y=_positive(getattr(voxel, "y", None)),
        physical_size_z=_positive(getattr(voxel, "z", None)),
        channel_names=channels,
        source_format="ND2",
    ))


def _read_czi_unit(path, unit: NativeSeriesUnit):
    import czifile

    selection = dict(unit.selection)
    scene_index = int(selection.pop("scene"))
    with czifile.CziFile(path) as f:
        scenes = list((getattr(f, "scenes", None) or {}).values())
        if scene_index < 0 or scene_index >= len(scenes):
            raise ValueError(f"CZI scene index {scene_index} is outside the file scene count")
        image = scenes[scene_index]
        _ensure_native_decoded_bytes(int(getattr(image, "nbytes", 0) or 0))
        stack = _strict_selected_tczyx(image.asarray(), image.axes, selection.items())
        try:
            root = f.xml_element
        except Exception:
            root = None
        size_x = size_y = size_z = None
        channels = []
        if root is not None:
            scale_m = {}
            for dist in root.findall(".//Scaling/Items/Distance"):
                axis = dist.get("Id")
                value = dist.findtext("Value")
                if axis and value:
                    try:
                        scale_m[axis] = float(value)
                    except ValueError:
                        pass
            size_x = _positive(scale_m["X"] * 1e6) if "X" in scale_m else None
            size_y = _positive(scale_m["Y"] * 1e6) if "Y" in scale_m else None
            size_z = _positive(scale_m["Z"] * 1e6) if "Z" in scale_m else None
            for ch in root.findall(".//Information/Image/Dimensions/Channels/Channel"):
                name = ch.get("Name") or ch.findtext("Name")
                channels.append(name or f"Channel {len(channels) + 1}")
    return _bounded_stack(NormalizedStack(
        data=stack,
        physical_size_x=size_x,
        physical_size_y=size_y,
        physical_size_z=size_z,
        channel_names=channels,
        source_format="CZI",
    ))


def _read_lif_unit(path, unit: NativeSeriesUnit):
    import liffile

    selection = dict(unit.selection)
    image_index = int(selection.pop("image"))
    with liffile.LifFile(path) as lif:
        images = lif.images
        if image_index < 0 or image_index >= len(images):
            raise ValueError(f"LIF image index {image_index} is outside the file image count")
        image = images[image_index]
        position_index = selection.pop("M", None)
        if position_index is not None:
            selected = image.frames(M=position_index)
            estimated_bytes = prod(int(size) for size in selected.shape) * int(selected.dtype.itemsize)
            _ensure_native_decoded_bytes(estimated_bytes)
            stack = _strict_selected_tczyx(selected.asarray(), list(selected.dims), selection.items())
            coords = getattr(selected, "coords", None) or {}
        else:
            estimated_bytes = int(getattr(image, "nbytes", 0) or 0)
            _ensure_native_decoded_bytes(estimated_bytes)
            stack = _strict_selected_tczyx(image.asarray(), list(image.dims), selection.items())
            coords = getattr(image, "coords", None) or {}

        def um_per_px(label):
            arr = coords.get(label)
            if arr is None or getattr(arr, "size", 0) < 2:
                return None
            return _positive(float(arr[1] - arr[0]) * 1e6)

        c_names = coords.get("C")
        channels = [str(name) for name in c_names] if c_names is not None else []
    return _bounded_stack(NormalizedStack(
        data=stack,
        physical_size_x=um_per_px("X"),
        physical_size_y=um_per_px("Y"),
        physical_size_z=um_per_px("Z"),
        channel_names=channels,
        source_format="LIF",
    ))


_UNIT_READERS = {
    ".nd2": _read_nd2_unit,
    ".czi": _read_czi_unit,
    ".lif": _read_lif_unit,
}


def read_native_series_unit(input_path, unit: NativeSeriesUnit):
    ext = os.path.splitext(input_path)[1].lower()
    reader = _UNIT_READERS.get(ext)
    if reader is None:
        raise MicroscopySplitModeError(
            REASON_EXTERNAL_SPLIT_UNSUPPORTED,
            f"split-mode is unavailable for external-converter format {ext or '(none)'}",
        )
    try:
        return reader(input_path, unit)
    except ImportError as exc:
        raise MicroscopyOptionalReaderError(
            REASON_OPTIONAL_PYTHON_READER_MISSING,
            f"split-mode for {ext} needs optional Python microscopy readers; install voxellab-tooling[microscopy]",
        ) from exc


_READERS = {
    ".nd2": _read_nd2,
    ".czi": _read_czi,
    ".lif": _read_lif,
}


def _external_converter_command(env=os.environ):
    command = (env.get(EXTERNAL_CONVERTER_ENV) or "").strip()
    if not command:
        raise MicroscopyConverterSetupError(
            REASON_CONVERTER_NOT_CONFIGURED,
            f"{EXTERNAL_CONVERTER_ENV} is not configured; set it to an external OME-TIFF converter executable",
        )
    if not os.path.isabs(command):
        raise MicroscopyConverterSetupError(
            REASON_CONVERTER_PATH_NOT_ABSOLUTE,
            f"{EXTERNAL_CONVERTER_ENV} must be an absolute executable path",
        )
    if not os.path.exists(command):
        raise MicroscopyConverterSetupError(
            REASON_CONVERTER_PATH_MISSING,
            f"{EXTERNAL_CONVERTER_ENV} path does not exist: {command}",
        )
    if not os.path.isfile(command) or not os.access(command, os.X_OK):
        raise MicroscopyConverterSetupError(
            REASON_CONVERTER_PATH_NOT_EXECUTABLE,
            f"{EXTERNAL_CONVERTER_ENV} is not an executable file: {command}",
        )
    return command


def _convert_external_to_ome_tiff(input_path, out_path, env=os.environ):
    command = _external_converter_command(env)
    try:
        result = subprocess.run(
            [command, input_path, out_path],
            check=False,
            capture_output=True,
            text=True,
            timeout=300,
        )
    except subprocess.TimeoutExpired as exc:
        raise MicroscopyExternalProcessError(
            REASON_EXTERNAL_PROCESS_FAILURE,
            "external microscopy converter timed out after 300 seconds",
        ) from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        if len(detail) > MAX_CONVERTER_ERROR_DETAIL_CHARS:
            detail = f"{detail[:MAX_CONVERTER_ERROR_DETAIL_CHARS]}..."
        if detail:
            print(f"[microscopy-converter] external process failed: {detail}", file=sys.stderr)
        raise MicroscopyExternalProcessError(
            REASON_EXTERNAL_PROCESS_FAILURE,
            "external microscopy converter failed; check the local server log for converter output",
        )
    if not os.path.isfile(out_path) or os.path.getsize(out_path) <= 0:
        raise MicroscopyExternalProcessError(
            REASON_EXTERNAL_PROCESS_FAILURE,
            "external microscopy converter did not write an output OME-TIFF",
        )
    with open(out_path, "rb") as output:
        if output.read(4) not in TIFF_SIGNATURES:
            raise MicroscopyExternalProcessError(
                REASON_EXTERNAL_PROCESS_FAILURE,
                "external microscopy converter did not write a TIFF/OME-TIFF file",
            )
    return out_path


def read_normalized_stack(input_path):
    ext = os.path.splitext(input_path)[1].lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise MicroscopyUnsupportedFormatError(
            REASON_UNSUPPORTED_FORMAT,
            f"unsupported microscopy format: {ext or '(none)'}",
        )
    reader = _READERS.get(ext)
    if reader is None:
        raise MicroscopyConverterSetupError(
            REASON_CONVERTER_NOT_CONFIGURED,
            f"reading {ext} needs {EXTERNAL_CONVERTER_ENV} set to an external converter",
        )
    try:
        return reader(input_path)
    except ImportError as exc:  # the optional BSD reader is not installed
        raise MicroscopyOptionalReaderError(
            REASON_OPTIONAL_PYTHON_READER_MISSING,
            f"reading {ext} needs optional Python microscopy readers; install voxellab-tooling[microscopy] or configure {EXTERNAL_CONVERTER_ENV}",
        ) from exc


def write_ome_tiff(stack: NormalizedStack, out_path):
    """Write the normalized stack as a calibrated OME-TIFF the browser import path consumes.
    Physical sizes are only emitted when known — unknown calibration stays unknown (never
    invented), matching the viewer's fail-closed accuracy contract."""
    import tifffile

    metadata = {"axes": CANON_AXES}
    if stack.physical_size_x:
        metadata["PhysicalSizeX"] = stack.physical_size_x
        metadata["PhysicalSizeXUnit"] = "µm"
    if stack.physical_size_y:
        metadata["PhysicalSizeY"] = stack.physical_size_y
        metadata["PhysicalSizeYUnit"] = "µm"
    if stack.physical_size_z:
        metadata["PhysicalSizeZ"] = stack.physical_size_z
        metadata["PhysicalSizeZUnit"] = "µm"
    if stack.channel_names:
        metadata["Channel"] = {"Name": stack.channel_names}
    _ = tifffile.imwrite(out_path, stack.data, ome=True, metadata=metadata)
    return out_path


def _converted_source_base(source_name: str, input_path: str) -> str:
    raw_name = os.path.basename(source_name or input_path)
    base = os.path.splitext(raw_name)[0]
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", base).strip("-._")
    return safe[:120] or "microscopy"


def convert_to_ome_tiff_parts(input_path, output_prefix, source_name=""):
    """Convert every supported native scene/position into its own bounded OME-TIFF."""
    units = list_native_series_units(input_path)
    source_base = _converted_source_base(source_name, input_path)
    results = []
    created_paths = []
    total_bytes = 0
    try:
        for index, unit in enumerate(units):
            stack = read_native_series_unit(input_path, unit)
            provenance = f"Converted from {unit.source_format} with the native reader · {unit.label}."
            warnings = [provenance, *(stack.warnings or [])]
            output_path = f"{output_prefix}.part-{index + 1:03d}.ome.tiff"
            _ = write_ome_tiff(stack, output_path)
            created_paths.append(output_path)
            part_bytes = os.path.getsize(output_path)
            if part_bytes <= 0 or part_bytes > MAX_CONVERTED_PART_BYTES:
                raise MicroscopyResourceLimitError(
                    REASON_CONVERSION_RESOURCE_LIMIT,
                    f"converted native series needs {part_bytes} bytes; the per-series limit is {MAX_CONVERTED_PART_BYTES}",
                )
            total_bytes += part_bytes
            if total_bytes > MAX_CONVERTED_TOTAL_BYTES:
                raise MicroscopyResourceLimitError(
                    REASON_CONVERSION_RESOURCE_LIMIT,
                    f"converted native series need {total_bytes} bytes; the aggregate limit is {MAX_CONVERTED_TOTAL_BYTES}",
                )
            results.append(ConversionResult(
                output_path=output_path,
                warnings=warnings,
                part_id=unit.part_id,
                file_name=f"{source_base}--{unit.file_token}.ome.tiff",
            ))
    except Exception:
        for output_path in created_paths:
            if output_path and os.path.exists(output_path):
                try:
                    os.unlink(output_path)
                except OSError:
                    pass
        raise
    return results


def convert_to_ome_tiff_with_result(input_path, out_path):
    """Native vendor file → normalized calibrated OME-TIFF plus conversion warnings."""
    ext = os.path.splitext(input_path)[1].lower()
    if ext in EXTERNAL_CONVERT_EXTENSIONS:
        return ConversionResult(_convert_external_to_ome_tiff(input_path, out_path), [])
    try:
        stack = read_normalized_stack(input_path)
    except ImportError:
        if ext in NATIVE_READER_EXTENSIONS and (os.environ.get(EXTERNAL_CONVERTER_ENV) or "").strip():
            return ConversionResult(_convert_external_to_ome_tiff(input_path, out_path), [])
        raise
    return ConversionResult(write_ome_tiff(stack, out_path), list(stack.warnings or []))
