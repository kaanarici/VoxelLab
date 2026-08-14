import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new globalThis.URL('http://127.0.0.1/');
globalThis.window = globalThis.window || { addEventListener() {} };
const storage = new Map();
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
};

const { state } = await import('../js/core/state.js');
const { setNoteEntriesForSlice } = await import('../js/overlay/annotation-graph.js');
const {
  initMprView,
  hasMprBaseVolume,
  drawMPR,
  drawMPRInteractive,
  drawMPRZScrub,
  drawObliqueCell,
  beginMprInteraction,
  beginObliqueInteraction,
  clearMprCellCache,
  getMprCellCacheStats,
  getMprVolumeReadiness,
  __setMprGpuApiForTests,
} = await import('../js/mpr/mpr-view.js');

function createCanvas(width, height) {
  const context = {
    puts: 0,
    arcs: 0,
    createdImageData: 0,
    createdImages: [],
    lastImageData: null,
    createImageData: (w, h) => {
      const image = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
      context.createdImageData += 1;
      context.createdImages.push(image);
      return image;
    },
    putImageData: (image) => {
      context.puts += 1;
      context.lastImageData = image;
    },
    save() {},
    restore() {},
    beginPath() {},
    arc: () => { context.arcs += 1; },
    fill() {},
    stroke() {},
  };
  return {
    width,
    height,
    style: {},
    parentElement: {
      getBoundingClientRect: () => ({ left: 0, top: 0, width, height, right: width, bottom: height }),
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height, right: width, bottom: height }),
    getContext: () => context,
  };
}

function createCrosshairOverlay() {
  const style = {
    left: '',
    top: '',
    width: '',
    height: '',
    setProperty(name, value) { style[name] = value; },
  };
  return {
    _mprBoundsReady: false,
    style,
  };
}

function stylePixels(value) {
  return Number.parseInt(String(value || '0').replace('px', ''), 10);
}

function installMprDom(width, height) {
  const registry = new Map();
  // Shape: mpr-* canvas nodes with tiny 2D context stub used by drawMPR.
  registry.set('mpr-ax', createCanvas(width, height));
  registry.set('mpr-co', createCanvas(width, height));
  registry.set('mpr-sa', createCanvas(height, height));
  registry.set('mpr-ob', createCanvas(455, 384));
  registry.set('mpr-ax-cross', createCrosshairOverlay());
  registry.set('mpr-co-cross', createCrosshairOverlay());
  registry.set('mpr-sa-cross', createCrosshairOverlay());
  // Shape: simple text labels, e.g. "X 4/8", "Y 3/6", "Z 7/32".
  registry.set('mpr-ax-idx', { textContent: '' });
  registry.set('mpr-co-idx', { textContent: '' });
  registry.set('mpr-sa-idx', { textContent: '' });
  registry.set('mpr-ob-idx', { textContent: '' });
  globalThis.document = {
    getElementById(id) {
      return registry.get(id) || null;
    },
  };
}

function setSeriesState({ slug = 'mpr_case', width = 8, height = 6, slices = 5 } = {}) {
  const voxelCount = width * height * slices;
  // Shape: active manifest with one MPR-capable series.
  state.manifest = {
    series: [{ slug, width, height, slices, rowSpacing: 1, colSpacing: 1, sliceSpacing: 1 }],
  };
  state.seriesIdx = 0;
  state.mode = 'mpr';
  state.sliceIdx = 0;
  state.loaded = true;
  state.mprX = Math.floor(width / 2);
  state.mprY = Math.floor(height / 2);
  state.mprZ = Math.floor(slices / 2);
  state.mprQuality = 'quality';
  state.mpr.projectionMode = 'thin';
  state.mpr.slabThicknessMm = 0;
  state.mprGpuEnabled = false;
  state.mpr.viewports = {
    ax: { zoom: 1, tx: 0, ty: 0 },
    co: { zoom: 1, tx: 0, ty: 0 },
    sa: { zoom: 1, tx: 0, ty: 0 },
    ob: { zoom: 1, tx: 0, ty: 0 },
  };
  state.window = 120;
  state.level = 60;
  state.colormap = 'grayscale';
  state.invertDisplay = false;
  state.overlayOpacity = 0.5;
  state.fusionOpacity = 0.5;
  state.obYaw = 0;
  state.obPitch = 0;
  state.useSeg = false;
  state.useRegions = false;
  state.useSym = false;
  state.fusionSlug = '';
  state.segVoxels = null;
  state.regionVoxels = null;
  state.regionMeta = null;
  state.symVoxels = null;
  state.fusionVoxels = null;
  state.hrVoxels = new Float32Array(voxelCount).fill(0.4);
  state.voxels = null;
}

