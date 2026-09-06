from __future__ import annotations

import importlib
import sys
import types

import numpy as np

class FakeAntsImage:
    def __init__(self, data: np.ndarray) -> None:
        self._data = data.astype(np.float32)

    def numpy(self) -> np.ndarray:
        return self._data

class FakeTransform:
    def __init__(self, parameters: list[float]) -> None:
        self.parameters = parameters

def import_register_with_fake_ants(monkeypatch):
    fake_ants = types.SimpleNamespace(
        __version__="test",
        image_mutual_information=lambda fixed, warped: 0.75,
        read_transform=lambda path: FakeTransform([1, 0, 0, 0, 1, 0, 0, 0, 1, 3, 4, 12]),
    )
    monkeypatch.setitem(sys.modules, "ants", fake_ants)
    _ = sys.modules.pop("register", None)
    return importlib.import_module("register")

def test_alignment_metrics_identical_inputs_have_perfect_overlap(monkeypatch) -> None:
    register = import_register_with_fake_ants(monkeypatch)
    data = np.zeros((4, 4, 4), dtype=np.float32)
    data[1:3, 1:3, 1:3] = 10.0

    metrics = register.alignment_metrics(FakeAntsImage(data), FakeAntsImage(data.copy()))

    assert metrics["mse_normalized"] == 0.0
    assert metrics["mutual_information"] == 0.75
    assert metrics["dice"] == 1.0

def test_transform_magnitude_known_translation_vector(monkeypatch) -> None:
    register = import_register_with_fake_ants(monkeypatch)

    magnitude = register.transform_magnitude(["rigid.mat"])

    assert magnitude["translation_mm"] == [3.0, 4.0, 12.0]
    assert magnitude["translation_magnitude_mm"] == 13.0
    assert magnitude["rotation_deg"] == 0.0
