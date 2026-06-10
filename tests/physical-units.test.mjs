import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  isKnownLengthUnit,
  lengthUnitToMm,
  normalizeLengthUnit,
} = await import('../js/core/physical-units.js');

test('physical unit conversion covers OME-NGFF space unit names', () => {
  assert.equal(normalizeLengthUnit('meter'), 'm');
  assert.equal(normalizeLengthUnit('centimeter'), 'cm');
  assert.equal(normalizeLengthUnit('micrometer'), 'µm');
  assert.equal(lengthUnitToMm('meter'), 1000);
  assert.equal(lengthUnitToMm('centimeter'), 10);
  assert.equal(lengthUnitToMm('angstrom'), 0.0000001);
  assert.equal(lengthUnitToMm('inch'), 25.4);
  assert.equal(isKnownLengthUnit('micrometer'), true);
  assert.equal(isKnownLengthUnit('not-a-length-unit'), false);
  assert.equal(isKnownLengthUnit(''), false);
});
