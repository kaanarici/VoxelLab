/* global process */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FIXTURE_ROOT = process.env.VOXELLAB_ACCURACY_FIXTURE_ROOT
  ? process.env.VOXELLAB_ACCURACY_FIXTURE_ROOT
  : join(ROOT, 'tests', 'fixtures', 'accuracy');

function hasFixtureWithExtension(dir, extension) {
  try {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory() && hasFixtureWithExtension(path, extension)) return true;
      if (name.isFile() && name.name.endsWith(extension)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

// The synthetic .nii fixtures are stripped from the sanitized public export
// (the patient-data *.nii rule), so this parity check runs only where they exist.
function hasNiftiFixtures() {
  return hasFixtureWithExtension(join(FIXTURE_ROOT, 'nifti'), '.nii');
}

function hasDicomFixtures() {
  return hasFixtureWithExtension(join(FIXTURE_ROOT, 'dicom'), '.dcm');
}

function runLedger(env = {}) {
  execFileSync(process.execPath, ['scripts/check_accuracy_ledger.mjs'], {
    cwd: ROOT,
    stdio: 'pipe',
    env: { ...process.env, ...env },
  });
  return JSON.parse(readFileSync(join(ROOT, 'accuracy-ledger.json'), 'utf8'));
}

test('accuracy ledger matches committed nibabel NIfTI goldens', {
  skip: hasNiftiFixtures() ? false : 'NIfTI accuracy fixtures excluded from this build',
}, () => {
  const ledger = runLedger();
  const rows = ledger.rows.filter((row) => row.oracle === 'nifti-affine-vs-nibabel');
  assert.equal(ledger.summary.failed, 0);
  assert.equal(rows.length, 4);
  assert.ok(ledger.references.includes('nibabel 5.4.2'));
  for (const row of rows) {
    assert.equal(row.status, 'PASS', row.fixture);
    assert.ok(row.maxAbsError <= ledger.tolerance, row.fixture);
    assert.match(row.checkedCodePath.join(' '), /parseNIfTI/);
    assert.match(row.checkedCodePath.join(' '), /geometryFromSeries/);
  }
});

test('accuracy ledger matches committed pydicom DICOM geometry goldens', {
  skip: hasDicomFixtures() ? false : 'DICOM accuracy fixtures excluded from this build',
}, () => {
  const ledger = runLedger();
  const rows = ledger.rows.filter((row) => row.oracle === 'dicom-patient-space-vs-pydicom-ps3.3');
  assert.equal(ledger.summary.failed, 0);
  assert.equal(rows.length, 6);
  assert.ok(ledger.references.includes('pydicom+DICOM-PS3.3-Image-Plane pydicom 3.0.2; DICOM PS3.3 2026b C.7.6.2.1.1'));
  assert.deepEqual(
    rows.map((row) => row.fixture).sort(),
    [
      'axial-regular',
      'duplicate-ipp',
      'enhanced-multiframe',
      'mixed-frame-of-reference',
      'oblique-iop',
      'reversed-slice-order',
    ],
  );
  for (const row of rows) {
    assert.equal(row.status, 'PASS', row.fixture);
    assert.ok(row.maxAbsError <= ledger.tolerance, row.fixture);
    assert.match(row.checkedCodePath.join(' '), /buildDICOMSeriesResult/);
    assert.match(row.checkedCodePath.join(' '), /geometryFromSeries/);
    assert.deepEqual(row.mismatches, []);
  }
  assert.equal(rows.find((row) => row.fixture === 'duplicate-ipp').volumeStackSafe, false);
  assert.equal(rows.find((row) => row.fixture === 'mixed-frame-of-reference').volumeStackSafe, false);
  assert.equal(rows.find((row) => row.fixture === 'enhanced-multiframe').volumeStackSafe, true);
});

test('accuracy ledger skips cleanly when all accuracy fixtures are absent', () => {
  const emptyRoot = mkdtempSync(join(tmpdir(), 'voxellab-empty-accuracy-'));
  try {
    const output = execFileSync(process.execPath, ['scripts/check_accuracy_ledger.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, VOXELLAB_ACCURACY_FIXTURE_ROOT: emptyRoot },
    });
    assert.match(output, /No accuracy fixtures present/);
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});
