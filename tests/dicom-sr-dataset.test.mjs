import assert from 'node:assert/strict';
import { test } from 'node:test';
import dcmjs from 'dcmjs';

const { buildSRDataset } = await import('../js/dicom/dicom-sr-dataset.js');

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

test('buildSRDataset records the stable source SeriesInstanceUID for deferred re-import', () => {
  const dataset = buildSRDataset({
    slug: 'local_old_slug',
    sourceSeriesUID: '1.2.3.4.5',
    measurements: [{ kind: 'length', slice: 0, length_mm: 4 }],
  });
  const groupItems = itemsFor(dataset);

  assert.equal(dataset.ReferencedSeriesSequence[0].SeriesInstanceUID, '1.2.3.4.5');
  assert.ok(groupItems.some((item) => item.ValueType === 'UIDREF'
    && item.ConceptNameCodeSequence?.[0]?.CodeMeaning === 'Referenced Series UID'
    && item.UID === '1.2.3.4.5'));
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

test('buildSRDataset writes through dcmjs DicomDict for browser export', () => {
  const dataset = buildSRDataset({
    slug: 'roi',
    sourceSeriesUID: '1.2.3.4.5.6',
    measurements: [{ kind: 'polygon', slice: 0, stats: { area_mm2: 12.5, mean: 7.5, std: 1.25 } }],
  });
  const DicomMetaDictionary = dcmjs.data.DicomMetaDictionary;
  const dict = new dcmjs.data.DicomDict(DicomMetaDictionary.denaturalizeDataset(dataset._meta));
  dict.dict = DicomMetaDictionary.denaturalizeDataset(dataset);
  const buffer = dict.write();
  assert.ok(buffer.byteLength > 512);
});
