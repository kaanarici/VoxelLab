import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  drawScreenshotContextLabel,
  drawScreenshotScaleBar,
  screenshot2DSuffix,
} = await import('../js/screenshot.js');

function recordingContext() {
  const calls = [];
  return {
    calls,
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    beginPath: () => calls.push(['beginPath']),
    moveTo: (x, y) => calls.push(['moveTo', x, y]),
    lineTo: (x, y) => calls.push(['lineTo', x, y]),
    stroke: () => calls.push(['stroke']),
    fillRect: (x, y, width, height) => calls.push(['fillRect', x, y, width, height]),
    strokeRect: (x, y, width, height) => calls.push(['strokeRect', x, y, width, height]),
    strokeText: (text, x, y) => calls.push(['strokeText', text, x, y]),
    fillText: (text, x, y, maxWidth) => calls.push(['fillText', text, x, y, maxWidth]),
    measureText: (text) => ({ width: String(text).length * 8 }),
    set font(value) { calls.push(['font', value]); },
    set textAlign(value) { calls.push(['textAlign', value]); },
    set textBaseline(value) { calls.push(['textBaseline', value]); },
    set lineWidth(value) { calls.push(['lineWidth', value]); },
    set strokeStyle(value) { calls.push(['strokeStyle', value]); },
    set fillStyle(value) { calls.push(['fillStyle', value]); },
  };
}

function hasCall(calls, expected) {
  return calls.some(call => expected.every((value, index) => call[index] === value));
}

test('drawScreenshotScaleBar renders calibrated source-resolution scale bars', () => {
  const ctx = recordingContext();
  const model = drawScreenshotScaleBar(ctx, {
    width: 256,
    pixelSpacing: [0.00025, 0.0005],
    imageDomain: 'microscopy',
    microscopy: { physicalUnit: 'µm' },
  }, 256, 128);

  assert.equal(model.label, '50 µm');
  assert.equal(model.widthPx, 100);
  assert.ok(ctx.calls.some(call => call[0] === 'fillText' && call[1] === '50 µm'));
  assert.ok(ctx.calls.some(call => call[0] === 'moveTo' && call[1] === 146 && call[2] === 118));
  assert.ok(ctx.calls.some(call => call[0] === 'lineTo' && call[1] === 246 && call[2] === 118));
});

test('drawScreenshotScaleBar skips uncalibrated or too-small exports', () => {
  const unknown = recordingContext();
  assert.equal(drawScreenshotScaleBar(unknown, { width: 256, pixelSpacing: [0, 0] }, 256, 128), null);
  assert.deepEqual(unknown.calls, []);

  const tiny = recordingContext();
  assert.equal(drawScreenshotScaleBar(tiny, {
    width: 16,
    pixelSpacing: [0.00025, 0.0005],
    imageDomain: 'microscopy',
    microscopy: { physicalUnit: 'µm' },
  }, 16, 16), null);
  assert.deepEqual(tiny.calls, []);
});

test('screenshot2DSuffix records active microscopy C/T position', () => {
  assert.equal(screenshot2DSuffix({ slug: 'ct' }, 2), 'z3');
  assert.equal(screenshot2DSuffix({
    imageDomain: 'microscopy',
    microscopy: { channelIndex: 1, timeIndex: 2 },
  }, 0), 'z1_c2_t3');
});

test('drawScreenshotContextLabel records C/Z/T provenance within image bounds', () => {
  const ctx = recordingContext();
  const label = drawScreenshotContextLabel(ctx, {
    imageDomain: 'microscopy',
    microscopy: {
      channelIndex: 2,
      channelName: 'GFP-long-channel-name-that-must-fit',
      timeIndex: 4,
    },
  }, 6, 120, 64);

  assert.equal(label, 'Z 7 · C3 GFP-long-channel-name-that-must-fit · T5');
  assert.ok(hasCall(ctx.calls, ['fillRect', 8, 8, 104, 22]));
  assert.ok(hasCall(ctx.calls, ['strokeRect', 8.5, 8.5, 103, 21]));
  assert.ok(hasCall(ctx.calls, ['fillText', label, 15, 13, 90]));
});

test('drawScreenshotContextLabel skips non-microscopy images', () => {
  const ctx = recordingContext();

  assert.equal(drawScreenshotContextLabel(ctx, { slug: 'ct' }, 0, 120, 64), '');
  assert.deepEqual(ctx.calls, []);
});