test('hasMprBaseVolume accepts cloud raw voxels without PNG-derived voxels', () => {
  state.manifest = {
    series: [{ slug: 'cloud_mpr', width: 2, height: 2, slices: 2 }],
  };
  state.seriesIdx = 0;
  state.voxels = null;
  state.hrVoxels = new Float32Array(8);

  assert.equal(hasMprBaseVolume(), true);
});

test('hasMprBaseVolume rejects incomplete base volumes', () => {
  state.manifest = {
    series: [{ slug: 'partial_mpr', width: 2, height: 2, slices: 2 }],
  };
  state.seriesIdx = 0;
  state.hrVoxels = new Float32Array(7);
  state.voxels = new Uint8Array(7);

  assert.equal(hasMprBaseVolume(), false);
});

test('drawMPR readiness uses ensureVoxels only when base volume is missing', () => {
  installMprDom(8, 6);
  setSeriesState({ slug: 'readiness' });
  let ensureCalls = 0;
  initMprView({
    ensureVoxels: () => {
      ensureCalls += 1;
      const series = state.manifest.series[state.seriesIdx];
      const voxelCount = series.width * series.height * series.slices;
      state.voxels = new Uint8Array(voxelCount).fill(88);
      return true;
    },
    isMprActive: () => true,
  });

  drawMPR();
  assert.equal(ensureCalls, 0, 'hrVoxels-ready series should not hit ensureVoxels gate');

  state.hrVoxels = null;
  state.voxels = null;
  drawMPR();
  assert.equal(ensureCalls, 1, 'missing base volume should hit ensureVoxels gate exactly once');
});

test('drawMPR sizes the axial pane and crosshair from physical row/column spacing', () => {
  installMprDom(8, 6);
  setSeriesState({ slug: 'axial_spacing', width: 8, height: 6, slices: 5 });
  // Shape: anisotropic in-plane voxels where rows are 2 mm tall and columns are 1 mm wide.
  state.manifest.series[0].pixelSpacing = [2, 1];
  state.mprX = 4;
  state.mprY = 3;
  initMprView({ ensureVoxels: () => false, isMprActive: () => true });

  drawMPR();

  const ax = globalThis.document.getElementById('mpr-ax');
  const overlay = globalThis.document.getElementById('mpr-ax-cross');
  assert.equal(ax.width, 8);
  assert.equal(ax.height, 16, 'axial pane height should expand to preserve physical aspect');
  assert.equal(overlay.style['--x'], `${(4 / 7) * 100}%`);
  assert.equal(overlay.style['--y'], `${(9 / 15) * 100}%`);
});

test('drawMPR fits orthogonal panes inside parent cells without display distortion', () => {
  installMprDom(96, 72);
  setSeriesState({ slug: 'orthogonal_fit', width: 96, height: 72, slices: 64 });
  state.manifest.series[0].pixelSpacing = [1, 1];
  state.manifest.series[0].sliceSpacing = 4;
  const co = globalThis.document.getElementById('mpr-co');
  co.parentElement = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 180, height: 120, right: 180, bottom: 120 }),
  };
  initMprView({ ensureVoxels: () => false, isMprActive: () => true });

  drawMPR();

  const displayWidth = stylePixels(co.style.width);
  const displayHeight = stylePixels(co.style.height);
  assert.ok(displayWidth <= 168, `display width should fit the parent cell, got ${displayWidth}`);
  assert.ok(displayHeight <= 108, `display height should fit the parent cell, got ${displayHeight}`);
  assert.ok(
    Math.abs((displayWidth / displayHeight) - (co.width / co.height)) < 0.02,
    'display aspect should stay tied to the backing canvas aspect',
  );
});

