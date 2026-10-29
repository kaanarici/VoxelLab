import { expect, test } from '@playwright/test';
import { VIEWER_PERF_BUDGET } from '../fixtures/performance-budget.mjs';
import {
  localVolumeSeries,
  openPerfViewer,
  openPerfVolumeFixture,
  routeLocalVolumeStudy,
} from '../helpers/browser/local-study.mjs';
import { canvasChecksum, waitForCanvasPaint } from '../helpers/browser/canvas.mjs';

test.setTimeout(90_000);

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6p2ioAAAAASUVORK5CYII=',
  'base64',
);

async function clearPerf(page) {
  await page.evaluate(() => globalThis.__voxellabPerf?.clear?.());
}

async function waitForPerfEvent(page, name, timeout = 12_000) {
  try {
    const handle = await page.waitForFunction((traceName) => {
      const matches = (globalThis.__voxellabPerf?.history || []).filter((entry) => entry.name === traceName);
      return matches.length ? matches[matches.length - 1] : null;
    }, name, { timeout, polling: 100 });
    return await handle.jsonValue();
  } catch {
    return null;
  }
}

async function mprQuality(page) {
  return page.evaluate(async () => (await import('/js/core/state.js')).state.mpr.quality);
}

async function pendingPerfCount(page, name) {
  return page.evaluate((traceName) => (
    (globalThis.__voxellabPerf?.pending || []).find((entry) => entry.name === traceName)?.count || 0
  ), name);
}

async function scrubBurst(page, count = 48) {
  return page.evaluate(async (iterations) => {
    const scrub = document.querySelector('#scrub');
    const max = Number(scrub?.max || 0);
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      scrub.value = String(i % Math.max(1, max + 1));
      scrub.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return performance.now() - start;
  }, count);
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundMs(value) {
  return Number(value.toFixed(1));
}

function budgetReport(metrics) {
  return Object.fromEntries(
    Object.entries(metrics).map(([name, value]) => {
      const actualMs = roundMs(value);
      const baselineMs = VIEWER_PERF_BUDGET.baselineMs[name] ?? null;
      return [name, {
        actualMs,
        baselineMs,
        maxMs: VIEWER_PERF_BUDGET.maxMs[name] ?? null,
        deltaMs: baselineMs == null ? null : roundMs(actualMs - baselineMs),
      }];
    }),
  );
}

function expectWithinBudget(name, value) {
  const maxMs = VIEWER_PERF_BUDGET.maxMs[name];
  if (maxMs == null) return;
  expect(
    value,
    `${name} took ${roundMs(value)}ms, budget is ${maxMs}ms`,
  ).toBeLessThan(maxMs);
}

async function mprAxisIndex(page, selector) {
  const label = (await page.locator(selector).textContent()) || '';
  const match = label.match(/\b(\d+)\s*\/\s*(\d+)\b/);
  return match ? Number(match[1]) : null;
}

async function wheelMprAxesAndSnapshotOblique(page, moves) {
  return page.evaluate((entries) => {
    const checksum = (canvas) => {
      const ctx = canvas?.getContext('2d', { willReadFrequently: true });
      if (!ctx || canvas.width === 0 || canvas.height === 0) return 'blank';
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      const stride = Math.max(4, Math.floor(data.length / 4096));
      for (let index = 0; index < data.length; index += stride) {
        hash ^= data[index];
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      return `${canvas.width}x${canvas.height}:${hash}`;
    };

    for (const entry of entries) {
      const canvas = document.querySelector(entry.selector);
      const rect = canvas.getBoundingClientRect();
      for (let i = 0; i < entry.steps; i += 1) {
        canvas.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: entry.deltaY,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }));
      }
    }

    return checksum(document.querySelector('#mpr-ob'));
  }, moves);
}

