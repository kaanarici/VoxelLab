"""Microscopy vendor bridge → OME-TIFF for the browser microscopy import path.

Native CZI/ND2/LIF parsing leans on permissive BSD pure-Python readers (nd2, czifile,
liffile). OIB/OIF/LSM and optionally native-reader misses can use a configured external
OME-TIFF converter. Every vendor format then flows through the same browser OME-TIFF →
dataset-model → measurement/analysis path as a plain OME-TIFF.

Readers are optional and imported lazily: `pip install voxellab-tooling[microscopy]`.
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass, field

CANON_AXES = "TCZYX"
NATIVE_READER_EXTENSIONS = (".nd2", ".czi", ".lif")
EXTERNAL_CONVERT_EXTENSIONS = (".oib", ".oif", ".lsm")
SUPPORTED_EXTENSIONS = (*NATIVE_READER_EXTENSIONS, *EXTERNAL_CONVERT_EXTENSIONS)
EXTERNAL_CONVERTER_ENV = "VOXELLAB_BFCONVERT"
TIFF_SIGNATURES = (b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+")
MAX_CONVERTER_ERROR_DETAIL_CHARS = 1000


@dataclass
class NormalizedStack:
    """Vendor-agnostic intermediate: a TCZYX array plus the calibration we can trust."""
    data: object  # numpy.ndarray, axis order == CANON_AXES
    physical_size_x: float | None = None  # micrometers/pixel
    physical_size_y: float | None = None
    physical_size_z: float | None = None
    channel_names: list[str] = field(default_factory=list)
    source_format: str = ""


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
        )


_READERS = {
    ".nd2": _read_nd2,
    ".czi": _read_czi,
    ".lif": _read_lif,
}


def _external_converter_command(env=os.environ):
    command = (env.get(EXTERNAL_CONVERTER_ENV) or "").strip()
    if not command:
        raise ImportError(f"reading this microscopy format needs {EXTERNAL_CONVERTER_ENV} set to an external converter")
    if not os.path.isabs(command):
        raise ImportError(f"{EXTERNAL_CONVERTER_ENV} must be an absolute executable path")
    if not os.path.isfile(command) or not os.access(command, os.X_OK):
        raise ImportError(f"{EXTERNAL_CONVERTER_ENV} is not executable: {command}")
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
        raise RuntimeError("external microscopy converter timed out after 300 seconds") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        if len(detail) > MAX_CONVERTER_ERROR_DETAIL_CHARS:
            detail = f"{detail[:MAX_CONVERTER_ERROR_DETAIL_CHARS]}..."
        raise RuntimeError(f"external microscopy converter failed{': ' + detail if detail else ''}")
    if not os.path.isfile(out_path) or os.path.getsize(out_path) <= 0:
        raise RuntimeError("external microscopy converter did not write an output OME-TIFF")
    with open(out_path, "rb") as output:
        if output.read(4) not in TIFF_SIGNATURES:
            raise RuntimeError("external microscopy converter did not write a TIFF/OME-TIFF file")
    return out_path


def read_normalized_stack(input_path):
    ext = os.path.splitext(input_path)[1].lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise ValueError(f"unsupported microscopy format: {ext or '(none)'}")
    reader = _READERS.get(ext)
    if reader is None:
        raise ImportError(f"reading {ext} needs {EXTERNAL_CONVERTER_ENV} set to an external converter")
    try:
        return reader(input_path)
    except ImportError as exc:  # the optional BSD reader is not installed
        raise ImportError(
            f"reading {ext} needs the optional readers: pip install voxellab-tooling[microscopy]"
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


def convert_to_ome_tiff(input_path, out_path):
    """Native vendor file → normalized calibrated OME-TIFF. Returns the output path."""
    ext = os.path.splitext(input_path)[1].lower()
    if ext in EXTERNAL_CONVERT_EXTENSIONS:
        return _convert_external_to_ome_tiff(input_path, out_path)
    try:
        stack = read_normalized_stack(input_path)
    except ImportError:
        if ext in NATIVE_READER_EXTENSIONS and (os.environ.get(EXTERNAL_CONVERTER_ENV) or "").strip():
            return _convert_external_to_ome_tiff(input_path, out_path)
        raise
    return write_ome_tiff(stack, out_path)
