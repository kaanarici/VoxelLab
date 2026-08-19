import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const {
  channelDisplayColor,
  drawMicroscopyChannelComposite,
  drawMicroscopyChannelSplit,
  ensureMicroscopyComposite,
  setMicroscopyCompositeChannelEnabled,
  setMicroscopyCompositeEnabled,
} = await import('../js/microscopy/microscopy-channel-composite.js');
const { state } = await import('../js/core/state.js');
const { isolatedHostWrites } = await import('../js/runtime/isolated-host.js');

function context(expectedWidth = null, expectedHeight = null) {
  const calls = [];
  const created = [];
  return {
    calls,
    created,
    createImageData(w, h) {
      if (expectedWidth !== null) assert.equal(w, expectedWidth);
      if (expectedHeight !== null) assert.equal(h, expectedHeight);
      created.push({ width: w, height: h });
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(image, x = 0, y = 0) {
      calls.push({
        image: {
          width: image.width,
          height: image.height,
          data: Uint8ClampedArray.from(image.data),
        },
        x,
        y,
      });
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
  const series = { slug: 'iso_composite', microscopy: {} };
  const host = { manifest: { series: [series] } };
  const writes = isolatedHostWrites();
  const composite = ensureMicroscopyComposite(series, 2, host, writes);
  composite.enabled = true;

  assert.deepEqual(composite.channels, [true, true]);
  assert.equal(setMicroscopyCompositeChannelEnabled(series, 0, false, 2, host, writes), true);
  assert.equal(setMicroscopyCompositeChannelEnabled(series, 1, false, 2, host, writes), false);
  assert.deepEqual(series.microscopy.composite.channels, [false, true]);
});

test('live composite writes replace the manifest series slot', () => {
  const original = { slug: 'live_composite', microscopy: { channelIndex: 0 } };
  state.manifest = { series: [original] };

  const computed = ensureMicroscopyComposite(original, 2);
  assert.deepEqual(computed, { enabled: false, channels: [true, true] });
  assert.equal(original.microscopy.composite, undefined);

  assert.equal(setMicroscopyCompositeEnabled(original, true, 2), true);
  const live = state.manifest.series[0];
  assert.notEqual(live, original);
  assert.equal(live.microscopy.composite.enabled, true);
  assert.deepEqual(live.microscopy.composite.channels, [true, true]);
  assert.equal(original.microscopy.composite, undefined);
});

test('live composite writes no-op when the series is not in the live list', () => {
  const orphan = { slug: 'orphan_composite', microscopy: { channelIndex: 0 } };
  state.manifest = { series: [{ slug: 'live_other', microscopy: { channelIndex: 0 } }] };

  setMicroscopyCompositeEnabled(orphan, true, 2);

  assert.equal(orphan.microscopy.composite, undefined);
  assert.equal(state.manifest.series[0].microscopy?.composite, undefined);
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

test('drawMicroscopyChannelComposite reuses same-dimension image and overwrites stale pixels', () => {
  const ctx = context(4, 1);

  assert.equal(drawMicroscopyChannelComposite(ctx, 4, 1, {
    sources: [{ index: 0, channel: { color: '#FF0000' }, bytes: Uint8Array.from([255, 128, 64, 32]) }],
    window: 255,
    level: 128,
  }), true);
  assert.equal(ctx.created.length, 1);
  assert.deepEqual([...ctx.calls[0].image.data], [
    255, 0, 0, 255,
    128, 0, 0, 255,
    64, 0, 0, 255,
    32, 0, 0, 255,
  ]);

  assert.equal(drawMicroscopyChannelComposite(ctx, 4, 1, {
    sources: [{ index: 0, channel: { color: '#FF0000' }, bytes: Uint8Array.from([0, 0, 0, 0]) }],
    window: 255,
    level: 128,
  }), true);
  assert.equal(ctx.created.length, 1);
  assert.deepEqual([...ctx.calls[1].image.data], [
    0, 0, 0, 255,
    0, 0, 0, 255,
    0, 0, 0, 255,
    0, 0, 0, 255,
  ]);
});

test('drawMicroscopyChannelComposite reallocates when dimensions change', () => {
  const ctx = context();

  assert.equal(drawMicroscopyChannelComposite(ctx, 5, 1, {
    sources: [{ index: 0, channel: { color: '#FFFFFF' }, bytes: Uint8Array.from([1, 2, 3, 4, 5]) }],
  }), true);
  assert.deepEqual(ctx.created, [{ width: 5, height: 1 }]);

  assert.equal(drawMicroscopyChannelComposite(ctx, 6, 1, {
    sources: [{ index: 0, channel: { color: '#FFFFFF' }, bytes: Uint8Array.from([1, 2, 3, 4, 5, 6]) }],
  }), true);
  assert.deepEqual(ctx.created, [
    { width: 5, height: 1 },
    { width: 6, height: 1 },
  ]);

  assert.equal(drawMicroscopyChannelComposite(ctx, 5, 1, {
    sources: [{ index: 0, channel: { color: '#FFFFFF' }, bytes: Uint8Array.from([5, 4, 3, 2, 1]) }],
  }), true);
  assert.deepEqual(ctx.created, [
    { width: 5, height: 1 },
    { width: 6, height: 1 },
    { width: 5, height: 1 },
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

test('drawMicroscopyChannelSplit reuses one scratch image and snapshots distinct tiles', () => {
  const ctx = context(6, 1);

  assert.equal(drawMicroscopyChannelSplit(ctx, 6, 1, {
    sources: [
      { index: 0, channel: { color: '#FF0000' }, bytes: Uint8Array.from([255, 0, 0, 0, 0, 0]) },
      { index: 1, channel: { color: '#0000FF' }, bytes: Uint8Array.from([0, 255, 0, 0, 0, 0]) },
    ],
    tileGap: 2,
  }), true);

  assert.equal(ctx.created.length, 1);
  assert.equal(ctx.calls.length, 2);
  assert.deepEqual([ctx.calls[0].x, ctx.calls[0].y], [0, 0]);
  assert.deepEqual([ctx.calls[1].x, ctx.calls[1].y], [8, 0]);
  assert.deepEqual([...ctx.calls[0].image.data], [
    255, 0, 0, 255,
    0, 0, 0, 255,
    0, 0, 0, 255,
    0, 0, 0, 255,
    0, 0, 0, 255,
    0, 0, 0, 255,
  ]);
  assert.deepEqual([...ctx.calls[1].image.data], [
    0, 0, 0, 255,
    0, 0, 255, 255,
    0, 0, 0, 255,
    0, 0, 0, 255,
    0, 0, 0, 255,
    0, 0, 0, 255,
  ]);
  const firstTileSnapshot = [...ctx.calls[0].image.data];

  assert.equal(drawMicroscopyChannelSplit(ctx, 6, 1, {
    sources: [
      { index: 0, channel: { color: '#FF0000' }, bytes: Uint8Array.from([0, 0, 0, 0, 0, 0]) },
      { index: 1, channel: { color: '#0000FF' }, bytes: Uint8Array.from([0, 0, 0, 0, 0, 0]) },
    ],
    tileGap: 2,
  }), true);

  assert.equal(ctx.created.length, 1);
  assert.deepEqual([...ctx.calls[0].image.data], firstTileSnapshot);
  assert.deepEqual([...ctx.calls[2].image.data], [
    0, 0, 0, 255,
    0, 0, 0, 255,
    0, 0, 0, 255,
    0, 0, 0, 255,
    0, 0, 0, 255,
    0, 0, 0, 255,
  ]);
});

test('channelDisplayColor preserves OME colors and falls back by channel index', () => {
  assert.equal(channelDisplayColor({ color: '#00ff00', displayColor: '#AA00cc' }, 0), '#AA00CC');
  assert.equal(channelDisplayColor({ color: '#00ff00' }, 0), '#00FF00');
  assert.equal(channelDisplayColor({}, 0), '#FF0000');
  assert.equal(channelDisplayColor({}, 2), '#0000FF');
});

test('isolated composite writes refuse without a writes adapter', () => {
  const series = { slug: 'iso_composite_refuse', microscopy: {} };
  const host = { manifest: { series: [series] } };

  ensureMicroscopyComposite(series, 2, host);
  setMicroscopyCompositeEnabled(series, true, 2, host);

  assert.equal(series.microscopy.composite, undefined);
});

test('live composite module does not assign series.microscopy in place', () => {
  const src = readFileSync(new URL('../js/microscopy/microscopy-channel-composite.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /writeHost/);
  assert.doesNotMatch(src, /series\.microscopy\.composite\s*=/);
});
