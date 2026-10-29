import { expect } from '@playwright/test';
import { waitForControlsReady } from './app.mjs';
import { waitForCanvasPaint } from './canvas.mjs';

export function localVolumeSeries(slug, name, options = {}) {
  const slices = options.slices ?? 16;
  return {
    slug,
    name,
    description: options.description ?? 'browser fixture volume',
    modality: options.modality ?? 'MR',
    slices,
    width: options.width ?? 32,
    height: options.height ?? 32,
    pixelSpacing: options.pixelSpacing ?? [1, 1],
    sliceThickness: options.sliceThickness ?? 1,
    sliceSpacingStats: options.sliceSpacingStats ?? { mean: 1, regular: true },
    geometryKind: 'volumeStack',
    reconstructionCapability: 'display-volume',
    renderability: 'volume',
    firstIPP: [0, 0, 0],
    lastIPP: [0, 0, Math.max(0, slices - 1)],
    orientation: [1, 0, 0, 0, 1, 0],
  };
}

export async function routeLocalVolumeStudy(page, series, { registration = {} } = {}) {
  await page.route('**/api/local-token', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ localApiToken: 'fixture-local-token' }),
    });
  });
  await page.route(/\/config(?:\.local)?\.json$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        modalWebhookBase: '',
        r2PublicUrl: '',
        trustedUploadOrigins: [],
        localApiToken: '',
        localAiAvailable: true,
        ai: { enabled: true, provider: 'local', ready: true, issues: [] },
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
      body: JSON.stringify({ patient: 'anonymous', studyDate: '', series }),
    });
  });
  await page.route('**/data/registration.json', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(registration) });
  });
  for (const [seriesIndex, item] of series.entries()) {
    await page.route(`**/data/${item.slug}/*.png`, async (route) => {
      const file = route.request().url().split('/').pop() || '';
      const index = Number.parseInt(file.replace('.png', ''), 10);
      if (!Number.isFinite(index) || index < 0 || index >= item.slices) {
        await route.fulfill({ status: 404 });
        return;
      }
      const shade = Math.min(235, 60 + seriesIndex * 40 + (index % 8) * 18);
      await route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="${item.width}" height="${item.height}" viewBox="0 0 ${item.width} ${item.height}">
          <rect width="${item.width}" height="${item.height}" fill="rgb(${shade},${shade},${shade})"/>
          <path d="M0 ${6 + index} L${item.width} ${item.height - 6 - (index % 10)}" stroke="rgb(255,255,255)" stroke-width="3"/>
          <circle cx="${8 + (index % 6) * 4}" cy="${item.height - 8 - (index % 5) * 3}" r="5" fill="rgb(20,20,20)"/>
        </svg>`,
      });
    });
  }
  return series;
}

export async function openLocalStudy(page, series, { path = '/?localBackend=1', viewport = null } = {}) {
  if (viewport) await page.setViewportSize(viewport);
  await routeLocalVolumeStudy(page, series);
  const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
  expect(response && response.ok(), `root response status: ${response && response.status()}`).toBe(true);
  await waitForControlsReady(page);
  return series;
}

export async function fetchStudyManifest(page) {
  return page.evaluate(() => fetch('/data/manifest.json').then(response => response.json()));
}

export function primaryVolumeIndex(manifest) {
  return Math.max(0, manifest.series.findIndex((series) => (
    !series?.sliceUrlBase
    && (series?.reconstructionCapability === 'display-volume' || series?.geometryKind === 'volumeStack')
  )));
}

export async function openPerfViewer(page, path = '/?perf=1') {
  const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
  expect(response && response.ok(), `root response status: ${response && response.status()}`).toBe(true);
  return fetchStudyManifest(page);
}

export async function selectVolumeSeries(page, manifest) {
  const volumeSeriesIndex = primaryVolumeIndex(manifest);
  const volumeSeries = manifest.series[volumeSeriesIndex];
  await expect(page.locator('#series-list li')).toHaveCount(manifest.series.length, { timeout: 20_000 });
  const currentName = await page.locator('#series-name').textContent();
  if ((currentName || '').trim() !== volumeSeries.name) {
    await page.locator('#series-list li').nth(volumeSeriesIndex).click();
  }
  await waitForCanvasPaint(page, '#view');
  return { volumeSeries, volumeSeriesIndex };
}

export async function openPerfVolumeFixture(page) {
  await routeLocalVolumeStudy(page, [
    localVolumeSeries('perf_volume', 'Performance Volume Fixture', {
      description: 'self-contained browser performance fixture',
      slices: 3,
    }),
  ]);
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const manifest = await openPerfViewer(page, attempt ? `/?perf=1&testReload=${Date.now()}` : '/?perf=1');
    try {
      await selectVolumeSeries(page, manifest);
      return manifest;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