async function obliqueSnapshot(page) {
  return page.locator('#mpr-ob').evaluate(async (canvas) => {
    const { state } = await import('/js/core/state.js');
    const { geometryFromSeries } = await import('/js/core/geometry.js');
    const { obliquePlaneExtentMm } = await import('/js/mpr/mpr-oblique.js');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rect = canvas.getBoundingClientRect();
    const series = state.manifest?.series?.[state.seriesIdx];
    const geo = geometryFromSeries(series);
    const extent = obliquePlaneExtentMm(
      { W: series.width, H: series.height, D: series.slices },
      { row: geo.rowSpacing, col: geo.colSpacing, slice: geo.sliceSpacing },
      [state.mpr.x, state.mpr.y, state.mpr.z],
      state.mpr.obYaw,
      state.mpr.obPitch,
    );
    let hash = 2166136261;
    if (ctx && canvas.width > 0 && canvas.height > 0) {
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const stride = Math.max(4, Math.floor(data.length / 4096));
      for (let index = 0; index < data.length; index += stride) {
        hash ^= data[index];
        hash = Math.imul(hash, 16777619) >>> 0;
      }
    }
    return {
      backing: `${canvas.width}x${canvas.height}`,
      display: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
      aspectDelta: Math.abs((rect.width / rect.height) - (canvas.width / canvas.height)),
      physicalAspectDelta: Math.abs((canvas.width / canvas.height) - (extent.widthMm / extent.heightMm)),
      checksum: `${canvas.width}x${canvas.height}:${hash}`,
    };
  });
}

async function zScrubAndSnapshotOblique(page) {
  await page.evaluate(async () => {
    const scrub = document.querySelector('#scrub');
    const max = Number(scrub?.max || 0);
    const current = Number(scrub.value || 0);
    scrub.value = String(current >= max ? Math.max(0, max - 1) : current + 1);
    scrub.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  return obliqueSnapshot(page);
}

async function obliqueSliderAndSnapshot(page, selector, value) {
  await page.locator(selector).evaluate(async (input, nextValue) => {
    input.value = String(nextValue);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, value);
  return obliqueSnapshot(page);
}

function stableObliqueLayout({ backing, display, aspectDelta, physicalAspectDelta }) {
  return { backing, display, aspectDelta, physicalAspectDelta };
}

async function routePerfCloudFixture(page, { overlayDelayMs = 900 } = {}) {
  const slug = 'cloud_perf_sym';
  const series = {
    slug,
    name: 'Cloud Perf Sym',
    description: 'remote delayed sym overlay',
    modality: 'CT',
    slices: 2,
    width: 64,
    height: 64,
    pixelSpacing: [1, 1],
    sliceThickness: 1,
    firstIPP: [0, 0, 0],
    lastIPP: [0, 0, 1],
    hasSym: true,
    sliceUrlBase: `https://cloud-perf.example/base/${slug}`,
    overlayUrlBases: {
      [`${slug}_sym`]: `https://cloud-perf.example/sym/${slug}`,
    },
  };
  await page.route('**/config.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        modalWebhookBase: '',
        r2PublicUrl: '',
        trustedUploadOrigins: [],
        localApiToken: '',
        localAiAvailable: true,
        ai: { enabled: true, provider: 'claude', ready: true, issues: [] },
        siteName: 'VoxelLab',
        disclaimer: 'Not for clinical use. For research and educational purposes only.',
        features: { cloudProcessing: false, aiAnalysis: true },
      }),
    });
  });
  await page.route('**/data/manifest.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ patient: 'anonymous', studyDate: '', series: [series] }),
    });
  });
  await page.route(`https://cloud-perf.example/base/${slug}/*.png`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG });
  });
  await page.route(`https://cloud-perf.example/sym/${slug}/*.png`, async (route) => {
    await page.waitForTimeout(overlayDelayMs);
    await route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG });
  });
}

test('cold shell stays within the established module and byte budgets', async ({ page }) => {
  await routeLocalVolumeStudy(page, [localVolumeSeries('startup_volume', 'Startup Volume')]);
  const responses = [];
  page.on('response', response => {
    if (response.request().resourceType() !== 'image') responses.push(response);
  });
  await page.goto('/?localBackend=1', { waitUntil: 'networkidle' });
  const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => ({
    name: entry.name,
    transferSize: entry.transferSize,
    decodedBodySize: entry.decodedBodySize,
  })));
  const scriptCount = resources.filter(entry => /\.(?:m?js)(?:\?|$)/.test(entry.name)).length;
  const decodedBytes = resources.reduce((sum, entry) => sum + entry.decodedBodySize, 0);

  expect(scriptCount, `cold shell loaded ${scriptCount} script modules`).toBeLessThanOrEqual(180);
  expect(decodedBytes, `cold shell decoded ${decodedBytes} bytes`).toBeLessThanOrEqual(1_500_000);
  expect(responses.length).toBeGreaterThan(0);
});

