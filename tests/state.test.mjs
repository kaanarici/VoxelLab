import assert from 'node:assert/strict';
import { test } from 'node:test';
import { URL } from 'node:url';
import { createInitialAppModel } from '../js/core/state/app-model.js';
import { createInitialRuntimeState } from '../js/core/state/runtime-state.js';

globalThis.location = new URL('http://127.0.0.1/');

const {
  state,
  subscribe,
  batch,
  getStateSnapshot,
  setPassthroughRootEntry,
} = await import('../js/core/state.js');
const { setLocalRuntimeMapEntry, hostWritesFor, isLiveViewerHost, LIVE_HOST_WRITES } = await import('../js/runtime/viewer-runtime.js');
const { isolatedHostWrites } = await import('../js/runtime/isolated-host.js');
const { ensureVoxels, tryFlattenVoxelsInWorker } = await import('../js/volume/volume-voxels-ensure.js');
const { createLocalByteSlice } = await import('../js/series/local-byte-slice.js');

test('batch coalesces repeated writes into one notification with the final value', () => {
  const seen = [];
  const unsubscribe = subscribe('sliceIdx', (value) => seen.push(value));

  batch(() => {
    state.sliceIdx = 3;
    state.sliceIdx = 8;
  });

  unsubscribe();
  assert.deepEqual(seen, [8]);
  assert.equal(state.sliceIdx, 8);
});

test('nested grouped fields notify on the nested path only', () => {
  const seen = [];
  const unsubscribeLow = subscribe('three.lowT', (value) => seen.push(['three.lowT', value]));
  const unsubscribeClip = subscribe('three.clipMin', (value) => seen.push(['three.clipMin', [...value]]));

  batch(() => {
    state.three.lowT = 0.24;
    state.three.clipMin = [0.1, 0.2, 0.3];
  });

  unsubscribeLow();
  unsubscribeClip();

  assert.equal(state.three.lowT, 0.24);
  assert.deepEqual(state.three.clipMin, [0.1, 0.2, 0.3]);
  assert.deepEqual(seen.sort((a, b) => a[0].localeCompare(b[0])), [
    ['three.clipMin', [0.1, 0.2, 0.3]],
    ['three.lowT', 0.24],
  ]);
});

test('nested array element writes notify the parent path', () => {
  state.three.clipMax = [1, 1, 1];
  const seen = [];
  const unsubscribe = subscribe('three.clipMax', (value) => seen.push([...value]));

  state.three.clipMax[2] = 0.42;

  unsubscribe();

  assert.deepEqual(seen, [[1, 1, 0.42]]);
});

test('state exposes explicit collection and tool defaults without lazy module init', () => {
  const snapshot = getStateSnapshot();

  assert.ok(Object.hasOwn(snapshot, 'measurements'));
  assert.ok(Object.hasOwn(snapshot, 'angleMeasurements'));
  assert.ok(Object.hasOwn(snapshot, 'rois'));
  assert.ok(Object.hasOwn(snapshot, 'notes'));
  assert.ok(Object.hasOwn(snapshot, 'anglePending'));
  assert.ok(Object.hasOwn(snapshot, 'angleMode'));
  assert.ok(Object.hasOwn(snapshot, 'hiddenLabels'));
  assert.ok(Object.hasOwn(snapshot, 'viewerSession'));
  assert.deepEqual(snapshot.measurements, {});
  assert.deepEqual(snapshot.angleMeasurements, {});
  assert.deepEqual(snapshot.rois, {});
  assert.deepEqual(snapshot.notes, {});
  assert.equal(snapshot.anglePending, null);
  assert.equal(snapshot.angleMode, false);
  assert.deepEqual(snapshot.hiddenLabels, []);
  assert.equal(snapshot.mpr.gpuEnabled, true);
});

test('initial app and runtime models have disjoint root ownership', () => {
  const appRoots = new Set(Object.keys(createInitialAppModel()));
  const duplicateRoots = Object.keys(createInitialRuntimeState()).filter(key => appRoots.has(key));

  assert.deepEqual(duplicateRoots, []);
  assert.equal(appRoots.has('imgs'), false);
});

