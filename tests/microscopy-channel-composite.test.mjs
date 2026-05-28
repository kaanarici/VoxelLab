import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  channelDisplayColor,
  drawMicroscopyChannelComposite,
  drawMicroscopyChannelSplit,
  ensureMicroscopyComposite,
  setMicroscopyCompositeChannelEnabled,
} = await import('../js/microscopy-channel-composite.js');

function context(width, height) {
  const calls = [];
  return {
    calls,
    createImageData(w, h) {
      assert.equal(w, width);
      assert.equal(h, height);
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(image, x = 0, y = 0) {
      calls.push({ image, x, y });
    },
  };
}

test('drawMicroscopyChannelComposite adds channel LUT colors and clips at 255', () => {
  const ctx = context(2, 1);

  assert.equal(drawMicroscopyChannelComposite(ctx, 2, 1, {
    sources: [
      { index: 0, channel: { color: '#0000FF' }, bytes: Uint8Array.from([255, 128]) },
      { index: 1, channel: { color: '#00FF00' }, bytes: Uint8Array.from([255, 128]) },
      { index: 2, channel: { color: '#FF0000' }, bytes: Uint8Array.from([255, 0]) },
    ],
    window: 255,
    level: 128,
  }), true);

  assert.deepEqual([...ctx.calls[0].image.data], [
    255, 255, 255, 255,
    0, 128, 128, 255,
  ]);
});

test('composite state keeps at least one visible channel', () => {
  const series = { microscopy: {} };
  const composite = ensureMicroscopyComposite(series, 2);
  composite.enabled = true;

  assert.deepEqual(composite.channels, [true, true]);
  assert.equal(setMicroscopyCompositeChannelEnabled(series, 0, false, 2), true);
  assert.equal(setMicroscopyCompositeChannelEnabled(series, 1, false, 2), false);
  assert.deepEqual(series.microscopy.composite.channels, [false, true]);
});

test('drawMicroscopyChannelComposite colorizes a single visible channel', () => {
  const ctx = context(1, 1);

  assert.equal(drawMicroscopyChannelComposite(ctx, 1, 1, {
    sources: [{ index: 0, channel: { color: '#0000FF' }, bytes: Uint8Array.from([200]) }],
    window: 255,
    level: 128,
  }), true);
  assert.deepEqual([...ctx.calls[0].image.data], [0, 0, 200, 255]);
});

test('drawMicroscopyChannelComposite applies per-channel byte display ranges', () => {
  const ctx = context(3, 1);

  assert.equal(drawMicroscopyChannelComposite(ctx, 3, 1, {
    sources: [{
      index: 0,
      channel: { color: '#FF0000' },
      bytes: Uint8Array.from([50, 150, 250]),
      displayRange: [100, 200],
    }],
    window: 255,
    level: 128,
  }), true);

  assert.deepEqual([...ctx.calls[0].image.data], [
    0, 0, 0, 255,
    128, 0, 0, 255,
    255, 0, 0, 255,
  ]);
});

test('drawMicroscopyChannelComposite keeps display range endpoints outside byte bounds', () => {
  const ctx = context(2, 1);

  assert.equal(drawMicroscopyChannelComposite(ctx, 2, 1, {
    sources: [{
      index: 0,
      channel: { color: '#FF0000' },
      bytes: Uint8Array.from([0, 255]),
      displayRange: [85, 17000],
    }],
  }), true);

  assert.deepEqual([...ctx.calls[0].image.data], [
    0, 0, 0, 255,
    3, 0, 0, 255,
  ]);
});

test('drawMicroscopyChannelSplit renders each selected channel into its own tile', () => {
  const ctx = context(1, 1);

  assert.equal(drawMicroscopyChannelSplit(ctx, 1, 1, {
    sources: [
      { index: 0, channel: { color: '#0000FF' }, bytes: Uint8Array.from([200]) },
      { index: 1, channel: { color: '#00FF00', displayColor: '#AA00CC' }, bytes: Uint8Array.from([100]) },
    ],
    tileGap: 2,
  }), true);

  assert.equal(ctx.calls.length, 2);
  assert.deepEqual([ctx.calls[0].x, ctx.calls[0].y, ...ctx.calls[0].image.data], [0, 0, 0, 0, 200, 255]);
  assert.deepEqual([ctx.calls[1].x, ctx.calls[1].y, ...ctx.calls[1].image.data], [3, 0, 67, 0, 80, 255]);
});

test('channelDisplayColor preserves OME colors and falls back by channel index', () => {
  assert.equal(channelDisplayColor({ color: '#00ff00', displayColor: '#AA00cc' }, 0), '#AA00CC');
  assert.equal(channelDisplayColor({ color: '#00ff00' }, 0), '#00FF00');
  assert.equal(channelDisplayColor({}, 0), '#FF0000');
  assert.equal(channelDisplayColor({}, 2), '#0000FF');
});
