from __future__ import annotations

from pathlib import Path

from upload_to_r2 import compressed_path_for_entry, patch_manifest_urls, public_object_url


def test_r2_upload_index_paths_cannot_escape_compressed_root(tmp_path: Path) -> None:
    inside = compressed_path_for_entry(tmp_path, {"compressed": "nested/volume.raw.zst"})
    assert inside == (tmp_path / "nested" / "volume.raw.zst").resolve()

    for value in ("../secret", "/tmp/secret", "nested/../../secret", ""):
        try:
            _ = compressed_path_for_entry(tmp_path, {"compressed": value})
        except ValueError as error:
            assert "inside data_compressed" in str(error)
        else:
            raise AssertionError(f"expected path rejection for {value!r}")


def test_r2_manifest_patch_publishes_only_objects_confirmed_available() -> None:
    manifest = {"series": [{"slug": "scan"}, {"slug": "other"}]}
    index = {
        "scan": {
            "source": "scan.raw",
            "compressed": "scan.raw.zst",
            "sha256_zst": "abcdef1234567890",
        },
        "scan_mask": {
            "source": "scan_mask.raw",
            "compressed": "scan_mask.raw.zst",
            "sha256_zst": "1234567890abcdef",
        },
        "other": {
            "source": "other.raw",
            "compressed": "other.raw.zst",
            "sha256_zst": "9999999999999999",
        },
    }

    patched, count = patch_manifest_urls(
        manifest,
        index,
        "https://volumes.example/base",
        {"scan-abcdef1234567890.raw.zst", "scan_mask-1234567890abcdef.raw.zst"},
    )

    assert count == 2
    assert patched["series"][0]["rawUrl"] == (
        "https://volumes.example/base/scan-abcdef1234567890.raw.zst"
    )
    assert patched["series"][0]["maskUrl"] == (
        "https://volumes.example/base/scan_mask-1234567890abcdef.raw.zst"
    )
    assert "rawUrl" not in patched["series"][1]
    assert public_object_url("https://volumes.example/base/", "folder/a b.raw.zst") == (
        "https://volumes.example/base/folder/a%20b.raw.zst"
    )