test('passthrough compare stack writes notify root subscribers', () => {
  state.cmpStacks = {};
  const seen = [];
  const offCmp = subscribe('cmpStacks', (value) => seen.push(['cmpStacks', value.peer?.length || 0]));

  setPassthroughRootEntry('cmpStacks', 'peer', [{ complete: true, naturalWidth: 4 }]);

  offCmp();

  assert.deepEqual(seen, [['cmpStacks', 1]]);
});

test('local runtime map entry writes notify passthrough subscribers', () => {
  state._localStacks = {};
  const seen = [];
  const off = subscribe('_localStacks', (value) => seen.push(value.cmd_local?.length || 0));

  setLocalRuntimeMapEntry('_localStacks', 'cmd_local', [{ complete: true }]);

  off();
  assert.deepEqual(seen, [1]);
  assert.equal(state._localStacks.cmd_local[0].complete, true);
});

test('nested measurement writes notify root subscribers', () => {
  state.measurements = { 'series|0': [] };
  const seen = [];
  const offMeasure = subscribe('measurements', (value) => seen.push(['measurements', value['series|0'].map((item) => item.mm)]));

  state.measurements['series|0'].push({ mm: 12.5 });

  offMeasure();

  assert.deepEqual(seen, [['measurements', [12.5]]]);
});

test('nested angle writes notify root subscribers', () => {
  state.angleMeasurements = { 'series|0': [] };
  const seen = [];
  const offAngle = subscribe('angleMeasurements', (value) => seen.push(['angleMeasurements', value['series|0'].map((item) => item.deg)]));

  state.angleMeasurements['series|0'].push({ deg: 33.5 });

  offAngle();

  assert.deepEqual(seen, [['angleMeasurements', [33.5]]]);
});

test('state snapshots are deeply frozen', () => {
  const snapshot = getStateSnapshot();

  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.mpr), true);
  assert.equal(Object.isFrozen(snapshot.three.clipMin), true);
  assert.throws(() => {
    snapshot.sliceIdx = 99;
  });
});

test('state snapshots include nested display roots without flat aliases', () => {
  state.three.clipMin = [0.12, 0.24, 0.36];

  const snapshot = getStateSnapshot();

  assert.deepEqual(snapshot.three.clipMin, [0.12, 0.24, 0.36]);
  assert.equal(Object.hasOwn(snapshot, 'clipMin'), false);
});

test('state snapshots do not recurse into cyclic runtime objects', () => {
  const runtime = { label: 'renderer' };
  runtime.self = runtime;
  state.threeRuntime.renderer = runtime;
  state.threeRuntime.mesh = { owner: runtime };
  state.voxels = new Uint8Array([1, 2, 3]);

  const snapshot = getStateSnapshot();

  assert.equal('renderer' in snapshot.three, false);
  assert.equal('mesh' in snapshot.three, false);
  assert.deepEqual(snapshot.voxels, { type: 'Uint8Array', length: 3 });
});

test('cached base voxels can still hydrate overlay volumes later', () => {
  state.manifest = {
    series: [{
      slug: 'local_overlay_case',
      width: 2,
      height: 2,
      slices: 2,
      hasSeg: false,
      hasRegions: true,
    }],
  };
  state.seriesIdx = 0;
  state.overlays.useBrain = false;
  state.overlays.labels = false;
  state.regionVoxels = null;
  state.voxels = null;
  state.voxelsKey = '';
  state._localRawVolumes = {
    local_overlay_case: new Float32Array([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]),
  };
  state._localRegionLabelSlicesBySlug = {
    local_overlay_case: [
      new Uint8Array([1, 0, 2, 0]),
      new Uint8Array([0, 3, 0, 4]),
    ],
  };

  assert.equal(ensureVoxels(), true);
  assert.equal(state.regionVoxels, null);

  state.overlays.labels = true;
  assert.equal(ensureVoxels(), true);
  assert.deepEqual([...state.regionVoxels], [1, 0, 2, 0, 0, 3, 0, 4]);
});

