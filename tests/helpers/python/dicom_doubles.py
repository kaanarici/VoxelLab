"""Lightweight DICOM dataset doubles for geometry and stack-selection tests."""

from __future__ import annotations

class FakeDicom:
    def __init__(
        self,
        *,
        modality: str = "CT",
        series_uid: str = "series-a",
        rows: int = 512,
        cols: int = 512,
        instance: int = 1,
        image_type=None,
        orientation=None,
        position=None,
        pixel_spacing=None,
        frame_uid: str = "",
    ):
        self.Modality = modality
        self.SeriesInstanceUID = series_uid
        self.Rows = rows
        self.Columns = cols
        self.InstanceNumber = instance
        self.PixelSpacing = pixel_spacing if pixel_spacing is not None else [1, 1]
        self.ImageOrientationPatient = orientation if orientation is not None else [1, 0, 0, 0, 1, 0]
        self.ImagePositionPatient = position if position is not None else [0, 0, instance - 1]
        self.FrameOfReferenceUID = frame_uid
        if image_type is not None:
            self.ImageType = image_type
        self.pixel_array = [[1, 2], [3, 4]]

class FakePixelCube:
    """Multi-frame pixel data indexed frame by frame."""

    def __init__(self, frames):
        self._frames = frames
        rows = len(frames[0]) if frames else 0
        cols = len(frames[0][0]) if frames and frames[0] else 0
        self.shape = (len(frames), rows, cols)

    def __getitem__(self, index):
        return self._frames[index]

class FakePixelPlane:
    def __init__(self, rows: int = 2, cols: int = 2):
        self.shape = (rows, cols)

class FakeSeqItem:
    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)

def stack_slices(positions: list[list[float]], **overrides) -> list[FakeDicom]:
    """A spatially ordered stack, one dataset per patient-space position."""
    return [
        FakeDicom(instance=index + 1, position=position, **overrides)
        for index, position in enumerate(positions)
    ]

def enhanced_multiframe_dataset(
    positions: list[list[float]],
    *,
    frames=None,
    rescale: list[tuple[float, float]] | None = None,
    series_uid: str = "enhanced",
    frame_uid: str = "1.2.840.enhanced",
) -> FakeDicom:
    """An enhanced multi-frame dataset with shared and per-frame functional groups."""
    dataset = FakeDicom(series_uid=series_uid, instance=1)
    dataset.NumberOfFrames = len(positions)
    dataset.FrameOfReferenceUID = frame_uid
    dataset.SharedFunctionalGroupsSequence = [
        FakeSeqItem(
            PixelMeasuresSequence=[FakeSeqItem(PixelSpacing=[1, 1], SliceThickness=1.0)],
            PlaneOrientationSequence=[FakeSeqItem(ImageOrientationPatient=[1, 0, 0, 0, 1, 0])],
        ),
    ]
    per_frame = []
    for index, position in enumerate(positions):
        groups = {"PlanePositionSequence": [FakeSeqItem(ImagePositionPatient=position)]}
        if rescale is not None:
            slope, intercept = rescale[index]
            groups["PixelValueTransformationSequence"] = [
                FakeSeqItem(RescaleSlope=slope, RescaleIntercept=intercept),
            ]
        per_frame.append(FakeSeqItem(**groups))
    dataset.PerFrameFunctionalGroupsSequence = per_frame
    dataset.pixel_array = FakePixelCube(
        frames if frames is not None else [[[1, 2], [3, 4]], [[5, 6], [7, 8]]],
    )
    return dataset
