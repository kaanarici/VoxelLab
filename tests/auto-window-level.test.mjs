import assert from 'node:assert/strict';
import { test } from 'node:test';

const { autoWindowLevelFromRgba } = await import('../js/auto-window-level.js');

function rgbaFromValues(values) {
  const data = new Uint8ClampedArray(values.length * 4);
  values.forEach((value, index) => {
    const offset = index * 4;
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  });
  return data;
}

test('autoWindowLevelFromRgba uses robust foreground percentiles', () => {
  const values = [
    ...Array(80).fill(0),
    ...Array(100).fill(40),
    ...Array(100).fill(90),
    ...Array(100).fill(140),
    ...Array(100).fill(210),
    ...Array(20).fill(255),
  ];

  const next = autoWindowLevelFromRgba(rgbaFromValues(values));

  assert.deepEqual(
    { window: next.window, level: next.level, low: next.low, high: next.high, samples: next.samples },
    { window: 215, level: 148, low: 40, high: 255, samples: 420 },
  );
});

test('autoWindowLevelFromRgba refuses tiny foreground samples', () => {
  const values = [
    ...Array(200).fill(0),
    ...Array(20).fill(80),
  ];

  assert.equal(autoWindowLevelFromRgba(rgbaFromValues(values)), null);
});
