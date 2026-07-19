from __future__ import annotations

from pathlib import Path

from scripts.check_validation_matrix import validate_matrix


def test_validation_matrix_accepts_claim_table(tmp_path: Path) -> None:
    matrix = tmp_path / "validation-matrix.md"
    _ = matrix.write_text(
        "\n".join(
            [
                "# Validation Matrix",
                "",
                "| Claim ID | Status | Validation Commands / Tests |",
                "| --- | --- | --- |",
                "| demo-fast-path | supported | `npm run test:browser` |",
                "| cloud-proxy-auth | partial | `npm run test:node` |",
            ]
        ),
        encoding="utf-8",
    )

    assert validate_matrix(matrix) == []


def test_validation_matrix_rejects_duplicate_ids_and_bad_status(tmp_path: Path) -> None:
    matrix = tmp_path / "validation-matrix.md"
    _ = matrix.write_text(
        "\n".join(
            [
                "| Claim ID | Status | Validation Commands / Tests |",
                "| --- | --- | --- |",
                "| demo-fast-path | supported | `npm run test:browser` |",
                "| demo-fast-path | maybe |  |",
            ]
        ),
        encoding="utf-8",
    )

    errors = validate_matrix(matrix)

    assert "row 2: duplicate claim_id demo-fast-path" in errors
    assert "row 2: invalid status maybe" in errors
    assert "row 2: missing validation commands/tests" in errors


def test_validation_matrix_records_current_microscopy_roi_boundaries() -> None:
    matrix = Path("docs/validation-matrix.md").read_text(encoding="utf-8")

    assert "open multi-vertex ImageJ PolyLines" in matrix
    assert "Microscopy sidecars remain source-bound" in matrix
    assert "Out-of-bounds rows and incompatible recipes reject visibly" in matrix
    assert "partial imports and skipped recipe steps stay visible" in matrix
    assert "line/angle measurements" in matrix
    assert "Microscopy workflow recipes preserve supported straight-line, angle, polygon, and freehand ROI geometry" in matrix
    assert "Replay reports skipped steps visibly" in matrix


def test_validation_matrix_records_standalone_sr_boundary() -> None:
    matrix = Path("docs/validation-matrix.md").read_text(encoding="utf-8")

    assert "VoxelLab-exported viewer-style SR notes" in matrix
    assert "wait in a bounded session queue until their referenced source series loads" in matrix
    assert "capped at 32 objects and 256 MiB" in matrix
    assert "never fabricates a source match" in matrix


def test_validation_matrix_records_ome_zarr_streaming_boundaries() -> None:
    matrix = Path("docs/validation-matrix.md").read_text(encoding="utf-8")

    assert "browser local import and URL streaming" in matrix
    assert "OME-NGFF 0.4/0.5" in matrix
    assert "Nonconforming 0.5 metadata stored on v2" in matrix
    assert "raw, zlib, gzip, zstd, and supported Blosc chunks" in matrix
    assert "optional byte shuffle" in matrix
    assert "tests/zarr-codecs.test.mjs tests/zarr-chunk-store.test.mjs tests/zarr-stream-import.test.mjs" in matrix
    assert "tests/browser/viewer-microscopy-zarr-stream.spec.js" in matrix
    assert "npm run demo:verify:ome-zarr-streaming" in matrix
    assert "bounded unsharded Zarr v3 subset" in matrix
    assert "Sharded v3 arrays, non-default chunk keys, bitshuffle, arbitrary filters" in matrix
    assert "URL streaming requires CORS" in matrix


def test_validation_matrix_records_new_scalar_and_quantification_boundaries() -> None:
    matrix = Path("docs/validation-matrix.md").read_text(encoding="utf-8")

    assert "bounded single-file NIfTI-1 or NIfTI-2" in matrix
    assert "signed 8-bit and unsigned 32-bit data" in matrix
    assert "CT/MR/PT/NM/OT" in matrix
    assert "8/16/32-bit signed or unsigned integer and 32-bit float" in matrix
    assert "raw pixel-wise Pearson plus strict-threshold Manders tM1/tM2" in matrix
    assert "Colocalization does not provide Costes thresholds, randomization, significance, object analysis" in matrix
