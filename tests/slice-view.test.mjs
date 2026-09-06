import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new globalThis.URL('http://127.0.0.1/');
globalThis.window = globalThis.window || { addEventListener() {}, devicePixelRatio: 1 };
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => fn());
const storage = new Map();
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
};

const { state } = await import('../js/core/state.js');
const { drawSlice, markViewAwaitingSliceFade, showHoverAt } = await import('../js/slice-view.js');

function createOffscreenCanvas() {
  let currentImage = null;
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      clearRect() {},
      drawImage(img) { currentImage = img; },
      getImageData(_x, _y, w, h) {
        const bytes = currentImage?._bytes || new Uint8Array(w * h).fill(0);
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0, p = 0; i < bytes.length; i += 1, p += 4) {
          data[p] = bytes[i];
          data[p + 1] = bytes[i];
          data[p + 2] = bytes[i];
          data[p + 3] = 255;
        }
        return { data };
      },
    }),
  };
}

function createVisibleCanvas() {
  const created = [];
  const calls = [];
  const ctx = {
    created,
    calls,
    createImageData(w, h) {
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
  return {
    ctx,
    width: 0,
    height: 0,
    style: {},
    getContext: () => ctx,
  };
}

function createClassList(initial = []) {
  const set = new Set(initial);
  return {
    add(name) { set.add(name); },
    remove(name) { set.delete(name); },
    replace(from, to) { set.delete(from); set.add(to); },
    contains(name) { return set.has(name); },
  };
}

test('drawSlice applies spacing-aware display size for anisotropic 2d images', () => {
  const view = createVisibleCanvas();
  const nodes = new Map([
    ['view', view],
    ['view-xform', { classList: createClassList() }],
    ['slice-big', { textContent: '' }],
    ['wl-readout', { textContent: '' }],
  ]);
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return createOffscreenCanvas();
      return { style: {}, classList: createClassList(), appendChild() {} };
    },
    documentElement: { classList: createClassList() },
    getElementById(id) {
      return nodes.get(id) || null;
    },
  };

  state.loaded = true;
  state.mode = '2d';
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.window = 120;
  state.level = 60;
  state.overlays.tissue = false;
  state.overlays.labels = false;
  state.overlays.heatmap = false;
  state.overlays.fusionSlug = '';
  state.manifest = {
    series: [{ slug: 'slice_spacing', width: 4, height: 2, slices: 1, pixelSpacing: [3, 1] }],
  };
  state.imgs = [{ complete: true, naturalWidth: 4, _bytes: Uint8Array.from([0, 64, 128, 255, 10, 20, 30, 40]) }];

  drawSlice();

  assert.equal(view.style.width, '4px');
  assert.equal(view.style.height, '6px');
});

test('drawSlice reuses microscopy composite ImageData without fallback visible-canvas allocations', () => {
  const view = createVisibleCanvas();
  const nodes = new Map([
    ['view', view],
    ['view-xform', { classList: createClassList() }],
    ['slice-big', { textContent: '' }],
    ['wl-readout', { textContent: '' }],
  ]);
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return createOffscreenCanvas();
      return { style: {}, classList: createClassList(), appendChild() {} };
    },
    documentElement: { classList: createClassList() },
    getElementById(id) {
      return nodes.get(id) || null;
    },
  };

  const series = {
    slug: 'micro_composite_alloc',
    imageDomain: 'microscopy',
    width: 2,
    height: 1,
    slices: 1,
    microscopy: {
      sizeC: 2,
      timeIndex: 0,
      composite: { enabled: true, channels: [true, true] },
    },
    microscopyDataset: {
      channels: [
        { index: 0, color: '#FF0000' },
        { index: 1, color: '#00FF00' },
      ],
    },
  };
  state.loaded = true;
  state.mode = '2d';
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.window = 255;
  state.level = 128;
  state.invertDisplay = false;
  state.overlays.tissue = false;
  state.overlays.labels = false;
  state.overlays.heatmap = false;
  state.overlays.fusionSlug = '';
  state.manifest = { series: [series] };
  state.imgs = [{ complete: true, naturalWidth: 2, _bytes: Uint8Array.from([0, 0]) }];
  state.segImgs = [];
  state.symImgs = [];
  state.regionImgs = [];
  state.regionVoxels = null;
  state.fusionImgs = null;
  state._localMicroscopyStacks = {
    micro_composite_alloc: {
      '0|0': [{ complete: true, naturalWidth: 2, _bytes: Uint8Array.from([255, 0]) }],
      '1|0': [{ complete: true, naturalWidth: 2, _bytes: Uint8Array.from([0, 128]) }],
    },
  };

  drawSlice();
  assert.equal(view.ctx.created.length, 1);
  assert.equal(view.ctx.calls.length, 1);
  assert.deepEqual([...view.ctx.calls[0].image.data], [
    255, 0, 0, 255,
    0, 128, 0, 255,
  ]);

  drawSlice();
  assert.equal(view.ctx.created.length, 1);
  assert.equal(view.ctx.calls.length, 2);
  assert.deepEqual([...view.ctx.calls[view.ctx.calls.length - 1].image.data], [
    255, 0, 0, 255,
    0, 128, 0, 255,
  ]);
});

