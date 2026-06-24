/* global Buffer, Event, URL, WheelEvent, document, fetch, getComputedStyle, performance, requestAnimationFrame */
import { expect, test } from '@playwright/test';
import { VIEWER_PERF_BUDGET } from '../fixtures/performance-budget.mjs';
import { localVolumeSeries, routeLocalVolumeStudy } from './local-volume-fixture.mjs';

test.setTimeout(90_000);

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6p2ioAAAAASUVORK5CYII=',
  'base64',
);

async function clearPerf(page) {
  await page.evaluate(() => globalThis.__voxellabPerf?.clear?.());
}

async function perfEvents(page, name) {
  return page.evaluate((traceName) => {
    const history = globalThis.__voxellabPerf?.history || [];
    return history.filter((entry) => entry.name === traceName);
  }, name);
}

async function waitForPerfEvent(page, name, timeout = 12_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const events = await perfEvents(page, name);
    if (events.length) return events[events.length - 1];
    await page.waitForTimeout(100);
  }
  return null;
}

async function pendingPerfCount(page, name) {
  return page.evaluate((traceName) => {
    const pending = globalThis.__voxellabPerf?.pending || [];
    return pending.find((entry) => entry.name === traceName)?.count || 0;
  }, name);
}

async function waitForCanvasPaint(page, selector) {
  for (let i = 0; i < 60; i += 1) {
    const painted = await page.locator(selector).evaluate((canvas) => {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx || canvas.width === 0 || canvas.height === 0) return false;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let p = 0; p < data.length; p += 4) {
        if (data[p] || data[p + 1] || data[p + 2]) return true;
      }
      return false;
    });
    if (painted) return;
    await page.waitForTimeout(100);
  }
}

async function scrubBurst(page, count = 48) {
  return page.evaluate(async ({ count: iterations }) => {
    const scrub = document.querySelector('#scrub');
    const max = Number(scrub?.max || 0);
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      scrub.value = String(i % Math.max(1, max + 1));
      scrub.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return performance.now() - start;
  }, { count });
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundMs(value) {
  return Number(value.toFixed(1));
}

function budgetReport(metrics) {
  // Shape: { selectSeries2dMs: { actualMs: 38.9, baselineMs: 38.9, maxMs: 500, deltaMs: 0 } }.
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

async function canvasChecksum(page, selector) {
  return page.locator(selector).evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx || canvas.width === 0 || canvas.height === 0) return 'blank';
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    const stride = Math.max(4, Math.floor(data.length / 4096));
    for (let index = 0; index < data.length; index += stride) {
      hash ^= data[index];
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return `${canvas.width}x${canvas.height}:${hash}`;
  });
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
      [state.mprX, state.mprY, state.mprZ],
      state.obYaw,
      state.obPitch,
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
      body: JSON.stringify({
        patient: 'anonymous',
        studyDate: '',
        series: [series],
      }),
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

async function routeFusionPeerFixture(page) {
  const series = [
    {
      slug: 'fusion_source',
      name: 'Fusion Source',
      modality: 'MR',
      group: 'fusion-fixture',
      slices: 2,
      width: 1,
      height: 1,
      pixelSpacing: [1, 1],
      sliceThickness: 1,
      firstIPP: [0, 0, 0],
      lastIPP: [0, 0, 1],
    },
    {
      slug: 'fusion_peer',
      name: 'Fusion Peer',
      modality: 'MR',
      group: 'fusion-fixture',
      slices: 2,
      width: 1,
      height: 1,
      pixelSpacing: [1, 1],
      sliceThickness: 1,
      firstIPP: [0, 0, 0],
      lastIPP: [0, 0, 1],
    },
  ];
  await page.route('**/data/manifest.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ patient: 'anonymous', studyDate: '', series }),
    });
  });
  for (const item of series) {
    await page.route(`**/data/${item.slug}/*.png`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG });
    });
  }
}

async function openPerfViewer(page, path = '/?perf=1') {
  const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
  expect(response && response.ok(), `root response status: ${response && response.status()}`).toBe(true);
  const manifest = await page.evaluate(() => fetch('/data/manifest.json').then(r => r.json()));
  return manifest;
}

