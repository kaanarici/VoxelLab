import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installViewerGlobals } from './helpers/node/viewer-globals.mjs';

installViewerGlobals();

const { state, subscribe } = await import('../js/core/state.js');
const {
  applyViewerPreset,
  finishSeriesSelection,
  hydrateSeriesSidecars,
  initializeSeriesViewState,
  nudgeMprAxis,
  patchManifestSeries,
  resetCompareViewport,
  setMprGpuEnabled,
  setMprProjection,
  setMprViewport,
  getMprViewport,
  setCompareViewport,
  setAnalysis,
  setAnalysisBusy,
  setBrainStack,
  setColormap,
  setClipAxis,
  setFitZoom,
  setMeasurementMapEntry,
  setMprPosition,
  setNoteMapEntry,
  setObliqueAngles,
  setObliqueClip,
  setOverlayEnabled,
  resetMprViewport,
  setRoiMapEntry,
  setSeriesDesktopImportId,
  setSliceIndex,
  setViewMode,
  setVolumeTransfer,
  setWindowLevel,
  syncMprSliceIndex,
  syncSeriesIdxForActiveSlug,
} = await import('../js/core/state/viewer-commands.js');
const { beginViewerRuntimeSession } = await import('../js/runtime/viewer-session.js');
const { setSeriesImageStacks, transitionVolumeCaches } = await import('../js/runtime/viewer-runtime.js');
const { writeHostSeriesRecord } = await import('../js/runtime/isolated-host.js');
const { getAskSession, setAskHistory } = await import('../js/ask-session.js');

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

test('setSliceIndex clamps against the active series bounds', () => {
  state.manifest = { series: [{ slug: 'cmd_slice', slices: 3 }] };
  state.seriesIdx = 0;

  assert.equal(setSliceIndex(99), 2);
  assert.equal(state.sliceIdx, 2);
  assert.equal(setSliceIndex(-5), 0);
  assert.equal(state.sliceIdx, 0);
});

test('setSliceIndex in 3D clips the volume to the review slice', () => {
  state.manifest = { series: [{ slug: 'cmd_slice_3d', slices: 3 }] };
  state.seriesIdx = 0;
  state.sliceIdx = 1;
  state.three.clipMin = [0, 0, 0];
  state.three.clipMax = [1, 1, 1];
  setViewMode('3d');
  assert.equal(state.sliceIdx, 1);
  assert.equal(state.three.clipMax[2], 1);
  assert.equal(setSliceIndex(1), 1);
  assert.equal(state.sliceIdx, 1);
  assert.equal(state.three.clipMax[2], 2 / 3);
  setClipAxis('max', 2, 1 / 3);
  assert.equal(state.sliceIdx, 0);
  setViewMode('2d');
});

test('setMeasurementMapEntry writes the live measurements bag through commands', () => {
  setMeasurementMapEntry('["measure",0]', [{ id: 1, x1: 0, y1: 0, x2: 2, y2: 2 }]);
  assert.equal(state.measurements['["measure",0]'][0].id, 1);
  setMeasurementMapEntry('["measure",0]', []);
  assert.equal(state.measurements['["measure",0]'], undefined);
});

test('setRoiMapEntry and setNoteMapEntry write the live drawing bags through commands', () => {
  setRoiMapEntry('["roi",0]', [{ id: 2, "shape": 'point', pts: [[1, 1]] }]);
  setNoteMapEntry('["note",0]', [{ id: 3, x: 4, y: 5, text: 'pin' }]);
  assert.equal(state.rois['["roi",0]'][0].id, 2);
  assert.equal(state.notes['["note",0]'][0].text, 'pin');
  setRoiMapEntry('["roi",0]', []);
  setNoteMapEntry('["note",0]', []);
  assert.equal(state.rois['["roi",0]'], undefined);
  assert.equal(state.notes['["note",0]'], undefined);
});

test('patchManifestSeries replaces the live series record instead of mutating it', () => {
  const original = { slug: 'cmd_series_patch', hasRegions: false };
  state.manifest = { series: [original] };
  state.seriesIdx = 0;
  const seen = [];
  const off = subscribe('manifest.series', (value) => seen.push(value.length));

  const next = patchManifestSeries(original, { hasRegions: true, _desktopImportId: 'import-1' });

  off();
  assert.equal(original.hasRegions, false);
  assert.equal(original._desktopImportId, undefined);
  assert.notEqual(next, original);
  assert.equal(next.hasRegions, true);
  assert.equal(next._desktopImportId, 'import-1');
  assert.notEqual(state.manifest.series[0], original);
  assert.equal(state.manifest.series[0], next);
  assert.equal(state.manifest.series.indexOf(next), 0);
  assert.equal(state.manifest.series[0].hasRegions, true);
  assert.equal(state.manifest.series[0]._desktopImportId, 'import-1');
  assert.deepEqual(seen, [1]);
});

