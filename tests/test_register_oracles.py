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


def test_alignment_metrics_identical_inputs_are_perfect_and_aligned(monkeypatch) -> None:
    register = import_register_with_fake_ants(monkeypatch)
    data = np.zeros((4, 4, 4), dtype=np.float32)
    data[1:3, 1:3, 1:3] = 10.0

    metrics = register.alignment_metrics(FakeAntsImage(data), FakeAntsImage(data.copy()))

    assert metrics["mse_normalized"] == 0.0
    assert metrics["mutual_information"] == 0.75
    assert metrics["dice"] == 1.0
    assert register.verdict_for(0.0, 0.0, metrics["dice"]) == "aligned"


def test_transform_magnitude_known_translation_vector_is_misregistered(monkeypatch) -> None:
    register = import_register_with_fake_ants(monkeypatch)

    magnitude = register.transform_magnitude(["rigid.mat"])

    assert magnitude["translation_mm"] == [3.0, 4.0, 12.0]
    assert magnitude["translation_magnitude_mm"] == 13.0
    assert magnitude["rotation_deg"] == 0.0
    assert magnitude["rotation_magnitude_mm"] == 0.0
    assert register.verdict_for(magnitude["translation_magnitude_mm"], 0.0, 1.0) == "misregistered"


def test_verdict_threshold_boundaries_are_strict(monkeypatch) -> None:
    register = import_register_with_fake_ants(monkeypatch)

    assert register.verdict_for(1.999, 1.999, 0.901) == "aligned"
    assert register.verdict_for(2.0, 1.0, 0.95) == "slightly off"
    assert register.verdict_for(4.999, 4.999, 0.801) == "slightly off"
    assert register.verdict_for(5.0, 0.0, 1.0) == "misregistered"
    assert register.verdict_for(1.0, 1.0, 0.9) == "slightly off"
    assert register.verdict_for(4.0, 4.0, 0.8) == "misregistered"
