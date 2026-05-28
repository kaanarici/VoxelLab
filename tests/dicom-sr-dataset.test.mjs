import assert from 'node:assert/strict';
import { test } from 'node:test';

const { buildSRDataset } = await import('../js/dicom-sr-dataset.js');

function measurementGroup(dataset, index = 0) {
  return dataset.ContentSequence[2].ContentSequence[index];
}

function itemsFor(dataset) {
  return measurementGroup(dataset).ContentSequence;
}

test('buildSRDataset records uncalibrated lengths as pixel text, not UCUM millimeters', () => {
  const dataset = buildSRDataset({
    slug: 'uncalibrated',
    measurements: [{ kind: 'length', slice: 0, length_px: 12.5 }],
  });
  const items = itemsFor(dataset);

  assert.equal(items.some((item) => item.ValueType === 'NUM'
    && item.MeasuredValueSequence?.[0]?.MeasurementUnitsCodeSequence?.[0]?.CodeValue === 'mm'), false);
  assert.ok(items.some((item) => item.ValueType === 'TEXT' && /12\.5 px \(uncalibrated\)/.test(item.TextValue)));
});

test('buildSRDataset skips missing ROI area instead of inventing or throwing', () => {
  const dataset = buildSRDataset({
    slug: 'roi',
    measurements: [{ kind: 'polygon', slice: 0, stats: { mean: 7.5, std: 1.25 } }],
  });
  const items = itemsFor(dataset);

  assert.equal(items.some((item) => item.ConceptNameCodeSequence?.[0]?.CodeMeaning === 'Area'), false);
  assert.ok(items.some((item) => item.ConceptNameCodeSequence?.[0]?.CodeMeaning === 'Mean'));
  assert.ok(items.some((item) => item.ConceptNameCodeSequence?.[0]?.CodeMeaning === 'Standard Deviation'));
});
