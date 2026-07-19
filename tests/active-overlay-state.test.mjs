import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

const { state } = await import('../js/core/state.js');
const {
  activeOverlayStateForSeries,
  activeThreeLabelOverlay,
} = await import('../js/runtime/active-overlay-state.js');
const { setSeriesOverlayHints } = await import('../js/runtime/overlay-kinds.js');

function setSeries(series) {
  state.manifest = { series: [series] };
  state.seriesIdx = 0;
  state.useSeg = false;
  state.useRegions = false;
  state.useSym = false;
  state.fusionSlug = '';
  state.segVoxels = null;
  state.regionVoxels = null;
  state.regionMeta = null;
  state.symVoxels = null;
  state.fusionVoxels = null;
  state.fusionImgs = null;
}

test('active overlay state maps canonical availability onto live toggle state', () => {
  const series = { slug: 'overlay_runtime', hasSeg: true, hasRegions: true, hasSym: false };
  setSeries(series);
  state.useSeg = true;
  state.segVoxels = new Uint8Array([1, 2, 3]);

  const overlays = activeOverlayStateForSeries(series);

  assert.equal(overlays.tissue.available, true);
  assert.equal(overlays.tissue.enabled, true);
  assert.equal(overlays.tissue.ready, true);
  assert.equal(overlays.labels.available, true);
  assert.equal(overlays.heatmap.available, false);
});

test('active three label overlay prefers canonical labels over tissue', () => {
  const series = { slug: 'label_priority', width: 1, height: 1, slices: 1, hasSeg: true, hasRegions: true, hasSym: false };
  setSeries(series);
  state.useSeg = true;
  state.useRegions = true;
  state.segVoxels = new Uint8Array([2]);
  state.regionVoxels = new Uint8Array([9]);
  state.regionMeta = { colors: { 9: [255, 0, 0] }, regions: { 9: { name: 'ROI' } } };

  const selected = activeThreeLabelOverlay(series);

  assert.equal(selected.mode, 2);
  assert.deepEqual([...selected.source], [9]);
});

test('active overlay state respects canonical local SEG hints behind the labels slot', () => {
  const series = { slug: 'seg_as_labels', hasSeg: false, hasRegions: true, hasSym: false };
  setSeriesOverlayHints(series, {
    labels: { source: 'dicom-seg', legacyKinds: ['regions', 'seg'] },
  });
  setSeries(series);
  state.useRegions = true;
  state.regionVoxels = new Uint8Array([4]);
  state.regionMeta = { colors: { 4: [1, 2, 3] }, regions: { 4: { name: 'Imported SEG' } } };

  const overlays = activeOverlayStateForSeries(series);

  assert.equal(overlays.labels.available, true);
  assert.equal(overlays.labels.enabled, true);
  assert.equal(overlays.labels.ready, true);
});

test('active overlay state exposes fusion from the live peer binding', () => {
  const series = { slug: 'fusion_primary', hasSeg: false, hasRegions: false, hasSym: false };
  setSeries(series);
  state.fusionSlug = 'fusion_peer';
  state.fusionImgs = [{ complete: true }];
  state.fusionVoxels = new Uint8Array([7]);

  const overlays = activeOverlayStateForSeries(series);

  assert.equal(overlays.fusion.available, true);
  assert.equal(overlays.fusion.enabled, true);
  assert.equal(overlays.fusion.ready, true);
  assert.equal(overlays.fusion.imgs, state.fusionImgs);
});

test('active three label overlay uses fusion opacity for fusion volumes', () => {
  const series = { slug: 'fusion_primary', hasSeg: false, hasRegions: false, hasSym: false };
  setSeries(series);
  state.overlayOpacity = 0.8;
  state.fusionOpacity = 0.25;
  state.fusionSlug = 'fusion_peer';
  state.fusionVoxels = new Uint8Array([9]);

  const selected = activeThreeLabelOverlay(series);

  assert.equal(selected.mode, 3);
  assert.equal(selected.opacity, 0.25);
  assert.equal(selected.opacities[9], 0.25);
});

test('active three label overlay keeps heatmap opacity tied to overlay opacity', () => {
  const series = { slug: 'heatmap_primary', hasSeg: false, hasRegions: false, hasSym: true };
  setSeries(series);
  state.useSym = true;
  state.overlayOpacity = 0.65;
  state.fusionOpacity = 0.2;
  state.symVoxels = new Uint8Array([11]);

  const selected = activeThreeLabelOverlay(series);

  assert.equal(selected.mode, 3);
  assert.equal(selected.opacity, 0.65);
  assert.equal(selected.opacities[11], 0.65);
});