test('patchManifestSeries no-ops when the series is not in the live list', () => {
  const orphan = {
    slug: 'cmd_orphan',
    hasRegions: false,
    microscopy: { channelIndex: 0, composite: { enabled: false, channels: [true, true] } },
  };
  state.manifest = { series: [{ slug: 'cmd_live', hasRegions: false }] };

  const next = patchManifestSeries(orphan, { hasRegions: true, microscopy: { channelIndex: 1 } });

  assert.equal(next, null);
  assert.equal(orphan.hasRegions, false);
  assert.equal(orphan.microscopy.channelIndex, 0);
  assert.equal(state.manifest.series[0].hasRegions, false);
});

test('patchManifestSeries empty patch returns the live list slot and null on miss', () => {
  const live = { slug: 'cmd_empty_live', hasRegions: false };
  const orphan = { slug: 'cmd_empty_orphan', hasRegions: false };
  state.manifest = { series: [live] };
  const slot = state.manifest.series[0];

  assert.equal(patchManifestSeries(live, {}), slot);
  assert.equal(patchManifestSeries(0, {}), slot);
  assert.equal(patchManifestSeries(orphan, {}), null);
  assert.equal(patchManifestSeries(orphan), null);
  assert.equal(patchManifestSeries(9, {}), null);
  assert.equal(state.manifest.series[0], slot);
});

test('patchManifestSeries deep-merges nested microscopy without dropping channel lists', () => {
  const original = {
    slug: 'cmd_microscopy_merge',
    microscopy: {
      channelIndex: 0,
      channelName: 'DAPI',
      timeIndex: 0,
      volumeEligible: true,
      composite: { enabled: false, channels: [true, true, false] },
    },
  };
  state.manifest = { series: [original] };

  const next = patchManifestSeries(original, {
    slices: 4,
    microscopy: { channelIndex: 1, channelName: 'GFP' },
  });

  assert.notEqual(next, original);
  assert.equal(next.slices, 4);
  assert.equal(next.microscopy.channelIndex, 1);
  assert.equal(next.microscopy.channelName, 'GFP');
  assert.equal(next.microscopy.timeIndex, 0);
  assert.equal(next.microscopy.volumeEligible, true);
  assert.deepEqual(next.microscopy.composite.channels, [true, true, false]);
  assert.equal(original.microscopy.channelIndex, 0);
  assert.deepEqual(original.microscopy.composite.channels, [true, true, false]);

  const enabled = patchManifestSeries(next, { microscopy: { composite: { enabled: true } } });
  assert.equal(enabled.microscopy.composite.enabled, true);
  assert.deepEqual(enabled.microscopy.composite.channels, [true, true, false]);
  assert.equal(enabled.microscopy.channelIndex, 1);
});

test('setSeriesDesktopImportId writes through patchManifestSeries', () => {
  const original = { slug: 'cmd_desktop_id' };
  state.manifest = { series: [original] };
  const id = setSeriesDesktopImportId(0, 'import-abcdef');
  assert.equal(id, 'import-abcdef');
  assert.equal(state.manifest.series[0]._desktopImportId, 'import-abcdef');
  assert.notEqual(state.manifest.series[0], original);
  assert.equal(original._desktopImportId, undefined);
});

test('writeHostSeriesRecord patches isolated hosts in place', () => {
  const series = { slug: 'cmd_iso_series_record', microscopy: { volumeEligible: true } };
  const host = { manifest: { series: [series] }, seriesIdx: 0 };
  const next = writeHostSeriesRecord(host, series, { geometryKind: 'volumeStack' });
  assert.equal(next, series);
  assert.equal(series.geometryKind, 'volumeStack');
  assert.equal(host.manifest.series[0], series);
});

test('setWindowLevel clamps to viewer-safe numeric bounds', () => {
  const next = setWindowLevel(900, -40);
  assert.deepEqual(next, { window: 512, level: 0 });
  assert.equal(state.window, 512);
  assert.equal(state.level, 0);
});

test('applyViewerPreset updates render controls in one command call', () => {
  const next = applyViewerPreset({
    lowT: 0.2,
    highT: 0.8,
    intensity: 1.1,
    clipMin: [0, 0.1, 0.2],
    clipMax: [0.9, 1, 1],
    mode: 'mip',
    clipPlaneEnabled: false,
  });
  assert.deepEqual(next, {
    lowT: 0.2,
    highT: 0.8,
    intensity: 1.1,
    clipMin: [0, 0.1, 0.2],
    clipMax: [0.9, 1, 1],
    mode: 'mip',
    clipPlaneEnabled: false,
  });
  assert.equal(state.three.renderMode, 'mip');
});

