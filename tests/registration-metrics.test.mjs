import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installViewerGlobals } from './helpers/node/viewer-globals.mjs';

installViewerGlobals();

const { registrationQualityFromData, registrationRecordFromData } = await import('../js/metadata.js');

test('registration quality parser reads current registration sidecar shape', () => {
  const quality = registrationQualityFromData({
    reference: 't1_se',
    pairs: {
      flair: {
        translation_magnitude_mm: 1.0882392394512812,
        rotation_deg: 0.2639295804557845,
        dice: 0.899039129506268,
        verdict: 'slightly off',
      },
    },
  }, 'flair');

  assert.deepEqual(quality, {
    mm: 1.09,
    measurement: '',
    grade: 'fair',
    dice: 0.899039129506268,
    rotationDeg: 0.26,
    verdict: 'slightly off',
  });
});

test('registration record parser exposes transform and metrics for evidence export', () => {
  const record = registrationRecordFromData({
    reference: 't1_se',
    pairs: {
      flair: {
        translation_mm: [-0.01, 0.16, 1.08],
        translation_magnitude_mm: 1.0882392394512812,
        rotation_deg: 0.2639295804557845,
        rotation_magnitude_mm: 0.36851521378885727,
        mse_normalized: 0.01529048290103674,
        mutual_information: -0.5627987496944827,
        dice: 0.899039129506268,
        verdict: 'slightly off',
      },
    },
    method: "ANTsPy ants.registration type_of_transform='Rigid' to t1_se",
    ants_version: '0.6.3',
    generated_at: '2026-04-09T04:06:07.426217+00:00',
  }, 'flair');

  assert.equal(record.referenceSlug, 't1_se');
  assert.equal(record.movingSlug, 'flair');
  assert.equal(record.transform.type, 'rigid');
  assert.deepEqual(record.transform.translationMm, [-0.01, 0.16, 1.08]);
  assert.equal(record.transform.translationMagnitudeMm, 1.0882392394512812);
  assert.equal(record.metrics.dice, 0.899039129506268);
  assert.equal(record.quality.mm, 1.09);
});

test('unavailable registration metrics stay unknown instead of becoming zero', () => {
  for (const value of [null, '', ' ', false, []]) {
    const quality = registrationQualityFromData({ pairs: { moving: {
      translation_magnitude_mm: value, dice: value, rotation_deg: value,
    } } }, 'moving');
    assert.equal(quality.mm, null);
    assert.equal(quality.dice, null);
    assert.equal(quality.rotationDeg, null);
    assert.equal(quality.grade, 'unknown');
  }
  const quality = registrationQualityFromData({ pairs: { moving: {
    translation_magnitude_mm: 0, dice: 0, rotation_deg: 0,
  } } }, 'moving');
  assert.equal(quality.mm, 0);
  assert.equal(quality.dice, 0);
  assert.equal(quality.rotationDeg, 0);
});
