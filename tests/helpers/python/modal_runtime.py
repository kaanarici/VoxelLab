"""Import shims that let the Modal app load without the real `modal` package."""

from __future__ import annotations

import importlib
import sys
import types

class FakeImage:
    def __init__(self):
        self.packages = []
        self.local_sources = []
        self.requirements = []

    @classmethod
    def debian_slim(cls, **_kwargs):
        return cls()

    def apt_install(self, *_args, **_kwargs):
        return self

    def pip_install(self, *_args, **_kwargs):
        return self

    def uv_pip_install(self, *packages, **_kwargs):
        self.packages.extend(packages)
        return self

    def add_local_python_source(self, *modules, **_kwargs):
        self.local_sources.extend(modules)
        return self

    def pip_install_from_requirements(self, path, **kwargs):
        self.requirements.append((path, kwargs))
        return self

class FakeSecret:
    def __init__(self, name: str):
        self.name = name

    @staticmethod
    def from_name(name: str):
        return FakeSecret(name)

class FakeRetries:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

class FakeApp:
    def __init__(self, _name: str):
        pass

    def function(self, **_kwargs):
        def decorator(fn):
            fn.spawn = lambda *_args, **_kwargs: None
            return fn

        return decorator

def _fake_fastapi_endpoint(**_kwargs):
    def decorator(fn):
        return fn

    return decorator

def install_fake_modal(monkeypatch) -> None:
    """Replace the `modal` package for the duration of one test."""
    monkeypatch.setitem(
        sys.modules,
        "modal",
        types.SimpleNamespace(
            App=FakeApp,
            Image=FakeImage,
            Retries=FakeRetries,
            Secret=FakeSecret,
            fastapi_endpoint=_fake_fastapi_endpoint,
        ),
    )

def load_module(monkeypatch, name: str):
    """Import a Modal-dependent module fresh, restoring the registry afterwards."""
    install_fake_modal(monkeypatch)
    monkeypatch.delitem(sys.modules, name, raising=False)
    module = importlib.import_module(name)
    monkeypatch.setitem(sys.modules, name, module)
    return module

def load_modal_app(monkeypatch):
    """Import `modal_app` with the buckets its module body requires."""
    monkeypatch.setenv("R2_UPLOAD_BUCKET", "scan-inputs")
    monkeypatch.setenv("R2_RESULTS_BUCKET", "scan-results")
    return load_module(monkeypatch, "modal_app")
