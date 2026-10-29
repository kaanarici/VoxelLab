import { readFile } from 'node:fs/promises';
import { expect, test as base } from '@playwright/test';
import {
  expectUndistortedCanvas,
  renderThreeNow,
  waitForCanvasPaint,
  waitForMprVolumeReady,
  waitForWebGlCanvasPaint,
} from '../helpers/browser/canvas.mjs';
import { ensurePanelOpen } from '../helpers/browser/panels.mjs';
import {
  fetchStudyManifest,
  localVolumeSeries,
  openLocalStudy,
  primaryVolumeIndex,
} from '../helpers/browser/local-study.mjs';

const IGNORED_CONSOLE_ERRORS = [
  /favicon\.ico.*404/,
  /_asks\.json.*404/,
  /_analysis\.json.*404/,
  /^Failed to load resource: the server responded with a status of 404 \(File not found\)$/,
];

const test = base.extend({
  seriousErrors: async ({ page }, use) => {
    const errors = [];
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (IGNORED_CONSOLE_ERRORS.some((pattern) => pattern.test(text))) return;
      errors.push(`console.error: ${text}`);
    });
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    await use(errors);
  },
});

function expectNoSeriousErrors(seriousErrors) {
  expect(seriousErrors, `serious browser errors:\n${seriousErrors.join('\n')}`).toEqual([]);
}

async function mprQuality(page) {
  return page.evaluate(async () => (await import('/js/core/state.js')).state.mpr.quality);
}

async function obliqueYaw(page) {
  return page.evaluate(async () => (await import('/js/core/state.js')).state.mpr.obYaw);
}

async function openSmokeStudy(page) {
  await openLocalStudy(page, [
    localVolumeSeries('smoke_volume', 'Smoke Volume', { width: 64, height: 64, slices: 24 }),
  ]);
  const manifest = await fetchStudyManifest(page);
  const primaryIndex = primaryVolumeIndex(manifest);
  const primarySeries = manifest.series[primaryIndex];
  await expect(page.locator('#series-list li').nth(primaryIndex)).toBeVisible();
  await page.locator('#series-list li').nth(primaryIndex).click();
  await expect(page.locator('#series-name')).toHaveText(primarySeries.name);
  return primarySeries;
}

async function openSmokeMpr(page) {
  const primarySeries = await openSmokeStudy(page);
  await waitForCanvasPaint(page, '#view');
  await page.locator('#btn-mpr').click();
  await expect(page.locator('#mpr-ax')).toBeVisible();
  await expect(page.locator('#mpr-ob')).toBeVisible();
  await waitForMprVolumeReady(page);
  await waitForCanvasPaint(page, '#mpr-ax');
  return primarySeries;
}