async function openLocalVolumeFixture(page) {
  await routeLocalVolumeStudy(page, [
    localVolumeSeries('perf_volume', 'Performance Volume Fixture', {
      description: 'self-contained browser performance fixture',
      slices: 3,
    }),
  ]);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const manifest = await openPerfViewer(page, attempt ? `/?perf=1&testReload=${Date.now()}` : '/?perf=1');
    try {
      await selectLocalVolumeSeries(page, manifest);
      return manifest;
    } catch (error) {
      if (attempt) throw error;
    }
  }
  throw new Error('unreachable local volume fixture retry state');
}

async function selectLocalVolumeSeries(page, manifest) {
  const volumeSeriesIndex = Math.max(0, manifest.series.findIndex((series) =>
    !series?.sliceUrlBase
    && (series?.reconstructionCapability === 'display-volume' || series?.geometryKind === 'volumeStack')
  ));
  const volumeSeries = manifest.series[volumeSeriesIndex];
  await expect(page.locator('#series-list li')).toHaveCount(manifest.series.length, { timeout: 20_000 });
  const currentName = await page.locator('#series-name').textContent();
  if ((currentName || '').trim() !== volumeSeries.name) {
    await page.locator('#series-list li').nth(volumeSeriesIndex).click();
  }
  await waitForCanvasPaint(page, '#view');
  return { volumeSeries, volumeSeriesIndex };
}

test('viewer defers GPU MPR module until MPR opens', async ({ page }) => {
  const gpuRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/js/mpr/mpr-gpu.js')) gpuRequests.push(request.url());
  });

  await openLocalVolumeFixture(page);
  await page.waitForTimeout(250);
  expect(gpuRequests).toEqual([]);

  await page.locator('#btn-mpr').click();
  await expect.poll(() => gpuRequests.length, { timeout: 3_000 }).toBeGreaterThan(0);
});

test('viewer defers SlimSAM integration until the menu opens', async ({ page }) => {
  const slimsamRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/js/overlay/slimsam.js')) slimsamRequests.push(request.url());
  });

  const series = localVolumeSeries('perf_volume', 'Performance Volume Fixture', {
    description: 'self-contained browser performance fixture',
    slices: 3,
  });
  await routeLocalVolumeStudy(page, [series]);
  await page.route('**/api/cloud-settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        source: 'local-env',
        storagePath: '/tmp/voxellab/.env',
        modalWebhookBase: '',
        r2PublicUrl: '',
        trustedUploadOrigins: [],
        cloudProcessing: true,
        hasModalAuthToken: false,
        configured: false,
      }),
    });
  });
  const response = await page.goto('/?perf=1', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok(), `root response status: ${response && response.status()}`).toBe(true);
  await expect(page.locator('#btn-slimsam')).toBeVisible();
  await page.evaluate(async (fixtureSeries) => {
    const { state } = await import('/js/core/state.js');
    state.manifest = { patient: 'anonymous', studyDate: '', series: [fixtureSeries] };
    state.seriesIdx = 0;
    state.mode = '2d';
  }, series);
  await page.waitForTimeout(250);
  expect(slimsamRequests).toEqual([]);

  await page.locator('#btn-slimsam').click();
  await expect(page.locator('#slimsam-menu')).toBeVisible();
  await expect(page.locator('#slimsam-title')).toHaveText('Segmentation');
  await expect(page.locator('#segmentation-engine-list')).toContainText('SlimSAM');
  await expect(page.locator('#slimsam-state-pill')).not.toHaveText('Blocked');
  await expect(page.locator('#slimsam-status')).toContainText('SlimSAM click masks do not need a Modal key');
  await expect(page.locator('#slimsam-command-code')).toContainText('python3 python/slimsam_embed.py');
  await expect(page.locator('label.slimsam-toggle.ui-checkbox #slimsam-smooth.ui-checkbox-input')).toBeChecked();
  await expect(page.locator('label.slimsam-toggle .ui-checkbox-box')).toBeVisible();
  await page.locator('#segmentation-cloud-settings').click();
  await expect(page.locator('#cloud-settings-modal')).toBeVisible();
  await expect(page.locator('#cloud-settings-status')).toContainText('Enter Modal webhook base');
  await expect.poll(() => slimsamRequests.length, { timeout: 3_000 }).toBeGreaterThan(0);
});

