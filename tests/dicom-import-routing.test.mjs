import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeModality } from '../js/dicom/dicom-meta.js';
import { isDerivedObjectModality } from '../js/dicom/dicom-import-routing.js';

test('normalizeModality keeps the default unknown code while allowing explicit empty fallback', () => {
  assert.equal(normalizeModality(' ct '), 'CT');
  assert.equal(normalizeModality(''), 'OT');
  assert.equal(normalizeModality('', ''), '');
});

test('isDerivedObjectModality keeps supported derived DICOM modalities in the lightweight routing layer', () => {
  for (const modality of ['SEG', 'RTSTRUCT', 'SR', 'RTDOSE']) {
    assert.equal(isDerivedObjectModality(modality), true, `${modality} should route as a derived object`);
  }
  assert.equal(isDerivedObjectModality('CT'), false);
  assert.equal(isDerivedObjectModality(''), false);
});
