import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clampScrubberWidthPx,
  scrubberWidthBounds,
} from '../js/shell/toolbar-scrubber-resize.js';

test('clampScrubberWidthPx stays between min and max', () => {
  assert.equal(clampScrubberWidthPx(200, 180, 400), 200);
  assert.equal(clampScrubberWidthPx(100, 180, 400), 180);
  assert.equal(clampScrubberWidthPx(500, 180, 400), 400);
  assert.equal(clampScrubberWidthPx(180.6, 180, 400), 181);
  assert.equal(clampScrubberWidthPx(Number.NaN, 180, 400), 180);
});

test('scrubberWidthBounds uses half of default as the floor', () => {
  assert.deepEqual(scrubberWidthBounds(400, 400), { min: 200, max: 400, defaultWidth: 400 });
  assert.deepEqual(scrubberWidthBounds(400, 900), { min: 200, max: 900, defaultWidth: 400 });
  assert.deepEqual(scrubberWidthBounds(400, 100), { min: 100, max: 100, defaultWidth: 400 });
  assert.deepEqual(scrubberWidthBounds(0, 400), { min: 0, max: 400, defaultWidth: 0 });
});
