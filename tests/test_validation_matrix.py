from __future__ import annotations

from pathlib import Path

import pytest

from scripts.check_validation_matrix import validate_matrix

ROOT = Path(__file__).resolve().parents[1]
HEADER = [
    "| Claim ID | Status | Validation Commands / Tests |",
    "| --- | --- | --- |",
]

def write_matrix(path: Path, *rows: str) -> Path:
    matrix = path / "validation-matrix.md"
    _ = matrix.write_text("\n".join([*HEADER, *rows]), encoding="utf-8")
    return matrix

def test_the_shipped_validation_matrix_is_a_valid_claim_table() -> None:
    assert validate_matrix(ROOT / "docs" / "validation-matrix.md") == []

def test_a_claim_table_needs_only_an_id_a_status_and_a_command(tmp_path: Path) -> None:
    matrix = write_matrix(
        tmp_path,
        "| demo-fast-path | supported | `npm run test:browser` |",
        "| cloud-proxy-auth | partial | `npm run test:node` |",
    )

    assert validate_matrix(matrix) == []

@pytest.mark.parametrize(
    "error",
    [
        "row 2: duplicate claim_id demo-fast-path",
        "row 2: invalid status maybe",
        "row 2: missing validation commands/tests",
    ],
    ids=["duplicate-id", "unknown-status", "unvalidated-claim"],
)
def test_a_claim_row_must_be_unique_named_and_validated(tmp_path: Path, error: str) -> None:
    matrix = write_matrix(
        tmp_path,
        "| demo-fast-path | supported | `npm run test:browser` |",
        "| demo-fast-path | maybe |  |",
    )

    assert error in validate_matrix(matrix)