test('ensureVoxels rebuilds an evicted local raw volume from compact byte slices', () => {
  state.manifest = {
    series: [{ slug: 'local_bytes', width: 2, height: 1, slices: 2 }],
  };
  state.seriesIdx = 0;
  state.overlays.useBrain = false;
  state.voxels = null;
  state.voxelsKey = '';
  state._localRawVolumes = {};
  state.imgs = [
    createLocalByteSlice(Uint8Array.from([1, 2]), 2, 1),
    createLocalByteSlice(Uint8Array.from([3, 4]), 2, 1),
  ];

  assert.equal(ensureVoxels(), true);
  assert.deepEqual([...state.voxels], [1, 2, 3, 4]);
});

test('ensureVoxels keys cached volumes by series identity, not list position', () => {
  const oldVoxels = new Uint8Array([7]);
  state.manifest = {
    patient: 'anonymous',
    series: [{
      slug: 'cache_b',
      sourceStudyUID: 'study-b',
      sourceSeriesUID: 'series-b',
      width: 1,
      height: 1,
      slices: 1,
    }],
  };
  state.seriesIdx = 0;
  state.overlays.useBrain = false;
  state.voxels = oldVoxels;
  state.voxelsKey = '0|base';
  state.segVoxels = null;
  state.regionVoxels = null;
  state._localRawVolumes = {
    cache_b: new Float32Array([0.5]),
  };

  assert.equal(ensureVoxels(), true);

  assert.notEqual(state.voxels, oldVoxels);
  assert.deepEqual([...state.voxels], [128]);
  assert.equal(state.voxelsKey, 'anonymous|study-b||series-b|cache_b|base');
});

test('ensureVoxels does not duplicate an in-flight worker flatten on the main thread', async (t) => {
  const previousWorker = globalThis.Worker;
  const previousOffscreenCanvas = globalThis.OffscreenCanvas;
  const previousCreateImageBitmap = globalThis.createImageBitmap;
  const previousDocument = globalThis.document;
  const previousWarn = globalThis.console.warn;
  let releaseBitmap;
  const bitmapReady = new Promise((resolve) => { releaseBitmap = resolve; });

  t.after(() => {
    globalThis.Worker = previousWorker;
    globalThis.OffscreenCanvas = previousOffscreenCanvas;
    globalThis.createImageBitmap = previousCreateImageBitmap;
    globalThis.document = previousDocument;
    globalThis.console.warn = previousWarn;
  });

  globalThis.console.warn = () => {};
  globalThis.Worker = class ThrowingWorker {
    set onmessage(_handler) {}
    postMessage() {
      throw new Error('worker unavailable after bitmap creation');
    }
  };
  globalThis.OffscreenCanvas = class {};
  globalThis.createImageBitmap = () => bitmapReady;
  globalThis.document = {
    createElement() {
      throw new Error('sync canvas flatten should not run while worker flatten is pending');
    },
  };

  state.manifest = {
    series: [{
      slug: 'pending_worker_case',
      width: 2,
      height: 2,
      slices: 1,
    }],
  };
  state.seriesIdx = 0;
  state.overlays.useBrain = false;
  state.voxels = null;
  state.voxelsKey = '';
  state.imgs = [{ complete: true, naturalWidth: 2 }];
  state._localRawVolumes = {};

  const pending = tryFlattenVoxelsInWorker();

  assert.equal(ensureVoxels(), false);

  releaseBitmap({ close() {} });
  assert.equal(await pending, false);
});

test('hostWritesFor treats only the live state object as the live host', () => {
  assert.equal(isLiveViewerHost(null), false);
  assert.equal(isLiveViewerHost(undefined), false);
  assert.equal(isLiveViewerHost({}), false);
  assert.equal(isLiveViewerHost(state), true);
  assert.equal(hostWritesFor(null), null);
  assert.equal(hostWritesFor(undefined), null);
  assert.equal(hostWritesFor({}), null);
  assert.equal(hostWritesFor(state), LIVE_HOST_WRITES);
  const adapter = isolatedHostWrites();
  assert.equal(hostWritesFor(state, adapter), LIVE_HOST_WRITES);
  const isolated = {};
  assert.equal(hostWritesFor(isolated, adapter), adapter);
});