test('viewer runtime paths keep emitting performance milestones within budget', async ({ page }, testInfo) => {
  await openPerfVolumeFixture(page);

  const selectSeriesEvent = await waitForPerfEvent(page, 'select-series-2d');
  expect(selectSeriesEvent, 'missing select-series-2d trace').toBeTruthy();
  expectWithinBudget('selectSeries2dMs', selectSeriesEvent.duration);

  await clearPerf(page);
  const scrub2dMs = [await scrubBurst(page), await scrubBurst(page)];
  const scrub2dAvgMs = average(scrub2dMs);
  expect(scrub2dAvgMs).not.toBeNull();
  expectWithinBudget('scrub2dAvgMs', scrub2dAvgMs);

  await clearPerf(page);
  await page.locator('#btn-3d').click();
  await expect(page.locator('#three-container.active canvas')).toBeVisible();
  const threeEvent = await waitForPerfEvent(page, 'enter-3d', 4_000);
  expect(threeEvent, 'missing enter-3d trace').toBeTruthy();
  expectWithinBudget('enter3dMs', threeEvent.duration);
  await page.locator('#btn-3d').click();

  const summary = {
    selectSeries2dMs: selectSeriesEvent.duration,
    scrub2dAvgMs,
    enter3dMs: threeEvent.duration,
  };
  await testInfo.attach('viewer-performance.json', {
    body: JSON.stringify({ ...summary, scrub2dMs }, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('viewer-performance-budget-report.json', {
    body: JSON.stringify(budgetReport(summary), null, 2),
    contentType: 'application/json',
  });
});

test('MPR Z scrub settles through a full-quality redraw without moving the oblique pane', async ({ page }) => {
  await openPerfVolumeFixture(page);
  await clearPerf(page);
  await page.locator('#btn-mpr').click();
  const mprEvent = await waitForPerfEvent(page, 'enter-mpr', 3_000);
  expect(mprEvent, 'missing enter-mpr trace').toBeTruthy();
  expectWithinBudget('enterMprMs', mprEvent.duration);
  await waitForCanvasPaint(page, '#mpr-ob');

  const before = await obliqueSnapshot(page);
  const during = await zScrubAndSnapshotOblique(page);
  expect(
    stableObliqueLayout(during),
    JSON.stringify({ before, during }),
  ).toEqual(stableObliqueLayout(before));

  const settleEvent = await waitForPerfEvent(page, 'mpr-quality-settle', 3_000);
  expect(settleEvent, 'Z scrub should settle through a full-quality MPR redraw').not.toBeNull();
  const after = await obliqueSnapshot(page);
  expect(after.backing, JSON.stringify(after)).toBe(before.backing);
  expect(after.display, JSON.stringify(after)).toBe(before.display);
  expect(after.aspectDelta, JSON.stringify(after)).toBeLessThan(0.025);
  expect(after.physicalAspectDelta, JSON.stringify(after)).toBeLessThan(0.05);

  expect(await page.locator('#mpr-ob').evaluate((canvas) => {
    const style = getComputedStyle(canvas.closest('.mpr-cell'));
    return { minWidth: style.minWidth, minHeight: style.minHeight };
  })).toEqual({ minWidth: '0px', minHeight: '0px' });
});

test('oblique pitch keeps the pane geometry stable through its settle redraw', async ({ page }) => {
  await openPerfVolumeFixture(page);
  await clearPerf(page);
  await page.locator('#btn-mpr').click();
  expect(await waitForPerfEvent(page, 'enter-mpr', 3_000), 'missing enter-mpr trace').toBeTruthy();
  await waitForCanvasPaint(page, '#mpr-ob');

  const duringPitch = await obliqueSliderAndSnapshot(page, '#ob-pitch', 42);
  expect(duringPitch.aspectDelta, JSON.stringify(duringPitch)).toBeLessThan(0.025);
  expect(duringPitch.physicalAspectDelta, JSON.stringify(duringPitch)).toBeLessThan(0.05);

  await expect.poll(() => mprQuality(page), {
    message: 'oblique pitch should settle back to a full-quality MPR redraw',
    timeout: 3_000,
  }).toBe('quality');
  const afterPitch = await obliqueSnapshot(page);
  expect(afterPitch.backing, JSON.stringify({ duringPitch, afterPitch })).toBe(duringPitch.backing);
  expect(afterPitch.display, JSON.stringify({ duringPitch, afterPitch })).toBe(duringPitch.display);
  expect(afterPitch.aspectDelta, JSON.stringify(afterPitch)).toBeLessThan(0.025);
  expect(afterPitch.physicalAspectDelta, JSON.stringify(afterPitch)).toBeLessThan(0.05);
});

test('MPR axis wheel stays off the slice scrub path and defers the oblique repaint', async ({ page }, testInfo) => {
  await openPerfVolumeFixture(page);
  await clearPerf(page);
  await page.locator('#btn-mpr').click();
  expect(await waitForPerfEvent(page, 'enter-mpr', 3_000), 'missing enter-mpr trace').toBeTruthy();
  await waitForCanvasPaint(page, '#mpr-ob');

  const obliqueBefore = await canvasChecksum(page, '#mpr-ob');
  const sliceBeforeAxisWheel = await page.locator('#slice-cur').textContent();
  const yBefore = await mprAxisIndex(page, '#mpr-co-idx');
  const xBefore = await mprAxisIndex(page, '#mpr-sa-idx');
  expect(yBefore).not.toBeNull();
  expect(xBefore).not.toBeNull();

  const obliqueImmediate = await wheelMprAxesAndSnapshotOblique(page, [
    { selector: '#mpr-co', deltaY: 140, steps: 8 },
    { selector: '#mpr-sa', deltaY: -140, steps: 6 },
  ]);
  expect(obliqueImmediate, 'axis wheel must not repaint the oblique pane on the interaction frame').toBe(obliqueBefore);

  await expect.poll(() => mprAxisIndex(page, '#mpr-co-idx'), {
    message: 'coronal MPR wheel should update the Y axis label on the next frame',
  }).not.toBe(yBefore);
  await expect.poll(() => mprAxisIndex(page, '#mpr-sa-idx'), {
    message: 'sagittal MPR wheel should update the X axis label on the next frame',
  }).not.toBe(xBefore);
  expect(await page.locator('#slice-cur').textContent()).toBe(sliceBeforeAxisWheel);

  await expect.poll(() => canvasChecksum(page, '#mpr-ob'), {
    message: 'oblique pane should repaint after the deferred settle',
  }).not.toBe(obliqueBefore);

  const mprScrubMs = [await scrubBurst(page, 40), await scrubBurst(page, 40)];
  const mprScrubAvgMs = average(mprScrubMs);
  expect(mprScrubAvgMs).not.toBeNull();
  expectWithinBudget('mprScrubAvgMs', mprScrubAvgMs);

  await testInfo.attach('viewer-mpr-performance-budget-report.json', {
    body: JSON.stringify(budgetReport({ mprScrubAvgMs }), null, 2),
    contentType: 'application/json',
  });
});

test('cloud delayed overlay upgrade keeps the trace pending until the overlay is ready', async ({ page }) => {
  await routePerfCloudFixture(page, { overlayDelayMs: 900 });
  await openPerfViewer(page, '/?perf=1&localBackend=0');

  await expect(page.locator('#series-list li')).toHaveCount(1, { timeout: 20_000 });
  await waitForCanvasPaint(page, '#view');
  await clearPerf(page);

  await expect(page.locator('#btn-sym')).toHaveCount(1);
  await page.locator('#btn-sym').evaluate((button) => button.click());
  await expect.poll(async () => pendingPerfCount(page, 'overlay-toggle-paint'), { timeout: 2_000 }).toBeGreaterThan(0);
  expect(await waitForPerfEvent(page, 'overlay-toggle-paint', 250)).toBeNull();

  const overlayEvent = await waitForPerfEvent(page, 'overlay-toggle-paint', 6_000);
  expect(overlayEvent, 'missing delayed overlay-toggle-paint trace').toBeTruthy();
  expect(overlayEvent.duration).toBeGreaterThanOrEqual(700);
});