test('drawMPR ImageData reuses coronal and sagittal output buffers on same-size CPU redraws', () => {
  installMprDom(8, 6);
  setSeriesState({ slug: 'image_data_reuse', width: 8, height: 6, slices: 18 });
  initMprView({ ensureVoxels: () => false, isMprActive: () => true });
  clearMprCellCache();

  drawMPR();
  const coContext = globalThis.document.getElementById('mpr-co').getContext();
  const saContext = globalThis.document.getElementById('mpr-sa').getContext();
  const first = {
    coCreated: coContext.createdImageData,
    coImage: coContext.lastImageData,
    saCreated: saContext.createdImageData,
    saImage: saContext.lastImageData,
  };

  drawMPR();

  assert.equal(coContext.createdImageData, first.coCreated, 'coronal redraw should reuse output ImageData');
  assert.equal(saContext.createdImageData, first.saCreated, 'sagittal redraw should reuse output ImageData');
  assert.equal(coContext.lastImageData, first.coImage, 'coronal redraw should put the same ImageData object');
  assert.equal(saContext.lastImageData, first.saImage, 'sagittal redraw should put the same ImageData object');
});

test('drawMPR ImageData reallocates coronal and sagittal output buffers after size changes', () => {
  installMprDom(8, 6);
  initMprView({ ensureVoxels: () => false, isMprActive: () => true });
  const drawSeries = (options) => {
    setSeriesState(options);
    clearMprCellCache();
    drawMPR();
  };

  drawSeries({ slug: 'image_data_size_a', width: 8, height: 6, slices: 18 });
  const coContext = globalThis.document.getElementById('mpr-co').getContext();
  const saContext = globalThis.document.getElementById('mpr-sa').getContext();
  const first = {
    coCreated: coContext.createdImageData,
    coImage: coContext.lastImageData,
    saCreated: saContext.createdImageData,
    saImage: saContext.lastImageData,
  };

  drawSeries({ slug: 'image_data_size_b', width: 10, height: 7, slices: 22 });
  const second = {
    coCreated: coContext.createdImageData,
    coImage: coContext.lastImageData,
    saCreated: saContext.createdImageData,
    saImage: saContext.lastImageData,
  };
  assert.equal(second.coCreated, first.coCreated + 1, 'coronal size change should allocate a new ImageData');
  assert.equal(second.saCreated, first.saCreated + 1, 'sagittal size change should allocate a new ImageData');
  assert.notEqual(second.coImage, first.coImage);
  assert.notEqual(second.saImage, first.saImage);

  drawSeries({ slug: 'image_data_size_a', width: 8, height: 6, slices: 18 });

  assert.equal(coContext.createdImageData, second.coCreated + 1, 'coronal A-B-A should allocate again');
  assert.equal(saContext.createdImageData, second.saCreated + 1, 'sagittal A-B-A should allocate again');
  assert.notEqual(coContext.lastImageData, second.coImage);
  assert.notEqual(saContext.lastImageData, second.saImage);
  assert.notEqual(coContext.lastImageData, first.coImage);
  assert.notEqual(saContext.lastImageData, first.saImage);
});