test('viewer defers upload workflow module until upload opens', async ({ page }) => {
  const uploadRequests = [];
  const dicomDerivedRequests = [];
  const dicomImportRequests = [];
  const dicomwebImportRequests = [];
  const dicomwebRequests = [];
  const microscopyImportRequests = [];
  const microscopyWorkflowRecipeRequests = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith('/js/projects/study-upload-modal.js')) uploadRequests.push(request.url());
    if (pathname.endsWith('/js/dicom/dicom-derived-import.js')) dicomDerivedRequests.push(request.url());
    if (pathname.endsWith('/js/dicom/dicom-import.js')) dicomImportRequests.push(request.url());
    if (pathname.endsWith('/js/dicom/dicomweb-import.js')) dicomwebImportRequests.push(request.url());
    if (pathname.endsWith('/js/dicom/dicomweb/dicomweb-source.js')) dicomwebRequests.push(request.url());
    if (pathname.endsWith('/js/microscopy/microscopy-import.js')) microscopyImportRequests.push(request.url());
    if (pathname.endsWith('/js/microscopy/microscopy-workflow-recipe.js')) microscopyWorkflowRecipeRequests.push(request.url());
  });

  await openLocalVolumeFixture(page);
  await page.waitForTimeout(250);
  expect(uploadRequests).toEqual([]);
  expect(dicomImportRequests).toEqual([]);
  expect(dicomwebImportRequests).toEqual([]);
  expect(dicomwebRequests).toEqual([]);
  expect(microscopyImportRequests).toEqual([]);
  expect(microscopyWorkflowRecipeRequests).toEqual([]);

  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toHaveClass(/visible/);
  await expect.poll(() => uploadRequests.length, { timeout: 3_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(250);
  expect(dicomDerivedRequests).toEqual([]);
  expect(dicomImportRequests).toEqual([]);
  expect(dicomwebImportRequests).toEqual([]);
  expect(dicomwebRequests).toEqual([]);
  expect(microscopyImportRequests).toEqual([]);
  expect(microscopyWorkflowRecipeRequests).toEqual([]);
});

test('viewer defers DICOM SR exporter until export is requested', async ({ page }) => {
  const srRequests = [];
  const legacyScriptRequests = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith('/js/dicom/dicom-sr.js')) srRequests.push(request.url());
    if (pathname.endsWith('/dcmjs.js') || pathname.endsWith('/dcmjs.min.js')) legacyScriptRequests.push(request.url());
  });

  await openLocalVolumeFixture(page);
  await page.waitForTimeout(250);
  expect(srRequests).toEqual([]);
  expect(legacyScriptRequests).toEqual([]);

  await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const { setRoiEntriesForSlice } = await import('/js/overlay/annotation-graph.js');
    const { renderRoiResults } = await import('/js/roi/roi-results.js');
    const series = state.manifest.series[state.seriesIdx];
    const sliceIdx = state.sliceIdx || 0;
    setRoiEntriesForSlice(series.slug, sliceIdx, [{
      id: 1,
      shape: 'polygon',
      label: 'sr-export-check',
      pts: [[1, 1], [12, 1], [12, 12], [1, 12]],
      stats: { area_mm2: 121, mean: 42, std: 3 },
      createdAt: Date.now(),
    }]);
    renderRoiResults(state);
  });
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#btn-sr').click();
  await downloadPromise;
  await expect(page.locator('#confirm-modal')).toHaveClass(/visible/);
  await expect(page.locator('#confirm-modal')).toContainText('DICOM SR exported');
  await expect.poll(() => srRequests.length, { timeout: 3_000 }).toBeGreaterThan(0);
  expect(legacyScriptRequests).toEqual([]);
});

test('viewer defers Ask/Consult API module until an AI action opens', async ({ page }) => {
  const consultRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/js/consult-ask.js')) consultRequests.push(request.url());
  });

  await openLocalVolumeFixture(page);
  await page.waitForTimeout(250);
  expect(consultRequests).toEqual([]);

  const consultButton = page.locator('#btn-consult');
  test.skip(await consultButton.evaluate((button) => button.classList.contains('hidden')), 'Local AI actions are disabled.');
  await consultButton.click();
  await expect(page.locator('#consult-modal')).toHaveClass(/visible/);
  await expect.poll(() => consultRequests.length, { timeout: 3_000 }).toBeGreaterThan(0);
});

