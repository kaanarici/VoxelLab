from __future__ import annotations

import importlib
import sys
import types


class FakeRetries:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


def import_modal_validation():
    sys.modules["modal"] = types.SimpleNamespace(Retries=FakeRetries)
    _ = sys.modules.pop("modal_validation", None)
    return importlib.import_module("modal_validation")


def test_modal_validation_env_helpers_are_bounded(monkeypatch):
    module = import_modal_validation()
    monkeypatch.setenv("MRI_VIEWER_MODAL_GPU", "L4,A10G")
    monkeypatch.setenv("TEST_INT", "999")
    monkeypatch.setenv("TEST_FLOAT", "-5")

    assert module.env_int("TEST_INT", 10, max_value=64) == 64
    assert module.env_float("TEST_FLOAT", 1.5, min_value=0.5) == 0.5
    assert module.env_gpu("MRI_VIEWER_MODAL_GPU") == ["L4", "A10"]


def test_modal_validation_rejects_unknown_gpu(monkeypatch):
    module = import_modal_validation()
    monkeypatch.setenv("MRI_VIEWER_MODAL_GPU", "expensive-mystery-gpu")

    try:
        module.env_gpu("MRI_VIEWER_MODAL_GPU")
    except ValueError as exc:
        assert "unsupported Modal GPU type" in str(exc)
    else:
        raise AssertionError("unknown GPUs must fail deployment configuration")


def test_modal_validation_ephemeral_disk_uses_current_modal_bounds(monkeypatch):
    module = import_modal_validation()

    monkeypatch.delenv("MRI_VIEWER_MODAL_EPHEMERAL_DISK_MB", raising=False)
    assert module.env_ephemeral_disk_mb("MRI_VIEWER_MODAL_EPHEMERAL_DISK_MB") is None
    monkeypatch.setenv("MRI_VIEWER_MODAL_EPHEMERAL_DISK_MB", "524288")
    assert module.env_ephemeral_disk_mb("MRI_VIEWER_MODAL_EPHEMERAL_DISK_MB") == 524_288
    for invalid in ("204800", "not-a-size", "3145729"):
        monkeypatch.setenv("MRI_VIEWER_MODAL_EPHEMERAL_DISK_MB", invalid)
        try:
            module.env_ephemeral_disk_mb("MRI_VIEWER_MODAL_EPHEMERAL_DISK_MB")
        except ValueError:
            pass
        else:
            raise AssertionError("invalid Modal disk requests must fail deployment configuration")


def test_modal_validation_upload_items_and_auth(monkeypatch):
    module = import_modal_validation()
    monkeypatch.setenv("MODAL_AUTH_TOKEN", "secret-token")

    items, error = module.normalize_upload_items({
        "items": [
            {"upload_id": "f000001", "filename": "IM0001", "size_bytes": 10},
            {"upload_id": "f000002", "filename": "IM0001", "size_bytes": 11},
        ]
    })

    assert error is None
    assert items[1]["upload_id"] == "f000002"
    assert items[1]["content_type"] == "application/dicom"
    assert module.auth_error("secret-token") == ""
    assert module.auth_error("wrong-token") == "unauthorized"

    for invalid_size in (True, 1.5, "10", 0, -1):
        invalid_items, invalid_error = module.normalize_upload_items({
            "items": [{"upload_id": "f000001", "filename": "IM0001", "size_bytes": invalid_size}],
        })
        assert invalid_items == []
        assert invalid_error == "invalid upload item"