test('drawObliqueCell preserves physical aspect when fitted height is below the old minimum', () => {
  installMprDom(512, 64);
  setSeriesState({ slug: 'oblique_wide_fit', width: 512, height: 32, slices: 2 });
  const ob = globalThis.document.getElementById('mpr-ob');
  ob.parentElement = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 136, right: 900, bottom: 136 }),
  };
  initMprView({ ensureVoxels: () => false, isMprActive: () => true });

  drawObliqueCell();

  const displayWidth = stylePixels(ob.style.width);
  const displayHeight = stylePixels(ob.style.height);
  const physicalAspect = ((512 - 1) * 1.04) / ((32 - 1) * 1.04);
  assert.ok(ob.height < 160, `regression case should allow the physically fitted height, got ${ob.height}`);
  assert.ok(
    Math.abs((ob.width / ob.height) - physicalAspect) < 0.2,
    `backing canvas aspect should track physical plane aspect, got ${ob.width / ob.height}`,
  );
  assert.ok(
    Math.abs((displayWidth / displayHeight) - (ob.width / ob.height)) < 0.02,
    'display aspect should stay tied to the backing canvas aspect',
  );
});

test('drawObliqueCell preserves display aspect when the backing raster is capped', () => {
  installMprDom(512, 64);
  setSeriesState({ slug: 'oblique_capped_raster', width: 1600, height: 400, slices: 2 });
  const ob = globalThis.document.getElementById('mpr-ob');
  ob.parentElement = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1816, height: 520, right: 1816, bottom: 520 }),
  };
  initMprView({ ensureVoxels: () => false, isMprActive: () => true });

  drawObliqueCell();

  const displayWidth = stylePixels(ob.style.width);
  const displayHeight = stylePixels(ob.style.height);
  assert.equal(ob.width, 1024, 'large oblique planes should cap backing width');
  assert.ok(ob.height < 1024, 'backing height should scale down with capped width');
  assert.ok(
    Math.abs((displayWidth / displayHeight) - (ob.width / ob.height)) < 0.02,
    'display aspect should stay tied to the capped backing canvas aspect',
  );
});

test('drawMPR sends a changed display LUT key through the GPU path', () => {
  installMprDom(8, 6);
  setSeriesState({ slug: 'gpu_lut_key', width: 8, height: 6, slices: 5 });
  state.mprGpuEnabled = true;
  const seenKeys = [];
  __setMprGpuApiForTests({
    canUseGpuMpr: () => true,
    drawGpuMprSlice: (_canvas, options) => {
      seenKeys.push(options.wlLut.key);
      return true;
    },
  });
  initMprView({ ensureVoxels: () => false, isMprActive: () => true });

  drawMPR();
  state.invertDisplay = true;
  drawMPR();
  state.colormap = 'hot';
  drawMPR();

  assert.equal(new Set(seenKeys).size, 3, 'GPU MPR should see a distinct LUT key for invert and colormap changes');
  __setMprGpuApiForTests(null);
  state.mprGpuEnabled = true;
  state.invertDisplay = false;
  state.colormap = 'grayscale';
});

test('MPR cache bookkeeping: reuse, invalidation, and byte-budget bound', () => {
  installMprDom(8, 6);
  setSeriesState({ slug: 'cache_bounds', width: 150, height: 150, slices: 150 });
  initMprView({ ensureVoxels: () => false, isMprActive: () => true });
  clearMprCellCache();

  drawMPR();
  const first = getMprCellCacheStats();
  assert.ok(first.entries > 0, 'first MPR draw should seed non-axial cache entries');
  assert.ok(first.bytes > 0, 'first MPR draw should allocate sampled plane cache bytes');

  drawMPR();
  const second = getMprCellCacheStats();
  assert.equal(second.entries, first.entries, 'identical redraw should reuse cache entries');
  assert.equal(second.bytes, first.bytes, 'identical redraw should not grow cache bytes');

  state.mprX = state.mprX + 1;
  drawMPR();
  const third = getMprCellCacheStats();
  assert.ok(third.entries > second.entries, 'changing axis plane should invalidate and add a new cache entry');

  for (let i = 0; i < 160; i++) {
    state.mprX = i % state.manifest.series[0].width;
    state.mprY = (i * 7) % state.manifest.series[0].height;
    drawMPR();
  }
  const budgeted = getMprCellCacheStats();
  assert.ok(
    budgeted.bytes <= 24 * 1024 * 1024,
    'cache bytes should remain within the configured memory budget',
  );

  clearMprCellCache();
  assert.deepEqual(getMprCellCacheStats(), { entries: 0, bytes: 0 });
});