test('viewer defers Electron path-backed file adapter outside native path opens', async ({ page }) => {
  await routeFusionPeerFixture(page);
  const desktopPathRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/js/desktop-path-file.js')) desktopPathRequests.push(request.url());
  });

  const manifest = await openPerfViewer(page);
  await expect(page.locator('#series-list li')).toHaveCount(manifest.series.length, { timeout: 20_000 });
  await waitForCanvasPaint(page, '#view');
  await page.waitForTimeout(250);
  expect(desktopPathRequests).toEqual([]);
});

test('viewer defers Electron window chrome module outside desktop runtime', async ({ page }) => {
  await routeFusionPeerFixture(page);
  const desktopChromeRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/js/shell/desktop-window-chrome.js')) desktopChromeRequests.push(request.url());
  });

  const manifest = await openPerfViewer(page);
  await expect(page.locator('#series-list li')).toHaveCount(manifest.series.length, { timeout: 20_000 });
  await waitForCanvasPaint(page, '#view');
  await page.waitForTimeout(250);
  expect(desktopChromeRequests).toEqual([]);
});

test('viewer defers fusion peer loader until a fusion peer is selected', async ({ page }) => {
  await routeFusionPeerFixture(page);
  const fusionLoaderRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/js/fusion-loader.js')) fusionLoaderRequests.push(request.url());
  });

  const manifest = await openPerfViewer(page);
  await expect(page.locator('#series-list li')).toHaveCount(manifest.series.length, { timeout: 20_000 });
  await expect(page.locator('#fusion-select option[value="fusion_peer"]')).toHaveCount(1);
  await waitForCanvasPaint(page, '#view');
  await page.waitForTimeout(250);
  expect(fusionLoaderRequests).toEqual([]);

  await page.locator('#fusion-select').selectOption('fusion_peer');
  await expect.poll(() => fusionLoaderRequests.length, { timeout: 3_000 }).toBeGreaterThan(0);
});

test('viewer defers screenshot exporter until export is requested', async ({ page }) => {
  const screenshotRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/js/screenshot.js')) screenshotRequests.push(request.url());
  });

  await openLocalVolumeFixture(page);
  await page.waitForTimeout(250);
  expect(screenshotRequests).toEqual([]);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#btn-shot').click();
  await downloadPromise;
  await expect.poll(() => screenshotRequests.length, { timeout: 3_000 }).toBeGreaterThan(0);
});

test('viewer defers ImageJ ROI codec until ROI ZIP export is requested', async ({ page }) => {
  const imagejRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/js/microscopy/imagej-roi.js')) imagejRequests.push(request.url());
  });

  await openLocalVolumeFixture(page);
  await page.waitForTimeout(250);
  expect(imagejRequests).toEqual([]);

  await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const { setRoiEntriesForSlice } = await import('/js/overlay/annotation-graph.js');
    const { renderRoiResults } = await import('/js/roi/roi-results.js');
    const series = state.manifest.series[state.seriesIdx];
    const sliceIdx = state.sliceIdx || 0;
    setRoiEntriesForSlice(series.slug, sliceIdx, [{
      id: 1,
      shape: 'polygon',
      label: 'startup-check',
      pts: [[1, 1], [12, 1], [12, 12], [1, 12]],
      stats: { pixels: 121, count: 121 },
      createdAt: Date.now(),
    }]);
    renderRoiResults(state);
  });

  await expect(page.locator('#roi-results-imagej-export')).toBeEnabled();
  await page.locator('#roi-results-imagej-export').evaluate((button) => button.click());
  await expect.poll(() => imagejRequests.length, { timeout: 3_000 }).toBeGreaterThan(0);
});

test('viewer defers shortcut customizer until requested', async ({ page }) => {
  const shortcutRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/js/shortcuts-modal.js')) shortcutRequests.push(request.url());
  });

  await openLocalVolumeFixture(page);
  await page.waitForTimeout(250);
  expect(shortcutRequests).toEqual([]);

  await page.locator('#btn-cmdk-open').click();
  await page.locator('#cmdk-input').fill('shortcuts');
  await page.getByRole('button', { name: /Customize shortcuts/ }).click();
  await expect(page.locator('#shortcuts-modal')).toHaveClass(/visible/);
  await expect.poll(() => shortcutRequests.length, { timeout: 3_000 }).toBeGreaterThan(0);
});

