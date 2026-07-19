import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { URL } from 'node:url';

const previousGlobals = {
  location: globalThis.location,
  Worker: globalThis.Worker,
  OffscreenCanvas: globalThis.OffscreenCanvas,
  createImageBitmap: globalThis.createImageBitmap,
};
const workers = [];

class ControlledWorker {
  constructor() {
    this.messages = [];
    workers.push(this);
  }

  postMessage(message) {
    this.messages.push(message);
  }

  respond(message, bytes) {
    this.onmessage({
      data: { id: message.id, type: 'flatten-result', bytes },
    });
  }

  terminate() {}
}

globalThis.location = new URL('http://127.0.0.1/');
globalThis.Worker = ControlledWorker;
globalThis.OffscreenCanvas = class OffscreenCanvas {};
globalThis.createImageBitmap = async (source) => ({ source, close() {} });

const { state } = await import('../js/core/state.js');
const { initOverlayVolumes, ensureActiveOverlayVolumes } = await import('../js/overlay/overlay-volumes.js');
const { beginViewerRuntimeSession } = await import('../js/runtime/viewer-session.js');
const { tryFlattenVoxelsInWorker } = await import('../js/volume/volume-voxels-ensure.js');
const { terminateVolumeWorker } = await import('../js/volume/volume-worker-client.js');

after(() => {
  terminateVolumeWorker();
  for (const [name, value] of Object.entries(previousGlobals)) {
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
});

function series(study, seriesUid) {
  return {
    slug: 'repeat_volume',
    sourceStudyUID: study,
    sourceSeriesUID: seriesUid,
    width: 1,
    height: 1,
    slices: 1,
    hasSeg: true,
  };
}

function image(sourceStudyUID) {
  return { complete: true, naturalWidth: 1, sourceStudyUID };
}

function resetRuntime(manifest) {
  state.manifest = manifest;
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.useBrain = false;
  state.useSeg = false;
  state.useRegions = false;
  state.useSym = false;
  state.fusionSlug = '';
  state.imgs = [];
  state.segImgs = [];
  state.regionImgs = [];
  state.symImgs = [];
  state.fusionImgs = null;
  state.voxels = null;
  state.voxelsKey = '';
  state.segVoxels = null;
  state.regionVoxels = null;
  state.symVoxels = null;
  state.fusionVoxels = null;
  state.regionMeta = null;
  state._localRawVolumes = {};
  state._localRegionLabelSlicesBySlug = {};
  state.threeRuntime.seriesIdx = -1;
  state.threeRuntime.mesh = null;
}

async function waitFor(predicate, message) {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test('base worker result cannot cross same-slug study selections', async (t) => {
  t.after(() => terminateVolumeWorker());
  const studyA = series('study-a', 'series-a');
  const studyB = series('study-b', 'series-b');
  resetRuntime({ patient: 'anonymous', series: [studyA, studyB] });
  state.selectRequestId = 41;
  state.imgs = [image('study-a')];
  beginViewerRuntimeSession(studyA, { seriesIdx: 0, requestId: 41 });

  const pendingA = tryFlattenVoxelsInWorker();
  await waitFor(() => workers.at(-1)?.messages.length === 1, 'study A worker request was not posted');
  const worker = workers.at(-1);
  const messageA = worker.messages[0];

  state.seriesIdx = 1;
  state.selectRequestId = 42;
  state.imgs = [image('study-b')];
  beginViewerRuntimeSession(studyB, { seriesIdx: 1, requestId: 42 });
  const pendingB = tryFlattenVoxelsInWorker();
  await waitFor(() => worker.messages.length === 2, 'study B worker request was not posted');
  const messageB = worker.messages[1];

  worker.respond(messageA, new Uint8Array([91]));
  assert.equal(await pendingA, false);
  assert.equal(state.voxels, null, 'study A voxels must not install into study B');
  assert.equal(state.voxelsKey, '');

  worker.respond(messageB, new Uint8Array([37]));
  assert.equal(await pendingB, true);
  assert.deepEqual([...state.voxels], [37]);
  assert.equal(state.voxelsKey, 'anonymous|study-b||series-b|repeat_volume|base');
  assert.equal(messageA.bitmaps[0].source.sourceStudyUID, 'study-a');
  assert.equal(messageB.bitmaps[0].source.sourceStudyUID, 'study-b');
});

test('SEG worker result cannot cross same-slug study selections', async (t) => {
  t.after(() => {
    initOverlayVolumes();
    terminateVolumeWorker();
  });
  const studyA = series('study-a', 'series-a');
  const studyB = series('study-b', 'series-b');
  resetRuntime({ patient: 'anonymous', series: [studyA, studyB] });
  const ready = [];
  initOverlayVolumes({ onReady: (type) => ready.push(type) });
  state.useSeg = true;
  state.selectRequestId = 51;
  state.segImgs = [image('study-a')];
  beginViewerRuntimeSession(studyA, { seriesIdx: 0, requestId: 51 });

  ensureActiveOverlayVolumes();
  await waitFor(() => workers.at(-1)?.messages.length === 1, 'study A SEG worker request was not posted');
  const worker = workers.at(-1);
  const messageA = worker.messages[0];

  state.seriesIdx = 1;
  state.selectRequestId = 52;
  state.segImgs = [image('study-b')];
  state.segVoxels = null;
  beginViewerRuntimeSession(studyB, { seriesIdx: 1, requestId: 52 });
  ensureActiveOverlayVolumes();
  await waitFor(() => worker.messages.length === 2, 'study B SEG worker request was not posted');
  const messageB = worker.messages[1];

  worker.respond(messageA, new Uint8Array([91]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.segVoxels, null, 'study A SEG voxels must not install into study B');
  assert.deepEqual(ready, []);

  worker.respond(messageB, new Uint8Array([37]));
  await waitFor(() => state.segVoxels?.[0] === 37, 'study B SEG voxels were not installed');
  assert.deepEqual([...state.segVoxels], [37]);
  assert.deepEqual(ready, ['seg']);
  assert.equal(messageA.bitmaps[0].source.sourceStudyUID, 'study-a');
  assert.equal(messageB.bitmaps[0].source.sourceStudyUID, 'study-b');
});
