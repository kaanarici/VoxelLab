import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  SORT_POPOVER_OPTIONS,
  sortSeriesArray,
  studyType,
} = await import('../js/projects/projects-sidebar-sort.js');

test('sidebar sort popover names the modality grouping honestly', () => {
  const option = SORT_POPOVER_OPTIONS.find((item) => item.key === 'study-type');
  assert.equal(option?.label, 'Modality');
});

test('modality grouping labels DICOM codes and local fallbacks without inventing sequence types', () => {
  assert.equal(studyType({ modality: 'MR' }), 'MR');
  assert.equal(studyType({ modality: 'ct' }), 'CT');
  assert.equal(studyType({ modality: 'PT' }), 'PET');
  assert.equal(studyType({ modality: 'US' }), 'Ultrasound');
  assert.equal(studyType({ modality: 'OT' }), 'Other');
  assert.equal(studyType({ modality: 'MIC' }), 'Microscopy');
  assert.equal(studyType({ modality: '' }), 'Other');
  assert.equal(studyType({}), 'Other');
});

test('modality sort orders series by display label, not protocol name', () => {
  const series = [
    { name: 'FLAIR', modality: 'MR' },
    { name: 'NIfTI volume', modality: 'OT' },
    { name: 'OME-TIFF', modality: 'MIC' },
    { name: 'Chest', modality: 'CT' },
  ];
  sortSeriesArray(series, 'study-type');
  assert.deepEqual(series.map((item) => studyType(item)), [
    'CT',
    'Microscopy',
    'MR',
    'Other',
  ]);
});
