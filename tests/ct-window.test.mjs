import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ctWindowToWL, CT_WINDOWS } from '../js/core/constants.js';

// The 2D base byte linearly encodes the [-1024, +2048] HU band (range 3072), so
// a CT HU window maps to an 8-bit W/L: window = round(WW/3072*255),
// level = round((WL+1024)/3072*255), clamped to the sliders' ranges.

test('Full window is the default full-range 8-bit W/L', () => {
  assert.deepEqual(ctWindowToWL(CT_WINDOWS.full), { window: 255, level: 128 });
});

test('Soft / Lung / Bone map to their conventional HU windows in 8-bit', () => {
  assert.deepEqual(ctWindowToWL(CT_WINDOWS.soft), { window: 33, level: 89 });
  assert.deepEqual(ctWindowToWL(CT_WINDOWS.lung), { window: 125, level: 43 });
  assert.deepEqual(ctWindowToWL(CT_WINDOWS.bone), { window: 166, level: 110 });
});

test('every preset stays within the W/L slider bounds', () => {
  for (const key of Object.keys(CT_WINDOWS)) {
    const { window, level } = ctWindowToWL(CT_WINDOWS[key]);
    assert.ok(window >= 1 && window <= 512, `${key} window in [1,512]`);
    assert.ok(level >= 0 && level <= 255, `${key} level in [0,255]`);
  }
});
