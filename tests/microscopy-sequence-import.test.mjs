import assert from 'node:assert/strict';
import { test } from 'node:test';

const { normalizeMicroscopyTiffSequence } = await import('../js/microscopy/microscopy-sequence-import.js');

test('sorts a numbered TIFF sequence by numeric suffix into z order', () => {
  const normalized = normalizeMicroscopyTiffSequence([
    '/tmp/cells_z010.tif',
    '/tmp/cells_z002.tif',
    '/tmp/cells_z001.tif',
  ]);

  assert.equal(normalized.kind, 'microscopy-tiff-sequence');
  assert.equal(normalized.groups.length, 1);
  assert.equal(normalized.groups[0].orderStrategy, 'numeric-suffix');
  assert.deepEqual(normalized.groups[0].planes.map(plane => [plane.z, plane.name, plane.inferredIndex]), [
    [0, 'cells_z001.tif', 1],
    [1, 'cells_z002.tif', 2],
    [2, 'cells_z010.tif', 10],
  ]);
  assert.deepEqual(normalized.warnings, [{
    code: 'missing_plane_index_gap',
    groupId: '/tmp|cells_z',
    message: 'Numeric plane indices are not contiguous.',
    missing: [3, 4, 5, 6, 7, 8, 9],
    missingCount: 7,
  }]);
});

test('falls back to lexical ordering when files have no numeric suffix and keeps provenance warning', () => {
  const normalized = normalizeMicroscopyTiffSequence([
    { name: 'slice-c.tiff', path: '/stack/slice-c.tiff' },
    { name: 'slice-a.tiff', path: '/stack/slice-a.tiff' },
    { name: 'slice-b.tiff', path: '/stack/slice-b.tiff' },
  ]);

  assert.equal(normalized.groups.length, 1);
  const allWarnings = normalized.warnings.filter(item => item.code === 'missing_plane_index');
  assert.equal(allWarnings.length, 1);
  assert.deepEqual(normalized.groups[0].planes.map(plane => plane.name), [
    'slice-a.tiff',
    'slice-b.tiff',
    'slice-c.tiff',
  ]);
  assert.equal(normalized.groups[0].orderStrategy, 'lexical');
});

test('flags duplicate numeric suffixes as ambiguous provenance', () => {
  const normalized = normalizeMicroscopyTiffSequence([
    '/tmp/sample_z001.tif',
    '/tmp/sample_z0001.tif',
    '/tmp/sample_z002.tif',
  ]);

  const ambiguous = normalized.warnings.find(item => item.code === 'ambiguous_plane_index');
  assert.ok(ambiguous);
  assert.deepEqual(ambiguous.indices, [1]);
});

test('caps large missing numeric suffix warnings while preserving the count', () => {
  const normalized = normalizeMicroscopyTiffSequence([
    '/tmp/plate_z0001.tif',
    '/tmp/plate_z0500.tif',
  ]);

  const gap = normalized.warnings.find(item => item.code === 'missing_plane_index_gap');
  assert.equal(gap.missingCount, 498);
  assert.equal(gap.missing.length, 128);
  assert.deepEqual(gap.missing.slice(0, 3), [2, 3, 4]);
  assert.deepEqual(gap.missing.slice(-3), [127, 128, 129]);
});

test('counts extreme numeric suffix gaps without scanning every missing index', () => {
  const normalized = normalizeMicroscopyTiffSequence([
    '/tmp/plate_z0001.tif',
    '/tmp/plate_z100000000.tif',
  ]);

  const gap = normalized.warnings.find(item => item.code === 'missing_plane_index_gap');
  assert.equal(gap.missingCount, 99_999_998);
  assert.equal(gap.missing.length, 128);
  assert.deepEqual(gap.missing.slice(0, 3), [2, 3, 4]);
  assert.deepEqual(gap.missing.slice(-3), [127, 128, 129]);
});

test('rejects mixed non-TIFF inputs', () => {
  assert.throws(
    () => normalizeMicroscopyTiffSequence([
      { name: 'slice_001.tif', path: '/tmp/slice_001.tif' },
      { name: 'notes.txt', path: '/tmp/notes.txt' },
    ]),
    /only accepts TIFF files/,
  );
});

test('accepts File-like entries without path and preserves source index provenance', () => {
  const normalized = normalizeMicroscopyTiffSequence([
    { name: 'plate_0002.tif' },
    { name: 'plate_0001.tif' },
  ]);

  assert.equal(normalized.groups.length, 1);
  assert.deepEqual(normalized.groups[0].planes.map(plane => [plane.name, plane.sourceIndex]), [
    ['plate_0001.tif', 1],
    ['plate_0002.tif', 0],
  ]);
});
