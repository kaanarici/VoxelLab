import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

const { state } = await import('../js/core/state.js');
const { beginViewerRuntimeSession, resetViewerRuntimeSession, syncViewerRuntimeSession } = await import('../js/runtime/viewer-session.js');
const {
  OVERLAY_ENABLE_KINDS,
  overlayEnableFromSeriesFlags,
  overlayEnableSnapshot,
  RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE,
  RUNTIME_OVERLAY_KIND_BY_TYPE,
  RUNTIME_OVERLAY_TYPE_BY_KIND,
} = await import('../js/core/viewer-session-shape.js');

function setSeriesState({
  slug = 'viewer_session_case',
  width = 4,
  height = 4,
  slices = 3,
  hasRaw = false,
  hasSeg = false,
  hasRegions = false,
  hasSym = false,
} = {}) {

  state.manifest = {
    series: [{ slug, width, height, slices, hasRaw, hasSeg, hasRegions, hasSym }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 1;
  state.imgs = [];
  state.voxels = null;
  state.hrVoxels = null;
  state.segVoxels = null;
  state.regionVoxels = null;
  state.overlays.regionMeta = null;
  state.symVoxels = null;
  state.overlays.fusionSlug = '';
  state.fusionVoxels = null;
  state.overlays.tissue = false;
  state.overlays.labels = false;
  state.overlays.heatmap = false;
  state.threeRuntime.seriesIdx = -1;
  state.threeRuntime.mesh = null;
}

test('viewer runtime session tracks progressive readiness stages', () => {
  setSeriesState({ slug: 'runtime_progression', hasRaw: true, hasSeg: true, hasRegions: true, hasSym: true });
  state.overlays.tissue = true;
  state.overlays.labels = true;
  state.overlays.heatmap = true;
  state.overlays.fusionSlug = 'peer_series';

  beginViewerRuntimeSession(state.manifest.series[0], { requestId: 7 });
  assert.equal(state.viewerSession.readiness.stage, 'idle');

  state.imgs = [{ complete: false, naturalWidth: 0 }, { complete: true, naturalWidth: 4 }];
  syncViewerRuntimeSession();
  assert.equal(state.viewerSession.readiness.stage, 'first-slice');

  state.voxels = new Uint8Array(4 * 4 * 3);
  syncViewerRuntimeSession();
  assert.equal(state.viewerSession.readiness.stage, 'orthogonal-ready');

  state.segVoxels = new Uint8Array(4 * 4 * 3);
  state.regionVoxels = new Uint8Array(4 * 4 * 3);
  state.overlays.regionMeta = { colors: {}, legend: {} };
  state.symVoxels = new Uint8Array(4 * 4 * 3);
  state.fusionVoxels = new Uint8Array(4 * 4 * 3);
  syncViewerRuntimeSession();
  assert.equal(state.viewerSession.readiness.stage, 'overlay-ready');

  state.hrVoxels = new Float32Array(4 * 4 * 3);
  syncViewerRuntimeSession();
  assert.equal(state.viewerSession.readiness.stage, 'quality-ready');

  state.threeRuntime.seriesIdx = 0;
  state.threeRuntime.mesh = {};
  syncViewerRuntimeSession();
  assert.equal(state.viewerSession.readiness.stage, '3d-ready');
  assert.equal(state.viewerSession.baseSource, 'raw');
});

test('viewer runtime session stores overlaySession in canonical kinds', () => {
  setSeriesState({ slug: 'overlay_kinds', hasSeg: true, hasRegions: true, hasSym: true });
  state.overlays.tissue = true;
  state.overlays.labels = true;
  state.overlays.fusionSlug = 'peer';

  beginViewerRuntimeSession(state.manifest.series[0], { requestId: 8 });
  const session = syncViewerRuntimeSession();

  assert.equal(RUNTIME_OVERLAY_KIND_BY_TYPE.seg, 'tissue');
  assert.equal(RUNTIME_OVERLAY_KIND_BY_TYPE.regions, 'labels');
  assert.equal(RUNTIME_OVERLAY_KIND_BY_TYPE.sym, 'heatmap');
  assert.equal(RUNTIME_OVERLAY_TYPE_BY_KIND.tissue, 'seg');
  assert.equal(RUNTIME_OVERLAY_TYPE_BY_KIND.labels, 'regions');
  assert.equal(RUNTIME_OVERLAY_TYPE_BY_KIND.heatmap, 'sym');
  assert.equal(RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE.seg.imgs, 'segImgs');
  assert.equal(RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE.seg.voxels, 'segVoxels');
  assert.equal(RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE.seg.bytes, 'segBytes');
  assert.equal(RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE.seg.availableFlag, 'hasSeg');
  assert.equal(RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE.fusion.bytes, 'fusionBytes');
  assert.equal(RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE.fusion.availableFlag, null);
  assert.equal(RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE.fusion.refuseInOverlayStack, true);
  assert.equal(RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE.fusion.peerSlugField, 'fusionSlug');
  assert.equal(RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE.regions.needsRegionMeta, true);
  assert.equal(session.overlaySession.tissue.enabled, true);
  assert.equal(session.overlaySession.labels.enabled, true);
  assert.equal(session.overlaySession.heatmap.enabled, false);
  assert.equal(session.overlaySession.fusion.enabled, true);
  assert.deepEqual(Object.keys(session.overlaySession), Object.values(RUNTIME_OVERLAY_KIND_BY_TYPE));
  assert.equal('sourceType' in session.overlaySession.tissue, false);
  assert.equal('sourceType' in session.overlaySession.labels, false);
  assert.equal('sourceType' in session.overlaySession.heatmap, false);
  assert.equal('sourceType' in session.overlaySession.fusion, false);
});

test('viewer runtime session does not report 3d-ready while enabled overlays are still warming', () => {
  setSeriesState({ slug: 'three_overlay_wait', hasRegions: true });
  state.overlays.labels = true;
  state.voxels = new Uint8Array(4 * 4 * 3);
  state.threeRuntime.seriesIdx = 0;
  state.threeRuntime.mesh = {};

  beginViewerRuntimeSession(state.manifest.series[0], { requestId: 10 });
  syncViewerRuntimeSession();

  assert.equal(state.viewerSession.readiness.threeReady, true);
  assert.notEqual(state.viewerSession.readiness.stage, '3d-ready');
  assert.equal(state.viewerSession.readiness.stage, 'quality-ready');
});

test('viewer runtime session reset clears the active selection state', () => {
  setSeriesState({ slug: 'reset_session' });
  beginViewerRuntimeSession(state.manifest.series[0], { requestId: 9 });

  resetViewerRuntimeSession();

  assert.deepEqual(state.viewerSession, {
    slug: '',
    seriesIdx: -1,
    requestId: 0,
    baseSource: '',
    firstSliceIdx: -1,
    overlaySession: {
      tissue: {
        available: false, enabled: false, currentSliceReady: false, voxelsReady: false, volumeReady: false,
        metaReady: false, blockingReason: '',
      },
      labels: {
        available: false, enabled: false, currentSliceReady: false, voxelsReady: false, volumeReady: false,
        metaReady: false, blockingReason: '',
      },
      heatmap: {
        available: false, enabled: false, currentSliceReady: false, voxelsReady: false, volumeReady: false,
        metaReady: false, blockingReason: '',
      },
      fusion: {
        available: false, enabled: false, currentSliceReady: false, voxelsReady: false, volumeReady: false,
        metaReady: false, blockingReason: '',
      },
    },
    readiness: {
      stage: 'idle',
      firstSlice: false,
      baseVolume: false,
      orthogonalReady: false,
      overlayReady: false,
      qualityReady: false,
      threeReady: false,
      sliceReady: false,
      mprReady: false,
      twoDReady: false,
      compareReady: false,
    },
  });
});

test('OVERLAY_ENABLE_KINDS is derived from cache rows with an availableFlag', () => {
  assert.deepEqual(OVERLAY_ENABLE_KINDS, ['tissue', 'labels', 'heatmap']);
});

test('overlayEnableSnapshot walks persist kinds instead of listing them', () => {
  assert.deepEqual(
    overlayEnableSnapshot({ useBrain: 1, tissue: 1, labels: 0, heatmap: true, extra: true }),
    { useBrain: true, tissue: true, labels: false, heatmap: true },
  );
});

test('overlayEnableFromSeriesFlags walks the cache table, not a handwritten hasSeg map', () => {
  assert.deepEqual(
    overlayEnableFromSeriesFlags({ hasSeg: true, hasRegions: false, hasSym: true }),
    { tissue: true, labels: false, heatmap: true },
  );
  assert.deepEqual(
    overlayEnableFromSeriesFlags({}),
    { tissue: false, labels: false, heatmap: false },
  );
});