test('interactive MPR draw path keeps fast quality until settle redraw', async () => {
  installMprDom(8, 6);
  setSeriesState({ slug: 'mpr_axis_interaction', width: 10, height: 8, slices: 7 });
  initMprView({ ensureVoxels: () => false, isMprActive: () => true });

  beginMprInteraction({ axis: 'x', reason: 'test' });
  assert.equal(state.mprQuality, 'fast', 'interaction start should switch MPR to fast quality');

  state.mprX = state.mprX + 1;
  drawMPRInteractive();
  assert.equal(
    state.mprQuality,
    'fast',
    'interactive axis-update draw should stay in fast mode until settle timer fires',
  );

  await new Promise((resolve) => globalThis.setTimeout(resolve, 180));
  assert.equal(state.mprQuality, 'quality', 'interaction settle should restore quality mode');
});

test('interactive x/y scrubbing redraws only the plane that actually changes', () => {
  installMprDom(8, 6);
  setSeriesState({ slug: 'mpr_partial_interaction', width: 10, height: 8, slices: 7 });
  initMprView({ ensureVoxels: () => false, isMprActive: () => true });

  drawMPR();
  const ax = globalThis.document.getElementById('mpr-ax');
  const co = globalThis.document.getElementById('mpr-co');
  const sa = globalThis.document.getElementById('mpr-sa');
  const baseCounts = {
    ax: ax.getContext().puts,
    co: co.getContext().puts,
    sa: sa.getContext().puts,
  };

  beginMprInteraction({ axis: 'x', reason: 'test' });
  state.mprX += 1;
  drawMPRInteractive();
  assert.equal(ax.getContext().puts, baseCounts.ax, 'x scrub should not redraw axial image bytes');
  assert.equal(co.getContext().puts, baseCounts.co, 'x scrub should not redraw coronal image bytes');
  assert.ok(sa.getContext().puts > baseCounts.sa, 'x scrub should redraw sagittal image bytes');

  const xCounts = {
    ax: ax.getContext().puts,
    co: co.getContext().puts,
    sa: sa.getContext().puts,
  };
  beginMprInteraction({ axis: 'y', reason: 'test' });
  state.mprY += 1;
  drawMPRInteractive();
  assert.equal(ax.getContext().puts, xCounts.ax, 'y scrub should not redraw axial image bytes');
  assert.ok(co.getContext().puts > xCounts.co, 'y scrub should redraw coronal image bytes');
  assert.equal(sa.getContext().puts, xCounts.sa, 'y scrub should not redraw sagittal image bytes');
});

test('oblique interaction reuses the same fast then settle quality contract', async () => {
  setSeriesState({ slug: 'oblique_interaction', width: 10, height: 8, slices: 7 });
  initMprView({ ensureVoxels: () => false, isMprActive: () => false });

  beginObliqueInteraction();
  assert.equal(state.mprQuality, 'fast', 'oblique input should switch MPR to fast quality');

  await new Promise((resolve) => globalThis.setTimeout(resolve, 180));
  assert.equal(state.mprQuality, 'quality', 'oblique settle should restore quality mode');
});