test('setBrainStack preserves the active viewer session while replacing same-series volume data', () => {
  state._seriesVolumeCacheEntries = [];
  state.manifest = { series: [{ ...volumeSeries('brain_keep', 4), hasBrain: true }] };
  state.seriesIdx = 0;
  state.selectRequestId = 11;
  state.overlays.useBrain = false;
  state.voxels = new Uint8Array([1, 2, 3]);
  state.voxelsKey = 'old-base';
  state.threeRuntime.seriesIdx = 0;
  state.threeRuntime.mesh = {};
  beginViewerRuntimeSession(state.manifest.series[0], { requestId: 11 });

  transitionVolumeCaches(state.manifest.series[0], () => {
    setBrainStack({ nextUseBrain: true });
    setSeriesImageStacks({ imgs: [{ complete: true, naturalWidth: 4 }], cmpStacks: {} });
  }, { resetViewerSessionState: false });

  assert.equal(state.overlays.useBrain, true);
  assert.equal(state.viewerSession.slug, 'brain_keep');
  assert.equal(state.viewerSession.requestId, 11);
  assert.equal(state.threeRuntime.seriesIdx, -1);
  assert.equal(state.voxels, null);
  assert.equal(state.imgs.length, 1);
});

test('setSeriesImageStacks and hydrateSeriesSidecars land data without finishing the load early', () => {
  setSeriesImageStacks({
    imgs: [{ complete: true }],
    segImgs: [{ complete: true }],
    fusionImgs: [{ complete: true }],
  });
  hydrateSeriesSidecars({
    analysis: { summary: 'fresh' },
    regionMeta: { legend: { 1: 'Region' } },
    stats: { symmetryScores: [0.1, 0.2] },
  });
  setAskHistory([{ prompt: 'new' }]);

  assert.equal(state.loaded, false);
  assert.equal(state.imgs.length, 1);
  assert.equal(state.segImgs.length, 1);
  assert.equal(state.fusionImgs.length, 1);
  assert.equal(state.overlays.analysis.summary, 'fresh');
  assert.deepEqual(getAskSession().history, [{ prompt: 'new' }]);

  state.threeRuntime.seriesIdx = 4;
  finishSeriesSelection();
  assert.equal(state.loaded, true);
  assert.equal(state.threeRuntime.seriesIdx, 4);
});

test('setOverlayEnabled enforces exclusivity when requested', () => {
  state.overlays.tissue = false;
  state.overlays.labels = true;

  const next = setOverlayEnabled('tissue', true, ['labels']);

  assert.equal(next, true);
  assert.equal(state.overlays.tissue, true);
  assert.equal(state.overlays.labels, false);
});

test('initializeSeriesViewState centers MPR state and drops unavailable overlays', () => {
  state.overlays.useBrain = true;
  state.overlays.tissue = true;
  state.overlays.labels = true;
  state.overlays.heatmap = true;

  const next = initializeSeriesViewState({
    width: 11,
    height: 9,
    slices: 7,
    hasBrain: false,
    hasSeg: true,
    hasRegions: false,
    hasSym: false,
  });

  assert.deepEqual(next, {
    mprX: 5,
    mprY: 4,
    mprZ: 3,
    useBrain: false,
    tissue: true,
    labels: false,
    heatmap: false,
  });
  assert.deepEqual(state.mpr.viewports, {
    ax: { zoom: 1, tx: 0, ty: 0 },
    co: { zoom: 1, tx: 0, ty: 0 },
    sa: { zoom: 1, tx: 0, ty: 0 },
    ob: { zoom: 1, tx: 0, ty: 0 },
  });
});

test('setMprPosition clamps to series bounds and can sync the slice index', () => {
  state.manifest = { series: [{ slug: 'mpr_cmd', width: 8, height: 6, slices: 5 }] };
  state.seriesIdx = 0;
  state.sliceIdx = 1;

  const next = setMprPosition({ x: 99, y: -5, z: 7 }, undefined, { syncSlice: true });

  assert.deepEqual(next, { mprX: 7, mprY: 0, mprZ: 4, sliceIdx: 4 });
  assert.equal(state.sliceIdx, 4);
});