test('viewer defers DICOM-derived hydration when no persisted objects exist', async ({ page }) => {
  const derivedRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/js/dicom/dicom-derived-import.js')) derivedRequests.push(request.url());
  });

  await openLocalVolumeFixture(page);
  await page.waitForTimeout(250);
  expect(derivedRequests).toEqual([]);
});

test('viewer defers the full plugin API outside plugin registration', async ({ page }) => {
  const pluginRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/js/plugin.js')) pluginRequests.push(request.url());
  });

  await openLocalVolumeFixture(page);
  await page.waitForTimeout(250);
  expect(pluginRequests).toEqual([]);
});

test('viewer defers microscopy controls, analysis, and recipe modules outside microscopy workflows', async ({ page }) => {
  const microscopyWorkflowRequests = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      pathname.endsWith('/js/microscopy/microscopy-hyperstack-controls.js')
      || pathname.endsWith('/js/microscopy/microscopy-analysis.js')
      || pathname.endsWith('/js/microscopy/microscopy-analysis-panel.js')
      || pathname.endsWith('/js/microscopy/microscopy-workflow-recipe.js')
    ) {
      microscopyWorkflowRequests.push(request.url());
    }
  });

  await openLocalVolumeFixture(page);
  await page.waitForTimeout(250);
  expect(microscopyWorkflowRequests).toEqual([]);
});

test('viewer defers the Three.js renderer stack until 3D opens', async ({ page }) => {
  const threeRequests = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      pathname.endsWith('/js/volume/vendor-three.js')
      || pathname.endsWith('/js/volume/vendor-trackball-controls.js')
      || pathname.endsWith('/js/volume/volume-three-bootstrap.js')
      || pathname.endsWith('/js/volume/volume-raycast-material.js')
    ) {
      threeRequests.push(pathname);
    }
  });

  await openLocalVolumeFixture(page);
  await page.waitForTimeout(250);
  expect(threeRequests).toEqual([]);

  await page.locator('#btn-3d').click();
  await expect(page.locator('#three-container.active canvas')).toBeVisible();
  await expect.poll(() => threeRequests.length, { timeout: 4_000 }).toBeGreaterThan(0);
});