test('showHoverAt resolves hover region names from the active labels overlay image', () => {
  const view = createVisibleCanvas();
  view.width = 2;
  view.height = 2;
  view.getBoundingClientRect = () => ({
    left: 10,
    top: 20,
    right: 12,
    bottom: 22,
    width: 2,
    height: 2,
  });
  const hover = {
    innerHTML: '',
    classList: createClassList(),
    offsetWidth: 40,
    offsetHeight: 20,
    style: {},
  };
  const nodes = new Map([
    ['view', view],
    ['canvas-wrap', {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }),
    }],
    ['hover-readout', hover],
  ]);
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return createOffscreenCanvas();
      return { style: {}, classList: createClassList(), appendChild() {} };
    },
    documentElement: { classList: createClassList() },
    getElementById(id) {
      return nodes.get(id) || null;
    },
  };

  state.loaded = true;
  state.mode = '2d';
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.overlays.tissue = false;
  state.overlays.heatmap = false;
  state.overlays.labels = true;
  state.overlays.fusionSlug = '';
  state.manifest = {
    series: [{ slug: 'hover_regions', width: 2, height: 2, slices: 1, hasRegions: true }],
  };
  state.imgs = [{ complete: true, naturalWidth: 2, _bytes: Uint8Array.from([10, 20, 30, 40]) }];
  state.regionImgs = [{ complete: true, naturalWidth: 2, _bytes: Uint8Array.from([0, 7, 0, 0]) }];

  state.overlays.regionMeta = { legend: { 7: 'Thalamus' }, colors: { 7: [255, 0, 0] } };
  state.regionVoxels = null;

  showHoverAt(11.2, 20.2);

  assert.match(hover.innerHTML, /region/);
  assert.match(hover.innerHTML, /Thalamus/);
  assert.equal(hover.classList.contains('visible'), true);
});

function lastPutImage(view) {
  return view.ctx.calls.at(-1).image.data;
}

function rgbaAt(data, index) {
  const p = index * 4;
  return [data[p], data[p + 1], data[p + 2], data[p + 3]];
}

function bindSliceView(view) {
  const nodes = new Map([
    ['view', view],
    ['view-xform', { classList: createClassList() }],
    ['slice-big', { textContent: '' }],
    ['wl-readout', { textContent: '' }],
  ]);
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return createOffscreenCanvas();
      return { style: {}, classList: createClassList(), appendChild() {} };
    },
    documentElement: { classList: createClassList() },
    getElementById(id) {
      return nodes.get(id) || null;
    },
  };
}