test('syncMprSliceIndex and nudgeMprAxis keep MPR navigation consistent', () => {
  state.manifest = { series: [{ slug: 'mpr_nav', width: 10, height: 12, slices: 9 }] };
  state.seriesIdx = 0;
  state.mpr.x = 5;
  state.mpr.y = 6;
  state.mpr.z = 2;
  state.sliceIdx = 8;

  syncMprSliceIndex();
  assert.equal(state.mpr.z, 8);

  nudgeMprAxis('y', -20);
  assert.equal(state.mpr.y, 0);

  nudgeMprAxis('z', -3);
  assert.equal(state.mpr.z, 5);
  assert.equal(state.sliceIdx, 5);
});

test('setObliqueAngles and transfer controls update viewer session state in one place', () => {
  assert.deepEqual(setObliqueAngles({ yaw: 12, pitch: 34 }), { obYaw: 12, obPitch: 34 });
  assert.deepEqual(setObliqueAngles({ yaw: 999, pitch: -999 }), { obYaw: 180, obPitch: -90 });
  assert.deepEqual(setObliqueClip({ enabled: true, depth: 0.363, invert: true }), {
    enabled: true,
    depth: 0.363,
    invert: true,
  });
  assert.equal(setMprGpuEnabled(true), true);
  assert.deepEqual(setMprProjection({ mode: 'mip', slabThicknessMm: 12 }), {
    mode: 'mip',
    slabThicknessMm: 12,
  });
  assert.deepEqual(setVolumeTransfer({ lowT: 0.15, highT: 0.9, intensity: 1.4 }), {
    lowT: 0.15,
    highT: 0.9,
    intensity: 1.4,
  });
});

test('setMprViewport clamps and resets per-pane viewport state', () => {
  assert.deepEqual(setMprViewport('ob', { zoom: 99, tx: 12, ty: -4 }), {
    zoom: 8,
    tx: 12,
    ty: -4,
  });
  assert.deepEqual(resetMprViewport('ob'), {
    zoom: 1,
    tx: 0,
    ty: 0,
  });
});

test('setMprViewport pan writes tx/ty without interaction flags on the document', () => {
  setMprViewport('ax', { zoom: 2, tx: 10, ty: -4 });
  const snapshot = getMprViewport('ax');
  assert.deepEqual(setMprViewport('ax', { zoom: snapshot.zoom, tx: snapshot.tx + 6, ty: snapshot.ty + 3 }), {
    zoom: 2,
    tx: 16,
    ty: -1,
  });
  assert.deepEqual(state.mpr.viewports.ax, { zoom: 2, tx: 16, ty: -1 });
  assert.deepEqual(getMprViewport('ax'), { zoom: 2, tx: 16, ty: -1 });
  assert.equal('panning' in state.mpr.viewports.ax, false);
  assert.equal('lastX' in state.mpr.viewports.ax, false);
  assert.equal('moved' in state.mpr.viewports.ax, false);
});

test('setClipAxis preserves a minimum gap between clip bounds', () => {
  state.three.clipMin = [0, 0, 0];
  state.three.clipMax = [1, 1, 1];

  setClipAxis('min', 0, 0.995);
  setClipAxis('max', 1, 0.001);

  assert.deepEqual(state.three.clipMin, [0.99, 0, 0]);
  assert.deepEqual(state.three.clipMax, [1, 0.01, 1]);
});

test('analysis, colormap, and fit-zoom commands update viewer session state directly', () => {
  assert.equal(setAnalysisBusy(true), true);
  assert.deepEqual(setAnalysis({ summary: 'fresh' }), { summary: 'fresh' });
  assert.equal(setColormap('hot'), 'hot');
  assert.deepEqual(setFitZoom(0.1), { zoom: 0.25, tx: 0, ty: 0 });
  assert.deepEqual(setFitZoom(2.4), { zoom: 2.4, tx: 0, ty: 0 });
});

test('syncSeriesIdxForActiveSlug keeps the active series stable through sidebar sort operations', () => {
  const manifest = {
    series: [
      { slug: 'c' },
      { slug: 'a' },
      { slug: 'b' },
    ],
  };
  state.manifest = manifest;
  state.seriesIdx = 2;
  manifest.series.sort((a, b) => a.slug.localeCompare(b.slug));

  const nextIdx = syncSeriesIdxForActiveSlug(manifest, 'b');

  assert.equal(nextIdx, 1);
  assert.equal(state.seriesIdx, 1);
});

test('setCompareViewport clamps and resets the linked compare viewport', () => {
  state.compare = { viewport: { zoom: 1, tx: 0, ty: 0 } };

  assert.deepEqual(setCompareViewport({ zoom: 20, tx: 14, ty: -9 }), { zoom: 8, tx: 14, ty: -9 });
  assert.deepEqual(state.compare.viewport, { zoom: 8, tx: 14, ty: -9 });
  assert.deepEqual(resetCompareViewport(), { zoom: 1, tx: 0, ty: 0 });
});