test('viewer runtime paths keep emitting performance milestones', async ({ page }, testInfo) => {
  const manifest = await openLocalVolumeFixture(page);
  const volumeSeriesIndex = 0;
  const volumeSeries = manifest.series[volumeSeriesIndex];

  const results = {
    selectSeries2dMs: null,
    scrub2dMs: [],
    overlayScrubMs: [],
    compareScrubMs: [],
    enter3dMs: null,
  };

  const selectSeriesEvent = await waitForPerfEvent(page, 'select-series-2d');
  expect(selectSeriesEvent, 'missing select-series-2d trace').toBeTruthy();
  results.selectSeries2dMs = selectSeriesEvent.duration;
  expectWithinBudget('selectSeries2dMs', selectSeriesEvent.duration);

  await clearPerf(page);
  results.scrub2dMs.push(await scrubBurst(page));
  results.scrub2dMs.push(await scrubBurst(page));
  const scrub2dAvgMs = average(results.scrub2dMs);
  expect(scrub2dAvgMs).not.toBeNull();
  expectWithinBudget('scrub2dAvgMs', scrub2dAvgMs);

  const hasSym = !!volumeSeries.hasSym;
  const hasRegions = !!volumeSeries.hasRegions;
  if (hasSym) await page.locator('#btn-sym').click();
  if (hasRegions) await page.locator('#btn-regions').click();
  if (hasSym || hasRegions) {
    const overlayEvent = await waitForPerfEvent(page, 'overlay-toggle-paint');
    expect(overlayEvent, 'missing overlay-toggle-paint trace').toBeTruthy();
    results.overlayScrubMs.push(await scrubBurst(page, 32));
    results.overlayScrubMs.push(await scrubBurst(page, 32));
    const overlayScrubAvgMs = average(results.overlayScrubMs);
    expect(overlayScrubAvgMs).not.toBeNull();
    expectWithinBudget('overlayScrubAvgMs', overlayScrubAvgMs);
  }

  const groupCounts = manifest.series.reduce((map, series) => {
    const key = series.compareGroup ?? series.group ?? null;
    if (key == null) return map;
    map.set(key, (map.get(key) || 0) + 1);
    return map;
  }, new Map());
  const compareGroup = [...groupCounts.entries()].find(([key, count]) => {
    if (count < 2) return false;
    const peers = manifest.series.filter((series) => (series.compareGroup ?? series.group ?? null) === key);
    return peers.every((series) => !series.sliceUrlBase);
  })?.[0];
  if (compareGroup != null) {
    const compareIndex = manifest.series.findIndex((series) => (series.compareGroup ?? series.group ?? null) === compareGroup);
    if (compareIndex >= 0 && compareIndex !== volumeSeriesIndex) {
      await page.locator('#series-list li').nth(compareIndex).click();
      await waitForCanvasPaint(page, '#view');
    }
    await page.locator('#btn-compare').click();
    await page.waitForTimeout(250);
    results.compareScrubMs.push(await scrubBurst(page, 24));
    results.compareScrubMs.push(await scrubBurst(page, 24));
    const compareScrubAvgMs = average(results.compareScrubMs);
    expect(compareScrubAvgMs).not.toBeNull();
    expectWithinBudget('compareScrubAvgMs', compareScrubAvgMs);
    await page.locator('#btn-compare').click();
  }

  await clearPerf(page);
  await page.locator('#btn-3d').click();
  await expect(page.locator('#three-container.active canvas')).toBeVisible();
  const threeEvent = await waitForPerfEvent(page, 'enter-3d', 4_000);
  expect(threeEvent, 'missing enter-3d trace').toBeTruthy();
  results.enter3dMs = threeEvent.duration;
  expectWithinBudget('enter3dMs', threeEvent.duration);
  await page.locator('#btn-3d').click();

  const summary = {
    selectSeries2dMs: results.selectSeries2dMs,
    scrub2dAvgMs,
    enter3dMs: results.enter3dMs,
  };
  if (results.overlayScrubMs.length) summary.overlayScrubAvgMs = average(results.overlayScrubMs);
  if (results.compareScrubMs.length) summary.compareScrubAvgMs = average(results.compareScrubMs);

  await testInfo.attach('viewer-performance.json', {
    body: JSON.stringify(results, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('viewer-performance-budget-report.json', {
    body: JSON.stringify(budgetReport(summary), null, 2),
    contentType: 'application/json',
  });
});

test('MPR axis interaction stays off the slice scrub path and defers oblique paint', async ({ page }, testInfo) => {
  await openLocalVolumeFixture(page);

  await clearPerf(page);
  await page.locator('#btn-mpr').click();
  const mprEvent = await waitForPerfEvent(page, 'enter-mpr', 3_000);
  expect(mprEvent, 'missing enter-mpr trace').toBeTruthy();
  expectWithinBudget('enterMprMs', mprEvent.duration);
  await waitForCanvasPaint(page, '#mpr-ob');

  const obliqueBeforeZScrub = await obliqueSnapshot(page);
  const obliqueDuringZScrub = await zScrubAndSnapshotOblique(page);
  const stableObliqueLayout = ({ backing, display, aspectDelta, physicalAspectDelta }) => ({
    backing,
    display,
    aspectDelta,
    physicalAspectDelta,
  });
  expect(
    stableObliqueLayout(obliqueDuringZScrub),
    JSON.stringify({ obliqueBeforeZScrub, obliqueDuringZScrub }),
  ).toEqual(stableObliqueLayout(obliqueBeforeZScrub));
  const settleEvent = await waitForPerfEvent(page, 'mpr-quality-settle', 3_000);
  expect(settleEvent, 'Z scrub should settle through a full-quality MPR redraw').not.toBeNull();
  const obliqueAfterZScrub = await obliqueSnapshot(page);
  expect(obliqueAfterZScrub.backing, JSON.stringify(obliqueAfterZScrub)).toBe(obliqueBeforeZScrub.backing);
  expect(obliqueAfterZScrub.display, JSON.stringify(obliqueAfterZScrub)).toBe(obliqueBeforeZScrub.display);
  expect(obliqueAfterZScrub.aspectDelta, JSON.stringify(obliqueAfterZScrub)).toBeLessThan(0.025);
  expect(obliqueAfterZScrub.physicalAspectDelta, JSON.stringify(obliqueAfterZScrub)).toBeLessThan(0.05);

  const mprCellSizing = await page.locator('#mpr-ob').evaluate((canvas) => {
    const cell = canvas.closest('.mpr-cell');
    const style = getComputedStyle(cell);
    return { minWidth: style.minWidth, minHeight: style.minHeight };
  });
  expect(mprCellSizing).toEqual({ minWidth: '0px', minHeight: '0px' });
  const obliqueDuringPitch = await obliqueSliderAndSnapshot(page, '#ob-pitch', 42);
  expect(obliqueDuringPitch.aspectDelta, JSON.stringify(obliqueDuringPitch)).toBeLessThan(0.025);
  expect(obliqueDuringPitch.physicalAspectDelta, JSON.stringify(obliqueDuringPitch)).toBeLessThan(0.05);
  await page.waitForTimeout(260);
  const obliqueAfterPitch = await obliqueSnapshot(page);
  expect(obliqueAfterPitch.backing, JSON.stringify({ obliqueDuringPitch, obliqueAfterPitch }))
    .toBe(obliqueDuringPitch.backing);
  expect(obliqueAfterPitch.display, JSON.stringify({ obliqueDuringPitch, obliqueAfterPitch }))
    .toBe(obliqueDuringPitch.display);
  expect(obliqueAfterPitch.aspectDelta, JSON.stringify(obliqueAfterPitch)).toBeLessThan(0.025);
  expect(obliqueAfterPitch.physicalAspectDelta, JSON.stringify(obliqueAfterPitch)).toBeLessThan(0.05);

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
  await expect.poll(() => mprAxisIndex(page, '#mpr-co-idx'), {
    message: 'coronal MPR wheel should update the Y axis label on the next frame',
  }).not.toBe(yBefore);
  await expect.poll(() => mprAxisIndex(page, '#mpr-sa-idx'), {
    message: 'sagittal MPR wheel should update the X axis label on the next frame',
  }).not.toBe(xBefore);

  const yAfter = await mprAxisIndex(page, '#mpr-co-idx');
  const xAfter = await mprAxisIndex(page, '#mpr-sa-idx');
  const sliceAfterAxisWheel = await page.locator('#slice-cur').textContent();

  expect(yAfter).not.toBe(yBefore);
  expect(xAfter).not.toBe(xBefore);
  expect(sliceAfterAxisWheel).toBe(sliceBeforeAxisWheel);
  expect(obliqueImmediate).toBe(obliqueBefore);

  await page.waitForTimeout(260);
  const obliqueDeferred = await canvasChecksum(page, '#mpr-ob');
  expect(obliqueDeferred).not.toBe(obliqueBefore);

  const mprScrubMs = [await scrubBurst(page, 40), await scrubBurst(page, 40)];
  const mprScrubAvgMs = average(mprScrubMs);
  expect(mprScrubAvgMs).not.toBeNull();
  expectWithinBudget('mprScrubAvgMs', mprScrubAvgMs);

  await testInfo.attach('viewer-mpr-performance.json', {
    body: JSON.stringify({
      enterMprMs: mprEvent.duration,
      mprScrubMs,
    }, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('viewer-mpr-performance-budget-report.json', {
    body: JSON.stringify(budgetReport({
      enterMprMs: mprEvent.duration,
      mprScrubAvgMs,
    }), null, 2),
    contentType: 'application/json',
  });
});

test('cloud delayed overlay upgrade keeps trace pending until overlay is actually ready', async ({ page }) => {
  await routePerfCloudFixture(page, { overlayDelayMs: 900 });
  await openPerfViewer(page, '/?perf=1&localBackend=0');

  await expect(page.locator('#series-list li')).toHaveCount(1, { timeout: 20_000 });
  await waitForCanvasPaint(page, '#view');
  await clearPerf(page);

  await expect(page.locator('#btn-sym')).toHaveCount(1);
  await page.locator('#btn-sym').evaluate((button) => button.click());
  await expect.poll(async () => pendingPerfCount(page, 'overlay-toggle-paint'), { timeout: 2_000 }).toBeGreaterThan(0);
  const earlyOverlayEvent = await waitForPerfEvent(page, 'overlay-toggle-paint', 250);
  expect(earlyOverlayEvent).toBeNull();

  const overlayEvent = await waitForPerfEvent(page, 'overlay-toggle-paint', 6_000);
  expect(overlayEvent, 'missing delayed overlay-toggle-paint trace').toBeTruthy();
  expect(overlayEvent.duration).toBeGreaterThanOrEqual(700);
});
