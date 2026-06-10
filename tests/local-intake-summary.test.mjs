import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  summarizeLocalIntake,
} = await import('../js/projects/local-intake-summary.js');

test('browser local intake separates unreadable files and folders from unsupported skips', async () => {
  const intake = await summarizeLocalIntake([
    { name: 'missing.ome.tif', webkitRelativePath: 'study/missing.ome.tif', skipReason: 'path_unavailable', failureKind: 'file' },
    { name: 'private', webkitRelativePath: 'study/private', skipReason: 'folder_read_failed', failureKind: 'folder' },
    { name: 'notes.md', webkitRelativePath: 'study/notes.md' },
    { name: 'scan.dcm', webkitRelativePath: 'study/scan.dcm' },
  ]);

  assert.deepEqual(intake.files.map(file => file.name), ['scan.dcm']);
  assert.equal(intake.skippedCount, 1);
  assert.deepEqual(intake.skipped.map(file => file.name), ['notes.md']);
  assert.equal(intake.failedFiles, 1);
  assert.deepEqual(intake.failedFileSamples.map(file => [file.name, file.reason]), [
    ['missing.ome.tif', 'path_unavailable'],
  ]);
  assert.equal(intake.failedFolderReads, 1);
  assert.deepEqual(intake.warnings.map(item => [item.name, item.reason]), [
    ['private', 'folder_read_failed'],
  ]);
  assert.equal(
    intake.message,
    'Local intake: 1 openable file (DICOM) selected after checking 4 files; skipped 1 unsupported file (study/notes.md); 1 file read failed (study/missing.ome.tif (not found or unreadable)); 1 folder read failed (Could not read folder: private).',
  );
});

test('browser local intake still labels converter-backed and schema sidecar files', async () => {
  const recipe = {
    name: 'workflow.json',
    webkitRelativePath: 'study/workflow.json',
    async text() {
      return JSON.stringify({ schema: 'voxellab.microscopyWorkflowRecipe.v1' });
    },
  };
  const intake = await summarizeLocalIntake([
    { name: 'cells.czi', webkitRelativePath: 'study/cells.czi' },
    recipe,
    { name: 'cells.ome.tiff', webkitRelativePath: 'study/cells.ome.tiff' },
  ]);

  assert.deepEqual(intake.counts, { openable: 1, convertible: 1, sidecar: 1 });
  assert.deepEqual(intake.formatItems.convertible.map(file => file.name), ['cells.czi']);
  assert.deepEqual(intake.formatItems.sidecar.map(file => file.formatLabel), ['Workflow recipe']);
  assert.match(intake.message, /converter-backed files need configured local readers or an OME-TIFF converter/);
});
