import { expect, test } from '@playwright/test';

/* global document, setTimeout, window */

test('MPR oblique pane keeps display aspect in the real browser layout', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  const response = await page.goto('/?localBackend=1', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok(), `root response status: ${response && response.status()}`).toBe(true);

  const metrics = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { drawObliqueCell } = await import('/js/slice-view.js');
    const series = {
      slug: 'browser_oblique_aspect',
      name: 'Browser oblique aspect fixture',
      width: 1600,
      height: 400,
      slices: 2,
      pixelSpacing: [1, 1],
      sliceSpacing: 1,
      sliceThickness: 1,
    };
    const voxelCount = series.width * series.height * series.slices;
    const voxels = new Float32Array(voxelCount);
    for (let i = 0; i < voxelCount; i += 1) voxels[i] = (i % 257) / 256;
    state.manifest = { series: [series] };
    state.seriesIdx = 0;
    state.mode = 'mpr';
    state.loaded = true;
    state.sliceIdx = 0;
    state.mprX = 800;
    state.mprY = 200;
    state.mprZ = 1;
    state.mprQuality = 'quality';
    state.obYaw = 0;
    state.obPitch = 0;
    state.window = 255;
    state.level = 128;
    state.colormap = 'grayscale';
    state.invertDisplay = false;
    state.useSeg = false;
    state.useRegions = false;
    state.useSym = false;
    state.fusionSlug = '';
    state.hrVoxels = voxels;
    state.voxels = null;
    state.mpr.viewports = {
      ax: { zoom: 1, tx: 0, ty: 0 },
      co: { zoom: 1, tx: 0, ty: 0 },
      sa: { zoom: 1, tx: 0, ty: 0 },
      ob: { zoom: 1, tx: 0, ty: 0 },
    };

    const wrap = document.getElementById('canvas-wrap');
    wrap.classList.remove('no-series', 'threeD', 'cmp', 'mpr3d');
    wrap.classList.add('mpr');
    drawObliqueCell();

    const canvas = document.getElementById('mpr-ob');
    const rect = canvas.getBoundingClientRect();
    const cellRect = canvas.parentElement.getBoundingClientRect();
    const root = document.documentElement;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const center = ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
    return {
      backingWidth: canvas.width,
      backingHeight: canvas.height,
      displayWidth: rect.width,
      displayHeight: rect.height,
      backingAspect: canvas.width / canvas.height,
      displayAspect: rect.width / rect.height,
      fitsCell: rect.right <= cellRect.right + 1 && rect.bottom <= cellRect.bottom + 1,
      rootScrollWidth: root.scrollWidth,
      viewportWidth: window.innerWidth,
      centerMax: Math.max(center[0], center[1], center[2]),
    };
  });

  expect(metrics.backingWidth, JSON.stringify(metrics)).toBeGreaterThan(0);
  expect(metrics.backingHeight, JSON.stringify(metrics)).toBeGreaterThan(0);
  expect(metrics.backingWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(1024);
  expect(metrics.backingHeight, JSON.stringify(metrics)).toBeLessThanOrEqual(1024);
  expect(Math.abs(metrics.displayAspect - metrics.backingAspect), JSON.stringify(metrics)).toBeLessThan(0.02);
  expect(metrics.fitsCell, JSON.stringify(metrics)).toBe(true);
  expect(metrics.rootScrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.centerMax, JSON.stringify(metrics)).toBeGreaterThan(0);
});

test('MPR Z scrub keeps oblique pane geometry stable through settle redraw', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const response = await page.goto('/?localBackend=1', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok(), `root response status: ${response && response.status()}`).toBe(true);

  const snapshots = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { drawMPR, drawMPRZScrub } = await import('/js/slice-view.js');
    const { setMprPosition } = await import('/js/state/viewer-commands.js');
    const series = {
      slug: 'browser_oblique_scrub',
      name: 'Browser oblique scrub fixture',
      width: 128,
      height: 128,
      slices: 80,
      pixelSpacing: [1, 1],
      sliceSpacing: 2,
      sliceThickness: 2,
    };
    const voxelCount = series.width * series.height * series.slices;
    const voxels = new Float32Array(voxelCount);
    for (let i = 0; i < voxelCount; i += 1) voxels[i] = (i % 193) / 192;
    state.manifest = { series: [series] };
    state.seriesIdx = 0;
    state.mode = 'mpr';
    state.loaded = true;
    state.sliceIdx = 40;
    state.mprX = 64;
    state.mprY = 64;
    state.mprZ = 40;
    state.mprQuality = 'quality';
    state.obYaw = 0;
    state.obPitch = 30;
    state.window = 255;
    state.level = 128;
    state.colormap = 'grayscale';
    state.invertDisplay = false;
    state.useSeg = false;
    state.useRegions = false;
    state.useSym = false;
    state.fusionSlug = '';
    state.hrVoxels = voxels;
    state.voxels = null;
    state.mpr.viewports = {
      ax: { zoom: 1, tx: 0, ty: 0 },
      co: { zoom: 1, tx: 0, ty: 0 },
      sa: { zoom: 1, tx: 0, ty: 0 },
      ob: { zoom: 1, tx: 0, ty: 0 },
    };
    const wrap = document.getElementById('canvas-wrap');
    wrap.classList.remove('no-series', 'threeD', 'cmp', 'mpr3d');
    wrap.classList.add('mpr');
    const snap = () => {
      const canvas = document.getElementById('mpr-ob');
      const rect = canvas.getBoundingClientRect();
      return {
        width: canvas.width,
        height: canvas.height,
        styleWidth: canvas.style.width,
        styleHeight: canvas.style.height,
        rectWidth: Math.round(rect.width),
        rectHeight: Math.round(rect.height),
      };
    };

    drawMPR();
    const before = snap();
    setMprPosition({ z: 44 }, series, { syncSlice: true });
    drawMPRZScrub();
    const during = snap();
    await new Promise((resolve) => setTimeout(resolve, 220));
    return { before, during, settled: snap() };
  });

  expect(snapshots.during).toEqual(snapshots.before);
  expect(snapshots.settled).toEqual(snapshots.before);
});
