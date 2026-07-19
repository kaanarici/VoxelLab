from __future__ import annotations

import copy
import json
import os
import tempfile
import time
from collections.abc import Callable, Generator, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO, TypeVar, cast, overload


T = TypeVar("T")


class _Missing:
    pass


_MISSING = _Missing()


def _lock_file(handle: BinaryIO, *, timeout: float | None, lock_name: str) -> None:
    deadline = None if timeout is None else time.monotonic() + timeout
    while True:
        try:
            if os.name == "nt":
                import msvcrt

                _ = handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except OSError:
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(f"timed out waiting for JSON lock: {lock_name}")
            time.sleep(0.01)


def _unlock_file(handle: BinaryIO) -> None:
    if os.name == "nt":
        import msvcrt

        _ = handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl

        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@contextmanager
def file_lock(lock_path: Path, *, timeout: float | None = 30.0) -> Generator[None, None, None]:
    lock_path = Path(lock_path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as handle:
        if os.fstat(handle.fileno()).st_size == 0:
            _ = handle.write(b"\0")
            handle.flush()
        _lock_file(handle, timeout=timeout, lock_name=str(lock_path))
        try:
            yield
        finally:
            _unlock_file(handle)


@contextmanager
def json_lock(path: Path, *, timeout: float = 30.0) -> Generator[None, None, None]:
    path = Path(path)
    with file_lock(path.with_name(f".{path.name}.lock"), timeout=timeout):
        yield


def _atomic_write_json_unlocked(
    path: Path,
    value: object,
    *,
    indent: int | None,
    sort_keys: bool,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=indent, sort_keys=sort_keys, ensure_ascii=False)
            _ = handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_name, mode)
        os.replace(tmp_name, path)
        try:
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            pass
    except BaseException:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass
        raise


def atomic_write_json(
    path: Path,
    value: object,
    *,
    indent: int | None = 2,
    sort_keys: bool = False,
) -> None:
    path = Path(path)
    with json_lock(path):
        _atomic_write_json_unlocked(path, value, indent=indent, sort_keys=sort_keys)


@overload
def update_json(
    path: Path,
    update: Callable[[T], T],
    *,
    indent: int | None = 2,
    sort_keys: bool = False,
) -> T: ...


@overload
def update_json(
    path: Path,
    update: Callable[[T], T],
    *,
    default: T,
    indent: int | None = 2,
    sort_keys: bool = False,
) -> T: ...


def update_json(
    path: Path,
    update: Callable[[T], T],
    *,
    default: T | _Missing = _MISSING,
    indent: int | None = 2,
    sort_keys: bool = False,
) -> T:
    path = Path(path)
    with json_lock(path):
        if path.exists():
            current = cast(T, json.loads(path.read_text(encoding="utf-8")))
        else:
            if isinstance(default, _Missing):
                raise FileNotFoundError(path)
            current = copy.deepcopy(default)
        next_value = update(current)
        _atomic_write_json_unlocked(path, next_value, indent=indent, sort_keys=sort_keys)
        return next_value


def update_manifest_series(
    path: Path,
    updates: Mapping[str, Mapping[str, object]],
) -> dict[str, object]:
    def apply(manifest: dict[str, object]) -> dict[str, object]:
        raw_series = manifest.get("series")
        if not isinstance(raw_series, list):
            raise ValueError("manifest.series: expected list")
        for raw_entry in cast(list[object], raw_series):
            if not isinstance(raw_entry, dict):
                continue
            entry = cast(dict[str, object], raw_entry)
            slug = entry.get("slug")
            if isinstance(slug, str) and slug in updates:
                entry.update(updates[slug])
        return manifest

    return update_json(path, apply)
