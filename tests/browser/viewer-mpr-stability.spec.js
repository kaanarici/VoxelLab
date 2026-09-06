import { expect, test } from '@playwright/test';
import { localVolumeSeries, routeLocalVolumeStudy } from './local-volume-fixture.mjs';

async function openBrowserFixture(page, slug) {
  await routeLocalVolumeStudy(page, [
    localVolumeSeries(slug, 'MPR stability fixture', { width: 32, height: 32, slices: 8 }),
  ]);
  const response = await page.goto('/?localBackend=1', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok(), `root response status: ${response && response.status()}`).toBe(true);
  await expect(page.locator('#series-list li').first()).toBeVisible();
  await page.locator('#series-list li').first().click();
  await expect(page.locator('#viewer-spinner')).toBeHidden();
}

test('MPR oblique pane keeps display aspect in the real browser layout', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await openBrowserFixture(page, 'mpr_aspect_boot');

  const metrics = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
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
    state.mpr.x = 800;
    state.mpr.y = 200;
    state.mpr.z = 1;
    state.mpr.quality = 'quality';
    state.mpr.obYaw = 0;
    state.mpr.obPitch = 0;
    state.window = 255;
    state.level = 128;
    state.colormap = 'grayscale';
    state.invertDisplay = false;
    state.overlays.tissue = false;
    state.overlays.labels = false;
    state.overlays.heatmap = false;
    state.overlays.fusionSlug = '';
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

  await page.setViewportSize({ width: 900, height: 720 });
  await expect.poll(() => page.locator('#mpr-ob').evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    return Math.abs((rect.width / rect.height) - (canvas.width / canvas.height));
  })).toBeLessThan(0.02);
  const resized = await page.locator('#mpr-ob').evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    const cell = canvas.parentElement.getBoundingClientRect();
    return {
      displayWidth: Math.round(rect.width),
      displayHeight: Math.round(rect.height),
      fitsCell: rect.right <= cell.right + 1 && rect.bottom <= cell.bottom + 1,
    };
  });
  expect(resized.displayWidth, JSON.stringify(resized)).toBeGreaterThan(0);
  expect(resized.displayHeight, JSON.stringify(resized)).toBeGreaterThan(0);
  expect(resized.fitsCell, JSON.stringify(resized)).toBe(true);
});

test('MPR Z scrub keeps oblique pane geometry stable through settle redraw', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBrowserFixture(page, 'mpr_scrub_boot');

  const snapshots = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const { drawMPR, drawMPRZScrub } = await import('/js/slice-view.js');
    const { setMprPosition } = await import('/js/core/state/viewer-commands.js');
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
    state.mpr.x = 64;
    state.mpr.y = 64;
    state.mpr.z = 40;
    state.mpr.quality = 'quality';
    state.mpr.obYaw = 0;
    state.mpr.obPitch = 30;
    state.window = 255;
    state.level = 128;
    state.colormap = 'grayscale';
    state.invertDisplay = false;
    state.overlays.tissue = false;
    state.overlays.labels = false;
    state.overlays.heatmap = false;
    state.overlays.fusionSlug = '';
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
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const visibleSnap = async () => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const snapshot = snap();
        if (snapshot.rectWidth > 0 && snapshot.rectHeight > 0) return snapshot;
        await nextFrame();
      }
      return snap();
    };

    drawMPR();
    const before = await visibleSnap();
    setMprPosition({ z: 44 }, series, { syncSlice: true });
    drawMPRZScrub();
    const during = await visibleSnap();
    await new Promise((resolve) => setTimeout(resolve, 220));
    await nextFrame();
    await nextFrame();
    return { before, during, settled: await visibleSnap() };
  });

  const stableGeometry = ({ width, height, styleWidth, styleHeight }) => ({
    width,
    height,
    styleWidth,
    styleHeight,
  });

  expect(snapshots.before.rectWidth, JSON.stringify(snapshots)).toBeGreaterThan(0);
  expect(snapshots.before.rectHeight, JSON.stringify(snapshots)).toBeGreaterThan(0);
  expect(stableGeometry(snapshots.during)).toEqual(stableGeometry(snapshots.before));
  expect(stableGeometry(snapshots.settled)).toEqual(stableGeometry(snapshots.before));
});
