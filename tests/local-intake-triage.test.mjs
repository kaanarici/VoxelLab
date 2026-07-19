import assert from 'node:assert/strict';
import { test } from 'node:test';

const { localIntakeTriageModel, intakeTriageHtml } = await import('../js/projects/local-intake-triage.js');

test('clean import yields only an Opened row, no danger rows', () => {
  const rows = localIntakeTriageModel({
    files: [{ name: 'brain.nii' }],
    skipped: [],
    counts: { openable: 1, convertible: 0, sidecar: 0 },
    formatItems: { openable: [{ name: 'brain.nii' }], convertible: [], sidecar: [] },
    checkedFiles: 1,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'openable');
  assert.equal(rows[0].tone, 'success');
  assert.equal(rows[0].count, 1);
  assert.equal(rows[0].label, 'Opened (NIfTI)');
  assert.ok(!rows.some(row => row.tone === 'danger'));
});

test('skipped files produce a danger Skipped row with named samples and reasons', () => {
  const rows = localIntakeTriageModel({
    files: [{ name: 'scan.dcm', webkitRelativePath: 'study/scan.dcm' }],
    skipped: [
      { name: 'notes.md', webkitRelativePath: 'study/notes.md' },
      { name: 'missing.ome.tif', webkitRelativePath: 'study/missing.ome.tif', skipReason: 'path_unavailable' },
    ],
    counts: { openable: 1, convertible: 0, sidecar: 0 },
    formatItems: { openable: [{ name: 'scan.dcm' }], convertible: [], sidecar: [] },
    checkedFiles: 3,
  });
  const skipped = rows.find(row => row.kind === 'skipped');
  assert.ok(skipped, 'expected a skipped row');
  assert.equal(skipped.tone, 'danger');
  assert.equal(skipped.count, 2);
  assert.deepEqual(skipped.samples.map(s => s.name), ['study/notes.md', 'study/missing.ome.tif']);
  assert.equal(skipped.samples[1].reason, 'not found or unreadable');
});

test('skipped row caps samples at five and reports a "+N more" affordance', () => {
  const skipped = Array.from({ length: 8 }, (_, i) => ({ name: `n-${i}.md`, webkitRelativePath: `study/n-${i}.md` }));
  const rows = localIntakeTriageModel({
    files: [{ name: 'scan.dcm' }],
    skipped,
    skippedCount: 8,
    counts: { openable: 1, convertible: 0, sidecar: 0 },
    formatItems: { openable: [{ name: 'scan.dcm' }], convertible: [], sidecar: [] },
    checkedFiles: 9,
  });
  const row = rows.find(r => r.kind === 'skipped');
  assert.equal(row.samples.length, 5);
  assert.equal(row.more, '+3 more files');
});

test('converter-backed files carry the converter advice as a note', () => {
  const rows = localIntakeTriageModel({
    files: [{ name: 'brain.nii' }, { name: 'cells.czi' }],
    skipped: [],
    counts: { openable: 1, convertible: 1, sidecar: 0 },
    formatItems: { openable: [{ name: 'brain.nii' }], convertible: [{ name: 'cells.czi' }], sidecar: [] },
    checkedFiles: 2,
  });
  const converter = rows.find(row => row.kind === 'convertible');
  assert.ok(converter, 'expected a converter-backed row');
  assert.equal(converter.tone, 'warning');
  assert.equal(converter.label, 'Converter-backed (CZI)');
  assert.match(converter.note, /OME-TIFF converter/);
  assert.match(converter.note, /open separately/);
  assert.deepEqual(converter.samples.map(s => s.name), ['cells.czi']);
});

test('file and folder read failures and folder warnings each emit rows', () => {
  const rows = localIntakeTriageModel({
    files: [{ name: 'scan.dcm', path: '/study/scan.dcm' }],
    skipped: [],
    failedFiles: 1,
    failedFileSamples: [{ name: 'a-missing.dcm', path: '/study/a-missing.dcm', reason: 'path_unavailable' }],
    counts: { openable: 1, convertible: 0, sidecar: 0 },
    formatItems: { openable: [{ name: 'scan.dcm' }], convertible: [], sidecar: [] },
    checkedFiles: 4,
    warnings: [
      { path: '/study/private', reason: 'folder_read_failed' },
      { path: '/study/deep', reason: 'folder_depth_limit' },
    ],
    failedFolderReads: 1,
    warningCount: 2,
  });
  const failedFiles = rows.find(row => row.kind === 'failedFiles');
  const failedFolders = rows.find(row => row.kind === 'failedFolders');
  const folderWarnings = rows.find(row => row.kind === 'folderWarnings');
  assert.ok(failedFiles && failedFolders && folderWarnings);
  assert.equal(failedFiles.tone, 'danger');
  assert.equal(failedFiles.samples[0].name, 'study/a-missing.dcm');
  assert.equal(failedFiles.samples[0].reason, 'not found or unreadable');
  assert.equal(failedFolders.tone, 'danger');
  assert.equal(failedFolders.samples[0].name, 'Could not read folder: private');
  assert.equal(folderWarnings.tone, 'warning');
  assert.equal(folderWarnings.samples[0].name, 'Scan depth limit: deep');
});

test('intakeTriageHtml returns empty string for an empty intake', () => {
  assert.equal(intakeTriageHtml({}), '');
  assert.equal(intakeTriageHtml({ counts: { openable: 0 }, skipped: [] }), '');
});

test('intakeTriageHtml renders a Skipped row with an escaped name and reason', () => {
  const html = intakeTriageHtml({
    files: [{ name: 'scan.dcm' }],
    skipped: [{ name: 'notes.md', webkitRelativePath: 'study/notes.md', skipReason: 'path_unavailable' }],
    skippedCount: 1,
    counts: { openable: 1, convertible: 0, sidecar: 0 },
    formatItems: { openable: [{ name: 'scan.dcm' }], convertible: [], sidecar: [] },
    checkedFiles: 2,
  });
  assert.match(html, /<ul class="upload-triage-list">/);
  assert.match(html, /upload-triage-row is-danger/);
  assert.match(html, /study\/notes\.md/);
  assert.match(html, /upload-triage-reason">\(not found or unreadable\)/);
});

test('intakeTriageHtml escapes a malicious file name (no raw HTML injection)', () => {
  const html = intakeTriageHtml({
    files: [{ name: 'scan.dcm' }],
    skipped: [{ name: '<img src=x onerror=alert(1)>', webkitRelativePath: '<img src=x onerror=alert(1)>' }],
    skippedCount: 1,
    counts: { openable: 1, convertible: 0, sidecar: 0 },
    formatItems: { openable: [{ name: 'scan.dcm' }], convertible: [], sidecar: [] },
    checkedFiles: 2,
  });
  assert.ok(!html.includes('<img'), 'malicious name must not produce a raw <img tag');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('rows preserve canonical order across all categories', () => {
  const rows = localIntakeTriageModel({
    files: [{ name: 'scan.dcm' }],
    skipped: [{ name: 'notes.md' }],
    skippedCount: 1,
    failedFiles: 1,
    failedFileSamples: [{ name: 'x.dcm', reason: 'path_unavailable' }],
    counts: { openable: 1, convertible: 1, sidecar: 1 },
    formatItems: {
      openable: [{ name: 'scan.dcm' }],
      convertible: [{ name: 'cells.czi' }],
      sidecar: [{ name: 'roi.json', formatLabel: 'ROI results' }],
    },
    checkedFiles: 5,
    warnings: [
      { path: '/p', reason: 'folder_read_failed' },
      { path: '/d', reason: 'folder_depth_limit' },
    ],
    failedFolderReads: 1,
    warningCount: 2,
  });
  assert.deepEqual(
    rows.map(row => row.kind),
    ['openable', 'convertible', 'sidecar', 'skipped', 'failedFiles', 'failedFolders', 'folderWarnings'],
  );
});
