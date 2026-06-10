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

    assert "straight-line and angle measurements" in matrix
    assert "standalone microscopy sidecars ask for the matching source image first" in matrix
    assert "ROI points do not fit the active stack/image bounds" in matrix
    assert "VoxelLab ROI-results sidecars whose ROI/measurement points do not fit the active image bounds" in matrix
    assert "workflow recipes whose embedded ROI-results rows do not fit the active image bounds" in matrix
    assert "visible partial-import warning" in matrix
    assert "visible skipped-recipe reasons" in matrix
    assert "angle_deg rows for angle measurements" in matrix
    assert "embedded angle measurement replay" in matrix
    assert "workflow recipe sidecars including visible skipped-recipe reasons and angle measurement replay" in matrix
    assert "straight-line, angle, polygon/freehand" in matrix


def test_validation_matrix_records_standalone_sr_boundary() -> None:
    matrix = Path("docs/validation-matrix.md").read_text(encoding="utf-8")

    assert "VoxelLab-exported viewer-style SR notes with explicit series/slice references" in matrix
    assert "visible skipped-derived modality/reason text after the source series loads" in matrix
    assert "standalone SR files ask for the matching source series first" in matrix
