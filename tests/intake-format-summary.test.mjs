import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  appendIntakeFormatSummary,
  intakeFormatLabel,
  intakeFormatSummary,
} = await import('../js/intake-format-summary.js');
const {
  classifyJsonSidecarText,
  sidecarUnsupportedDescription,
  sidecarUnsupportedReasonLabel,
} = await import('../js/sidecar-schemas.js');

test('intakeFormatLabel names supported research imaging formats without broadening support', () => {
  assert.equal(intakeFormatLabel({ name: 'scan.dcm' }), 'DICOM');
  assert.equal(intakeFormatLabel({ name: 'brain.nii.gz' }), 'NIfTI');
  assert.equal(intakeFormatLabel({ name: 'cells.ome.tiff' }), 'OME-TIFF');
  assert.equal(intakeFormatLabel({ relativePath: 'cells.zarr/0/.zarray' }), 'OME-Zarr');
  assert.equal(intakeFormatLabel({ name: 'cells.czi' }), 'CZI');
  assert.equal(intakeFormatLabel({ name: '.zattrs', formatLabel: 'OME-Zarr' }), 'OME-Zarr');
  assert.equal(intakeFormatLabel({ name: 'workflow.json', formatLabel: 'Workflow recipe' }), 'Workflow recipe');
  assert.equal(intakeFormatLabel({ name: 'results.json', formatLabel: 'ROI results' }), 'ROI results');
  assert.equal(intakeFormatLabel({ name: 'notes.md' }), '');
});

test('intakeFormatSummary compacts mixed folder labels', () => {
  assert.equal(
    intakeFormatSummary([
      { name: 'a.dcm' },
      { name: 'b.dicom' },
      { name: 'brain.nii' },
      { name: 'cells.roi' },
      { name: 'recipe.json' },
    ]),
    'DICOM 2, NIfTI, ImageJ ROI, JSON sidecar',
  );
});

test('appendIntakeFormatSummary keeps count text when there is no format label', () => {
  assert.equal(appendIntakeFormatSummary('1 unsupported file', [{ name: 'notes.md' }]), '1 unsupported file');
});

test('classifyJsonSidecarText keeps browser and desktop JSON sidecar labels aligned', () => {
  assert.deepEqual(classifyJsonSidecarText('{"schema":"voxellab.roiResults.v1"}'), {
    schema: 'voxellab.roiResults.v1',
    formatLabel: 'ROI results',
    reason: 'unrecognized_json_sidecar',
  });
  assert.deepEqual(classifyJsonSidecarText('{"sourceKind":"projection"}'), {
    schema: '',
    formatLabel: 'VoxelLab source manifest',
    reason: 'unrecognized_json_sidecar',
  });
  assert.deepEqual(classifyJsonSidecarText('{"schema":"unknown"}'), {
    schema: 'unknown',
    formatLabel: '',
    reason: 'unrecognized_json_sidecar',
  });
  assert.deepEqual(classifyJsonSidecarText('{not json'), {
    schema: '',
    formatLabel: '',
    reason: 'invalid_json_sidecar',
  });
  assert.equal(sidecarUnsupportedReasonLabel('invalid_json_sidecar'), 'invalid JSON sidecar');
  assert.equal(sidecarUnsupportedReasonLabel('unrecognized_json_sidecar'), 'unrecognized JSON sidecar');
  assert.equal(sidecarUnsupportedReasonLabel('path_unavailable'), 'not found or unreadable');
  assert.equal(sidecarUnsupportedReasonLabel('unsupported_extension'), '');
  assert.equal(
    sidecarUnsupportedDescription({ reason: 'unrecognized_json_sidecar', schema: 'example.not-roi-results.v1' }),
    'unrecognized JSON sidecar schema: example.not-roi-results.v1',
  );
  assert.equal(
    sidecarUnsupportedDescription({
      skipReason: 'unrecognized_json_sidecar',
      schema: `long.${'x'.repeat(120)}`,
    }),
    `unrecognized JSON sidecar schema: long.${'x'.repeat(72)}...`,
  );
});