async function scrubBurst(page, iterations) {
  await page.locator('#scrub').evaluate(async (scrub, count) => {
    const max = Number(scrub.max || 0);
    for (let i = 0; i < count; i += 1) {
      scrub.value = String(i % (max + 1));
      scrub.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, iterations);
}

test.describe('local-first volume fixture', () => {
  test('loads into 2D with calibrated series metadata and keyboard slice navigation', async ({ page, seriousErrors }) => {
    const primarySeries = await openSmokeStudy(page);

    await expect(page.locator('#slice-cur')).toHaveText('1');
    await expect(page.locator('#slice-tot')).toHaveText(String(primarySeries.slices));
    await expect(page.locator('#canvas-wrap')).toBeVisible();
    await expect(page.locator('#meta .meta-row').filter({ hasText: 'Cloud result' })).toHaveCount(0);

    const stats = await waitForCanvasPaint(page, '#view');
    expect(stats.width, `main canvas width: ${JSON.stringify(stats)}`).toBe(primarySeries.width);
    expect(stats.height, `main canvas height: ${JSON.stringify(stats)}`).toBe(primarySeries.height);

    const scrub = page.locator('#scrub');
    await expect(scrub).toHaveAttribute('max', String(primarySeries.slices - 1));
    await scrub.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#slice-cur')).toHaveText('2');
    await page.keyboard.press('End');
    await expect(page.locator('#slice-cur')).toHaveText(String(primarySeries.slices));
    await page.keyboard.press('Home');
    await expect(page.locator('#slice-cur')).toHaveText('1');
    expectNoSeriousErrors(seriousErrors);
  });

  test('MPR panes stay painted and undistorted through a scrub burst and settle redraw', async ({ page, seriousErrors }) => {
    await openSmokeMpr(page);
    await expect(page.locator('#mpr-gpu-toggle')).toBeVisible();

    await scrubBurst(page, 90);

    const axial = await waitForCanvasPaint(page, '#mpr-ax');
    const coronal = await waitForCanvasPaint(page, '#mpr-co');
    const sagittal = await waitForCanvasPaint(page, '#mpr-sa');
    expectUndistortedCanvas(axial, 'axial MPR');
    expectUndistortedCanvas(coronal, 'coronal MPR');
    expectUndistortedCanvas(sagittal, 'sagittal MPR');

    const expectedHeights = await page.evaluate(async () => {
      const { state } = await import('/js/core/state.js');
      const series = state.manifest.series[state.seriesIdx];
      const [fx, fy, fz] = series.firstIPP;
      const [lx, ly, lz] = series.lastIPP;
      const span = Math.hypot(lx - fx, ly - fy, lz - fz);
      const zSpacing = span / Math.max(1, series.slices - 1);
      const planeHeight = (spacing) => Math.max(16, Math.min(2048, Math.round(1 + (series.slices - 1) * zSpacing / spacing)));
      return {
        coronalHeight: document.querySelector('#mpr-co').height,
        expectedCoronalHeight: planeHeight(series.pixelSpacing[1]),
        sagittalHeight: document.querySelector('#mpr-sa').height,
        expectedSagittalHeight: planeHeight(series.pixelSpacing[0]),
      };
    });
    expect(expectedHeights.coronalHeight).toBe(expectedHeights.expectedCoronalHeight);
    expect(expectedHeights.sagittalHeight).toBe(expectedHeights.expectedSagittalHeight);

    await expect.poll(() => mprQuality(page), {
      message: 'scrub burst should settle back to a full-quality MPR redraw',
    }).toBe('quality');
    const settledCoronal = await waitForCanvasPaint(page, '#mpr-co');
    const settledSagittal = await waitForCanvasPaint(page, '#mpr-sa');
    expectUndistortedCanvas(settledCoronal, 'settled coronal MPR');
    expectUndistortedCanvas(settledSagittal, 'settled sagittal MPR');
    expectUndistortedCanvas(await waitForCanvasPaint(page, '#mpr-ob'), 'oblique MPR');
    expectNoSeriousErrors(seriousErrors);
  });

  test('exact oblique angle fields and the MIP projection repaint the oblique pane', async ({ page, seriousErrors }, testInfo) => {
    await openSmokeMpr(page);
    await waitForCanvasPaint(page, '#mpr-ob');
    const obliqueBeforeAngles = await page.locator('#mpr-ob').screenshot();

    await page.locator('#ob-yaw-val').fill('');
    await expect(page.locator('#ob-yaw-val')).toHaveValue('');
    expect(await obliqueYaw(page)).toBe(0);
    await page.locator('#ob-yaw-val').fill('-45');
    await expect(page.locator('#ob-yaw-val')).toHaveValue('-45');
    expect(await obliqueYaw(page)).toBe(-45);

    await page.locator('#ob-yaw').fill('45');
    await page.locator('#ob-pitch').fill('36.3');
    await expect(page.locator('#ob-yaw-val')).toHaveValue('45');
    await expect(page.locator('#ob-pitch-val')).toHaveValue('36.3');

    expect(await page.locator('#mpr-toolbar').evaluate((toolbar) => ({
      flexWrap: getComputedStyle(toolbar).flexWrap,
      overflowX: getComputedStyle(toolbar).overflowX,
      exactFieldAppearance: getComputedStyle(document.querySelector('#ob-yaw-val')).appearance,
      hasHorizontalOverflow: toolbar.scrollWidth > toolbar.clientWidth,
    }))).toEqual({
      flexWrap: 'nowrap',
      overflowX: 'auto',
      exactFieldAppearance: 'textfield',
      hasHorizontalOverflow: true,
    });

    await page.locator('.mpr-proj-btn[data-proj="mip"]').click();
    await expect(page.locator('.mpr-proj-btn[data-proj="mip"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.mpr-proj-btn[data-proj="thin"]')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => mprQuality(page)).toBe('quality');

    const arbitraryObliqueStats = await waitForCanvasPaint(page, '#mpr-ob');
    expectUndistortedCanvas(arbitraryObliqueStats, '45° / 36.3° oblique MPR');
    expect(await page.locator('#mpr-ob').screenshot()).not.toEqual(obliqueBeforeAngles);

    await page.locator('#mpr-gpu-toggle').check();
    await expect(page.locator('#mpr-gpu-note')).toHaveText(/GPU|N\/A/);
    await waitForCanvasPaint(page, '#mpr-ob');

    await testInfo.attach('mpr-exact-oblique-controls', {
      body: await page.locator('#mpr-toolbar').screenshot(),
      contentType: 'image/png',
    });
    expectNoSeriousErrors(seriousErrors);
  });

  test('3D volume renders and an arbitrary clip plane changes the rendered image', async ({ page, seriousErrors }, testInfo) => {
    await openSmokeStudy(page);
    await waitForCanvasPaint(page, '#view');

    await page.locator('#btn-3d').click();
    const threeCanvas = page.locator('#three-container.active canvas');
    await expect(threeCanvas).toBeVisible();
    await expect.poll(() => page.evaluate(async () => (
      Boolean((await import('/js/core/state.js')).state.threeRuntime.mesh)
    ))).toBe(true);
    await waitForWebGlCanvasPaint(page, '#three-container.active canvas');

    await ensurePanelOpen(page, '#panel-3d');
    const clippingDetails = page.locator('#panel-3d .rp-more');
    if (!(await clippingDetails.evaluate(details => details.open))) {
      await clippingDetails.locator('.rp-more-summary').click();
    }
    await expect(page.locator('#s-clip-plane-enabled')).toBeVisible();

    await renderThreeNow(page);
    const unclippedVolume = (await threeCanvas.screenshot()).toString('base64');

    await page.locator('#s-clip-plane-enabled').check();
    await page.locator('#s-clip-plane-yaw').fill('45');
    await page.locator('#s-clip-plane-pitch').fill('36.3');
    await page.locator('#s-clip-plane-depth').fill('0.37');
    await expect(page.locator('#readout-clip-plane-depth')).toHaveText('37%');
    await expect.poll(() => page.evaluate(async () => {
      const { state } = await import('/js/core/state.js');
      return {
        enabled: state.three.clipPlaneEnabled,
        yaw: state.mpr.obYaw,
        pitch: state.mpr.obPitch,
        depth: state.three.clipPlaneDepth,
      };
    })).toEqual({ enabled: true, yaw: 45, pitch: 36.3, depth: 0.37 });

    const renderedVolume = async () => {
      await renderThreeNow(page);
      return (await threeCanvas.screenshot()).toString('base64');
    };
    await expect.poll(renderedVolume, {
      message: 'enabling the clip plane should change the rendered volume',
    }).not.toBe(unclippedVolume);
    const clippedVolume = await renderedVolume();

    await page.locator('#s-clip-plane-invert').check();
    await expect.poll(renderedVolume, {
      message: 'inverting the clip plane should change the rendered volume again',
    }).not.toBe(clippedVolume);
    expect(await renderedVolume()).not.toBe(unclippedVolume);

    await testInfo.attach('3d-arbitrary-clip-plane-controls', {
      body: await page.locator('#panel-3d').screenshot(),
      contentType: 'image/png',
    });
    await expect(page.locator('#viewer-spinner')).toBeHidden();
    expectNoSeriousErrors(seriousErrors);
  });
});

test('study switches default unseen volumes to 2D and restores remembered 3D state', async ({ page, seriousErrors }) => {
  const fixtureSeries = await openLocalStudy(page, [
    localVolumeSeries('memory_volume_a', 'Memory Volume A'),
    localVolumeSeries('memory_volume_b', 'Memory Volume B'),
  ]);
  const manifest = await fetchStudyManifest(page);
  expect(manifest.series.map((series) => series.slug)).toEqual(fixtureSeries.map((series) => series.slug));

  await page.locator('#series-list li').nth(0).click();
  await expect(page.locator('#series-name')).toHaveText(manifest.series[0].name);
  await waitForCanvasPaint(page, '#view');
  await page.locator('#btn-3d').click();
  await expect(page.locator('#canvas-wrap')).toHaveClass(/threeD/);
  await expect(page.locator('#three-container.active canvas')).toBeVisible({ timeout: 30_000 });
  await page.locator('#scrub').evaluate((scrub) => {
    scrub.value = '12';
    scrub.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#slice-cur')).toHaveText('13');

  await page.locator('#series-list li').nth(1).click();
  await expect(page.locator('#series-name')).toHaveText(manifest.series[1].name);
  await expect(page.locator('#canvas-wrap')).not.toHaveClass(/threeD|mpr|mpr3d/);
  await expect(page.locator('#btn-3d')).not.toHaveClass(/active/);
  await expect(page.locator('#slice-cur')).toHaveText('1');
  await waitForCanvasPaint(page, '#view');

  await page.locator('#series-list li').nth(0).click();
  await expect(page.locator('#series-name')).toHaveText(manifest.series[0].name);
  await expect(page.locator('#canvas-wrap')).toHaveClass(/threeD/);
  await expect(page.locator('#btn-3d')).toHaveClass(/active/);
  await expect(page.locator('#slice-cur')).toHaveText('13');
  await expect(page.locator('#three-container.active canvas')).toBeVisible({ timeout: 30_000 });
  expectNoSeriousErrors(seriousErrors);
});

test('no-local-backend mode still loads committed static analysis sidecars', async ({ page }) => {
  const response = await page.goto('/?localBackend=0', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok(), `root response status: ${response && response.status()}`).toBe(true);

  const manifest = await fetchStudyManifest(page);
  if (manifest.series.length === 0) {
    await expect(page.locator('#series-list li')).toHaveCount(0);
    await expect(page.locator('#canvas-wrap')).toHaveClass(/no-series/);
    await expect(page.locator('#empty-state')).toBeVisible();
    return;
  }

  const primarySeries = manifest.series[0];
  await expect(page.locator('#series-list li').first()).toBeVisible();
  await page.locator('#series-list li').first().click();
  await expect(page.locator('#series-name')).toHaveText(primarySeries.name);
  await expect(page.locator('#btn-upload')).toBeVisible();
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#btn-ask')).toHaveClass(/hidden/);
  await expect(page.locator('#btn-consult')).toHaveClass(/hidden/);
  const findingsState = await page.locator('#findings').evaluate((host) => ({
    summary: host.querySelector('.f-summary')?.textContent?.trim() || '',
    findingCount: host.querySelectorAll('.finding').length,
    status: host.querySelector('#gen-status')?.textContent?.trim() || '',
  }));
  expect(
    findingsState.summary.includes(primarySeries.name)
      || findingsState.findingCount > 0
      || findingsState.status.includes('cached sidecars appear here when present'),
    `unexpected no-local-backend findings state: ${JSON.stringify(findingsState)}`,
  ).toBe(true);
});

test('config aiAnalysis=false hides local AI actions when the local backend is available', async ({ page }) => {
  const fulfillDisabledAiConfig = async (route) => {
    const upstream = await route.fetch();
    const base = await upstream.json().catch(() => ({}));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...base,
        localAiAvailable: false,
        features: { ...(base.features || {}), aiAnalysis: false },
      }),
    });
  };
  await page.route('**/config.local.json', fulfillDisabledAiConfig);
  await page.route('**/config.json', fulfillDisabledAiConfig);

  try {
    const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(response && response.ok(), `root response status: ${response && response.status()}`).toBe(true);

    const manifest = await fetchStudyManifest(page);
    if (manifest.series.length === 0) return;

    await expect(page.locator('#btn-ask')).toHaveClass(/hidden/);
    await expect(page.locator('#btn-consult')).toHaveClass(/hidden/);
    await page.keyboard.press('k');
    await expect(page.locator('#btn-ask')).not.toHaveClass(/active/);
    await expect(page.locator('#ask-reticle')).toBeHidden();

    await page.locator('#btn-cmdk-open').click();
    await page.locator('#cmdk-input').fill('ask ai');
    await expect(page.locator('#cmdk-list')).toContainText('No matching actions');
    await page.locator('#cmdk-input').fill('consolidated read');
    await expect(page.locator('#cmdk-list')).toContainText('No matching actions');
    await page.keyboard.press('Escape');

    await page.locator('#btn-help').click();
    await expect(page.locator('#help-ai-row')).toHaveClass(/hidden/);
    await expect(page.locator('#help-ai-foot')).toHaveClass(/hidden/);
    await page.locator('#help-shortcuts-open').click();
    await expect(page.locator('.shortcut-row', { hasText: 'Ask AI' })).toHaveCount(0);
    await expect(page.locator('.shortcut-row', { hasText: 'Consolidated read' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await expect(page.locator('#regen-analysis')).toHaveCount(0);

    const ctSeries = page.locator('#series-list li').filter({ hasText: 'CT Chest 2' });
    if (await ctSeries.count()) {
      await ctSeries.first().click();
      await expect(page.locator('#gen-current-analysis')).toHaveCount(0);
      await expect(page.locator('#gen-analysis')).toHaveCount(0);
      await expect(page.locator('#gen-status')).toContainText('AI analysis is disabled');
    }
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

test('checked-in default config hides local AI actions even with the local backend', async ({ page }) => {
  const checkedInConfig = JSON.parse(
    await readFile(new URL('../../config.json', import.meta.url), 'utf8'),
  );
  await page.route('**/config.local.json', async (route) => {
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/config.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(checkedInConfig),
    });
  });

  const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok(), `root response status: ${response && response.status()}`).toBe(true);

  await expect(page.locator('#btn-ask')).toHaveClass(/hidden/);
  await expect(page.locator('#btn-consult')).toHaveClass(/hidden/);
  await page.locator('#btn-cmdk-open').click();
  await expect(page.locator('#cmdk-list')).not.toContainText('Consult');
});
