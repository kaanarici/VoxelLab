import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installViewerGlobals } from './helpers/node/viewer-globals.mjs';

installViewerGlobals();

const { state } = await import('../js/core/state.js');
const {
  beginSeriesSelection,
  finishSeriesSelection,
  isSeriesSelectionCurrent,
  setRenderMode,
} = await import('../js/core/state/viewer-commands.js');
const { stashRuntimeVolumeCache, transitionVolumeCaches } = await import('../js/runtime/viewer-runtime.js');
const { getAskSession, setAskHistory } = await import('../js/ask-session.js');

function selectWithCaches(index, opts) {
  const previous = state.manifest?.series?.[state.seriesIdx] || null;
  return transitionVolumeCaches(previous, () => beginSeriesSelection(index, opts));
}

function volumeSeries(slug, slices = 8) {
  return {
    slug,
    width: 4,
    height: 4,
    slices,
    geometryKind: 'volumeStack',
    reconstructionCapability: 'display-volume',
    sliceSpacing: 1,
    sliceSpacingRegular: true,
    pixelSpacing: [1, 1],
    orientation: [1, 0, 0, 0, 1, 0],
    firstIPP: [0, 0, 0],
    lastIPP: [0, 0, slices - 1],
  };
}

function rememberedViewFor(slug) {
  return Object.entries(state.seriesViewMemory || {})
    .find(([key]) => key.endsWith(`|${slug}`))?.[1] || null;
}

