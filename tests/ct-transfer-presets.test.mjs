import assert from 'node:assert/strict';
import { test } from 'node:test';

const { CT_HU_LO, CT_HU_HI, CT_HU_RANGE, CT_WINDOWS } = await import('../js/core/constants.js');

function approx(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ~= ${expected}`);
}

test('CT 3D transfer presets are derived from conventional HU window width and level', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(CT_WINDOWS).map(([key, value]) => [
      key,
      {
        width: value.width,
        level: value.level,
        lowHu: value.lowHu,
        highHu: value.highHu,
      },
    ])),
    {
      full: { width: CT_HU_RANGE, level: 512, lowHu: CT_HU_LO, highHu: CT_HU_HI },
      soft: { width: 400, level: 50, lowHu: -150, highHu: 250 },
      lung: { width: 1500, level: -500, lowHu: CT_HU_LO, highHu: 250 },
      bone: { width: 2000, level: 300, lowHu: -700, highHu: 1300 },
    },
  );

  approx(CT_WINDOWS.soft.lowT, (-150 - CT_HU_LO) / CT_HU_RANGE);
  approx(CT_WINDOWS.soft.highT, (250 - CT_HU_LO) / CT_HU_RANGE);
  approx(CT_WINDOWS.lung.lowT, 0);
  approx(CT_WINDOWS.lung.highT, (250 - CT_HU_LO) / CT_HU_RANGE);
  approx(CT_WINDOWS.bone.lowT, (-700 - CT_HU_LO) / CT_HU_RANGE);
  approx(CT_WINDOWS.bone.highT, (1300 - CT_HU_LO) / CT_HU_RANGE);
});
