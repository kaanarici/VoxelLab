import assert from 'node:assert/strict';
import { test } from 'node:test';

const { frameMetasForInstance } = await import('../js/dicom/dicom-frame-meta.js');

test('frameMetasForInstance applies per-frame pixel transforms before shared and root values', () => {
  const frames = frameMetasForInstance({
    NumberOfFrames: 3,
    RescaleSlope: 9,
    RescaleIntercept: -900,
    SharedFunctionalGroupsSequence: [{
      PlaneOrientationSequence: [{ ImageOrientationPatient: [1, 0, 0, 0, 1, 0] }],
      PixelMeasuresSequence: [{ PixelSpacing: [1, 1] }],
      PixelValueTransformationSequence: [{ RescaleSlope: 3, RescaleIntercept: -30 }],
    }],
    PerFrameFunctionalGroupsSequence: [
      {
        PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 0] }],
        PixelValueTransformationSequence: [{ RescaleSlope: 2, RescaleIntercept: -20 }],
      },
      {
        PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 1] }],
      },
      {
        PlanePositionSequence: [{ ImagePositionPatient: [0, 0, 2] }],
        PixelValueTransformationSequence: [{ RescaleSlope: 4 }],
      },
    ],
  });

  assert.deepEqual(frames.map(({ RescaleSlope, RescaleIntercept }) => [RescaleSlope, RescaleIntercept]), [
    [2, -20],
    [3, -30],
    [4, -30],
  ]);
});