test('beginSeriesSelection resets runtime-heavy buckets and preserves request guards', () => {
  state._seriesVolumeCacheEntries = [];
  state.manifest = {
    series: [
      { slug: 'cmd_a', slices: 4 },
      { slug: 'cmd_b', slices: 8 },
    ],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 3;
  state.loaded = true;
  state.overlays.analysis = { summary: 'old' };
  state.voxels = new Uint8Array([1, 2, 3]);
  state.voxelsKey = 'old';
  state.hrVoxels = new Float32Array([0.1, 0.2]);
  state.hrKey = 'hr-old';
  state.segImgs = [{ complete: true }];
  state.symImgs = [{ complete: true }];
  state.regionImgs = [{ complete: true }];
  state.overlays.regionMeta = { legend: { 1: 'Region' } };
  state.overlays.stats = { symmetryScores: [1, 2] };
  state.fusionImgs = [{ complete: true }];
  state.fusionVoxels = new Uint8Array([9]);
  state.overlays.fusionSlug = 'peer';
  setAskHistory([{ prompt: 'old' }]);
  state.three.clipMin = [0.1, 0.2, 0.3];
  state.three.clipMax = [0.7, 0.8, 0.9];

  const next = selectWithCaches(1, { preserveSlice: true });

  assert.equal(next.series.slug, 'cmd_b');
  assert.equal(state.seriesIdx, 1);
  assert.equal(state.sliceIdx, 3);
  assert.equal(state.loaded, false);
  assert.equal(state.overlays.analysis, null);
  assert.equal(state.voxels, null);
  assert.equal(state.hrVoxels, null);
  assert.deepEqual(state.segImgs, []);
  assert.deepEqual(state.symImgs, []);
  assert.deepEqual(state.regionImgs, []);
  assert.equal(state.overlays.regionMeta, null);
  assert.equal(state.overlays.stats, null);
  assert.equal(state.fusionImgs, null);
  assert.equal(state.fusionVoxels, null);
  assert.equal(state.overlays.fusionSlug, null);
  assert.deepEqual(getAskSession().history, [{ prompt: 'old' }]);
  assert.deepEqual(state.three.clipMin, [0, 0, 0]);
  assert.deepEqual(state.three.clipMax, [1, 1, 1]);
  assert.equal(isSeriesSelectionCurrent(next.requestId, 'cmd_b'), true);
  assert.equal(isSeriesSelectionCurrent(next.requestId, 'cmd_a'), false);
});

test('beginSeriesSelection defaults unseen series to 2D and restores remembered per-series view state', () => {
  state._seriesVolumeCacheEntries = [];
  state.seriesViewMemory = {};
  state.manifest = {
    series: [
      volumeSeries('memory_a', 9),
      volumeSeries('memory_b', 7),
    ],
  };
  state.seriesIdx = 0;
  state.mode = '3d';
  state.sliceIdx = 6;
  state.loaded = true;

  const firstOpen = beginSeriesSelection(1);

  assert.equal(firstOpen.mode, '2d');
  assert.equal(firstOpen.restoredView, false);
  assert.equal(state.mode, '2d');
  assert.equal(state.sliceIdx, 0);
  const memA = rememberedViewFor('memory_a');
  assert.equal(memA.mode, '3d');
  assert.equal(memA.sliceIdx, 6);

  finishSeriesSelection();
  state.mode = 'mpr';
  state.sliceIdx = 3;
  const reopen = beginSeriesSelection(0);

  assert.equal(reopen.mode, '3d');
  assert.equal(reopen.restoredView, true);
  assert.equal(state.mode, '3d');
  assert.equal(state.sliceIdx, 6);
  const memB = rememberedViewFor('memory_b');
  assert.equal(memB.mode, 'mpr');
  assert.equal(memB.sliceIdx, 3);
});

test('beginSeriesSelection applies an imported series default window and level once', () => {
  state._seriesVolumeCacheEntries = [];
  state.seriesViewMemory = {};
  state.manifest = {
    series: [
      volumeSeries('window_source', 3),
      { ...volumeSeries('window_target', 3), _defaultWindow: 73, _defaultLevel: 91 },
    ],
  };
  state.seriesIdx = 0;
  state.window = 255;
  state.level = 127;
  state.loaded = true;

  const selection = beginSeriesSelection(1);

  assert.equal(selection.restoredView, false);
  assert.equal(state.window, 73);
  assert.equal(state.level, 91);
});

test('setRenderMode rejects sampled extrema previews beyond the shader step contract', () => {
  state.manifest = { series: [{ ...volumeSeries('projection_limit', 1), width: 2049, height: 1 }] };
  state.seriesIdx = 0;
  state.three.renderMode = 'alpha';

  assert.equal(setRenderMode('mip'), 'alpha');
  assert.equal(state.three.renderMode, 'alpha');

  state.manifest.series[0].width = 2048;
  assert.equal(setRenderMode('mip'), 'mip');
  assert.equal(state.three.renderMode, 'mip');
});

test('series selection drops an inherited extrema preview beyond its sampling limit', () => {
  state._seriesVolumeCacheEntries = [];
  state.seriesViewMemory = {};
  state.manifest = {
    series: [
      volumeSeries('projection_small', 2),
      { ...volumeSeries('projection_large', 2), width: 2049 },
    ],
  };
  state.seriesIdx = 0;
  state.three.renderMode = 'mip';
  state.loaded = true;

  beginSeriesSelection(1);

  assert.equal(state.three.renderMode, 'alpha');
});

test('beginSeriesSelection scopes remembered views by study identity when slugs repeat', () => {
  state._seriesVolumeCacheEntries = [];
  state.seriesViewMemory = {};
  const first = {
    ...volumeSeries('repeat_slug', 9),
    sourceStudyUID: 'study-a',
    sourceSeriesUID: 'series-a',
  };
  const second = {
    ...volumeSeries('repeat_slug', 9),
    sourceStudyUID: 'study-b',
    sourceSeriesUID: 'series-b',
  };
  state.manifest = {
    patient: 'anonymous',
    series: [first, second],
  };
  state.seriesIdx = 0;
  state.mode = '3d';
  state.sliceIdx = 5;
  state.loaded = true;

  beginSeriesSelection(1);
  finishSeriesSelection();
  state.mode = 'mpr';
  state.sliceIdx = 2;
  const reopen = beginSeriesSelection(0);

  assert.equal(reopen.mode, '3d');
  assert.equal(state.sliceIdx, 5);
  assert.equal(Object.keys(state.seriesViewMemory).length, 2);
});

test('beginSeriesSelection preserves compare mode only for preserveSlice peer switches', () => {
  state._seriesVolumeCacheEntries = [];
  state.seriesViewMemory = {};
  state.manifest = {
    series: [
      volumeSeries('cmp_memory_a', 9),
      volumeSeries('cmp_memory_b', 5),
    ],
  };
  state.seriesIdx = 0;
  state.mode = 'cmp';
  state.sliceIdx = 7;
  state.loaded = true;

  const peerSwitch = beginSeriesSelection(1, { preserveSlice: true });

  assert.equal(peerSwitch.mode, 'cmp');
  assert.equal(state.mode, 'cmp');
  assert.equal(state.sliceIdx, 4);
  assert.equal(rememberedViewFor('cmp_memory_a').mode, '2d');
});

test('beginSeriesSelection preserves a hydrated view on the first selection', () => {
  state._seriesVolumeCacheEntries = [];
  const series = volumeSeries('initial_memory', 10);
  state.manifest = { patient: 'anonymous', studyDate: '', series: [series] };
  state.seriesIdx = 0;
  state.selectRequestId = 0;
  state.loaded = false;
  state.mode = '2d';
  state.sliceIdx = 0;
  state.overlays.labels = false;
  state.seriesViewMemory = {
    'anonymous||||initial_memory': {
      mode: '3d',
      sliceIdx: 6,
      window: 200,
      level: 90,
      overlays: {
        useBrain: false,
        useSeg: false,
        useRegions: true,
        useSym: false,
      },
      lockedLabels: [],
    },
  };

  const selected = beginSeriesSelection(0);

  assert.equal(selected.restoredView, true);
  assert.equal(state.mode, '3d');
  assert.equal(state.sliceIdx, 6);
  assert.equal(state.overlays.labels, true);
  assert.deepEqual(state.seriesViewMemory['anonymous||||initial_memory'].overlays, {
    useBrain: false,
    tissue: false,
    labels: true,
    heatmap: false,
  });
});

test('beginSeriesSelection restores saved slice but falls back to 2D when saved mode is unsupported', () => {
  state._seriesVolumeCacheEntries = [];
  state.manifest = {
    series: [
      volumeSeries('supported_memory', 6),
      { slug: 'flat_memory', width: 4, height: 4, slices: 3 },
    ],
  };
  state.seriesViewMemory = {
    '||||flat_memory': { mode: '3d', sliceIdx: 8 },
  };
  state.seriesIdx = 0;
  state.mode = '2d';
  state.sliceIdx = 0;

  const next = beginSeriesSelection(1);

  assert.equal(next.mode, '2d');
  assert.equal(next.restoredView, true);
  assert.equal(state.mode, '2d');
  assert.equal(state.sliceIdx, 2);
});

test('beginSeriesSelection restores warm volume caches for recently revisited series', () => {
  state._seriesVolumeCacheEntries = [];
  state.manifest = {
    series: [
      { slug: 'warm_a', width: 2, height: 2, slices: 2 },
      { slug: 'warm_b', width: 2, height: 2, slices: 2 },
    ],
  };
  state.seriesIdx = 0;
  state.overlays.useBrain = false;
  state.overlays.fusionSlug = null;
  const voxA = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const hrA = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
  const segA = new Uint8Array([1, 0, 0, 2]);
  state.voxels = voxA;
  state.voxelsKey = 'old-a';
  state.hrVoxels = hrA;
  state.hrKey = 'old-hr-a';
  state.segVoxels = segA;
  state.symVoxels = null;
  state.regionVoxels = null;
  state.fusionVoxels = null;

  selectWithCaches(1);
  assert.equal(state.voxels, null);
  assert.equal(state.hrVoxels, null);
  const voxB = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);
  state.voxels = voxB;
  state.voxelsKey = 'old-b';
  state.hrVoxels = null;
  state.hrKey = '';
  state.segVoxels = null;

  selectWithCaches(0);
  assert.equal(state.voxels, null, 'hr-backed warm restore should not keep the downgraded uint8 volume');
  assert.equal(state.hrVoxels, hrA);
  assert.equal(state.segVoxels, segA);
  assert.equal(state.hrKey, '0:warm_a:');
});