test('drawSlice walks OVERLAY_CACHE_BY_KIND instead of a persist-kind ladder', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../js/slice-view.js', import.meta.url), 'utf8');
  const start = source.indexOf('export function drawSlice');
  const drawSliceSrc = source.slice(start);
  assert.match(drawSliceSrc, /overlayBytesFromCaches/);
  assert.equal(/overlays\.tissue\.enabled/.test(drawSliceSrc), false);
  assert.equal(/overlays\.heatmap\.enabled/.test(drawSliceSrc), false);
  assert.equal(/overlays\.labels\.enabled/.test(drawSliceSrc), false);
});

test('drawSlice composites every overlay-table kind including labels voxels', () => {
  const view = createVisibleCanvas();
  bindSliceView(view);

  const plane = 4;
  state.loaded = true;
  state.mode = '2d';
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.window = 255;
  state.level = 128;
  state.overlays.tissue = false;
  state.overlays.labels = false;
  state.overlays.heatmap = false;
  state.overlays.fusionSlug = '';
  state.overlays.overlayOpacity = 0.55;
  state.overlays.fusionOpacity = 0.5;
  state.manifest = {
    series: [{
      slug: 'slice_table_paint',
      width: 2,
      height: 2,
      slices: 1,
      hasSeg: true,
      hasRegions: true,
      hasSym: true,
    }],
  };
  state.imgs = [{ complete: true, naturalWidth: 2, _bytes: Uint8Array.from([40, 40, 40, 40]) }];
  state.segImgs = [{ complete: true, naturalWidth: 2, _bytes: Uint8Array.from([1, 0, 0, 0]) }];
  state.symImgs = [{ complete: true, naturalWidth: 2, _bytes: Uint8Array.from([0, 200, 0, 0]) }];
  state.regionImgs = [{ complete: false, naturalWidth: 0 }];
  state.regionVoxels = Uint8Array.from([0, 0, 7, 0]);
  state.overlays.regionMeta = { legend: { 7: 'Caudate' }, colors: { 7: [255, 0, 0] } };
  state.fusionImgs = [{ complete: true, naturalWidth: 2, _bytes: Uint8Array.from([0, 0, 0, 200]) }];

  drawSlice();
  const gray = Uint8ClampedArray.from(lastPutImage(view));

  state.overlays.tissue = true;
  drawSlice();
  const tissue = lastPutImage(view);
  assert.notDeepEqual(rgbaAt(tissue, 0), rgbaAt(gray, 0));
  assert.deepEqual(rgbaAt(tissue, 1), rgbaAt(gray, 1));

  state.overlays.heatmap = true;
  drawSlice();
  const heatmap = lastPutImage(view);
  assert.notDeepEqual(rgbaAt(heatmap, 1), rgbaAt(gray, 1));

  state.overlays.labels = true;
  drawSlice();
  const labels = lastPutImage(view);
  assert.notDeepEqual(rgbaAt(labels, 2), rgbaAt(gray, 2));

  state.overlays.fusionSlug = 'slice_table_paint_pet';
  drawSlice();
  const fused = lastPutImage(view);
  assert.notDeepEqual(rgbaAt(fused, 3), rgbaAt(gray, 3));
  assert.notDeepEqual(rgbaAt(fused, 0), rgbaAt(gray, 0));
  assert.notDeepEqual(rgbaAt(fused, 1), rgbaAt(gray, 1));
  assert.notDeepEqual(rgbaAt(fused, 2), rgbaAt(gray, 2));
  assert.equal(state.regionVoxels.length, plane);
});

test('markViewAwaitingSliceFade collapses leftover canvas CSS so a hidden 512 box cannot overflow', () => {
  const view = createVisibleCanvas();
  view.style.width = '512px';
  view.style.height = '512px';
  const xform = { classList: createClassList(['ui-fade-in']) };
  globalThis.document = {
    getElementById(id) {
      if (id === 'view') return view;
      if (id === 'view-xform') return xform;
      return null;
    },
  };

  markViewAwaitingSliceFade();

  assert.equal(view.style.width, '0px');
  assert.equal(view.style.height, '0px');
  assert.equal(xform.classList.contains('view-awaiting-slice'), true);
  assert.equal(xform.classList.contains('ui-fade-in'), false);
});