test('oblique MPR keeps canvas dimensions stable through real interaction settle', async () => {
  installMprDom(128, 128);
  setSeriesState({ slug: 'oblique_stable_size', width: 128, height: 128, slices: 80 });
  state.manifest.series[0].pixelSpacing = [1, 1];
  state.manifest.series[0].sliceSpacing = 2;
  state.obPitch = 30;
  initMprView({ ensureVoxels: () => false, isMprActive: () => true });

  state.mprQuality = 'quality';
  drawObliqueCell();
  const canvas = globalThis.document.getElementById('mpr-ob');
  const qualitySize = {
    width: canvas.width,
    height: canvas.height,
    styleWidth: canvas.style.width,
    styleHeight: canvas.style.height,
  };

  beginObliqueInteraction();
  state.mprZ += 4;
  drawObliqueCell();
  const fastSize = {
    width: canvas.width,
    height: canvas.height,
    styleWidth: canvas.style.width,
    styleHeight: canvas.style.height,
  };
  await new Promise((resolve) => globalThis.setTimeout(resolve, 180));

  const settledSize = {
    width: canvas.width,
    height: canvas.height,
    styleWidth: canvas.style.width,
    styleHeight: canvas.style.height,
  };

  assert.deepEqual(fastSize, qualitySize);
  assert.deepEqual(settledSize, qualitySize);
});

test('Z scrub keeps oblique pane stable until the settled full MPR redraw', async () => {
  installMprDom(128, 128);
  setSeriesState({ slug: 'z_scrub_oblique_deferred', width: 128, height: 128, slices: 80 });
  state.manifest.series[0].pixelSpacing = [1, 1];
  state.manifest.series[0].sliceSpacing = 2;
  state.obPitch = 30;
  initMprView({ ensureVoxels: () => false, isMprActive: () => true });

  drawMPR();
  const canvas = globalThis.document.getElementById('mpr-ob');
  const before = {
    puts: canvas.getContext().puts,
    width: canvas.width,
    height: canvas.height,
    styleWidth: canvas.style.width,
    styleHeight: canvas.style.height,
  };

  state.mprZ += 4;
  drawMPRZScrub();
  const during = {
    puts: canvas.getContext().puts,
    width: canvas.width,
    height: canvas.height,
    styleWidth: canvas.style.width,
    styleHeight: canvas.style.height,
  };

  await new Promise((resolve) => globalThis.setTimeout(resolve, 180));
  const settled = {
    puts: canvas.getContext().puts,
    width: canvas.width,
    height: canvas.height,
    styleWidth: canvas.style.width,
    styleHeight: canvas.style.height,
  };

  assert.deepEqual(during, before, 'active Z scrub should not resize or repaint oblique');
  assert.ok(settled.puts > before.puts, 'settle redraw should refresh oblique after scrub');
  assert.deepEqual({ ...settled, puts: before.puts }, before, 'settle redraw should preserve oblique geometry');
});

test('getMprVolumeReadiness reports base and overlay readiness gates', () => {
  setSeriesState({ slug: 'readiness_report', width: 6, height: 6, slices: 4 });
  state.useSeg = true;
  state.useRegions = true;
  state.regionMeta = { colors: {}, legend: {} };
  state.segVoxels = null;
  state.regionVoxels = null;

  assert.deepEqual(getMprVolumeReadiness(), {
    baseReady: true,
    overlaysReady: { seg: false, regions: false, sym: true, fusion: true },
  });
});

test('drawMPR renders shared note points in orthogonal panes', () => {
  storage.clear();
  installMprDom(8, 6);
  setSeriesState({ slug: 'mpr_notes', width: 8, height: 6, slices: 5 });
  state.mprX = 2;
  state.mprY = 4;
  state.mprZ = 3;
  setNoteEntriesForSlice('mpr_notes', 3, [{ id: 1, x: 2, y: 4, text: 'visible in all orthogonal panes' }]);
  initMprView({ ensureVoxels: () => false, isMprActive: () => true });

  drawMPR();

  assert.ok(globalThis.document.getElementById('mpr-ax').getContext().arcs > 0, 'axial pane should render the note on its native slice');
  assert.ok(globalThis.document.getElementById('mpr-co').getContext().arcs > 0, 'coronal pane should render the note at matching y/z');
  assert.ok(globalThis.document.getElementById('mpr-sa').getContext().arcs > 0, 'sagittal pane should render the note at matching x/z');
});