test('warm volume cache evicts by aggregate bytes and rejects an oversized entry', () => {
  state._seriesVolumeCacheEntries = [];
  state.manifest = { series: [volumeSeries('warm_bounded')] };
  state.seriesIdx = 0;
  state.overlays.useBrain = false;
  state.voxels = new Uint8Array(8);
  state.hrVoxels = null;
  state.segVoxels = null;
  state.symVoxels = null;
  state.regionVoxels = null;
  state.fusionVoxels = null;

  assert.equal(stashRuntimeVolumeCache(state.manifest.series[0], { maxBytes: 7 }), true);
  assert.deepEqual(state._seriesVolumeCacheEntries, []);

  assert.equal(stashRuntimeVolumeCache(state.manifest.series[0], { maxBytes: 8 }), true);
  assert.equal(state._seriesVolumeCacheEntries.length, 1);
  assert.equal(state._seriesVolumeCacheEntries[0].byteLength, 8);
});

test('beginSeriesSelection keeps warm volume caches scoped to study identity when slugs repeat', () => {
  state._seriesVolumeCacheEntries = [];
  const first = {
    ...volumeSeries('repeat_volume', 2),
    sourceStudyUID: 'study-a',
    sourceSeriesUID: 'series-a',
  };
  const second = {
    ...volumeSeries('repeat_volume', 2),
    sourceStudyUID: 'study-b',
    sourceSeriesUID: 'series-b',
  };
  state.manifest = { patient: 'anonymous', series: [first, second] };
  state.seriesIdx = 0;
  state.overlays.useBrain = false;
  const voxA = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const voxB = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);
  state.voxels = voxA;
  state.voxelsKey = 'old-a';
  state.hrVoxels = null;
  state.segVoxels = null;
  state.symVoxels = null;
  state.regionVoxels = null;
  state.fusionVoxels = null;

  selectWithCaches(1);
  assert.equal(state.voxels, null, 'study B must not restore study A voxels just because the slug matches');
  state.voxels = voxB;
  state.voxelsKey = 'old-b';

  selectWithCaches(0);
  assert.equal(state.voxels, voxA);
  assert.equal(state.voxelsKey, 'anonymous|study-a||series-a|repeat_volume|base');
});
