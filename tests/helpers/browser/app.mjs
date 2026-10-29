import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '@playwright/test';

export const EMPTY_STUDY = { patient: 'anonymous', studyDate: '', series: [] };

export const LOCAL_ONLY_CONFIG = {
  modalWebhookBase: '',
  r2PublicUrl: '',
  features: { cloudProcessing: false },
};

export async function isolatedFixturePath(testInfo, name) {
  const dir = join(
    tmpdir(),
    'voxellab-pw-fixtures',
    String(testInfo.testId || testInfo.title).replace(/[^A-Za-z0-9._-]+/g, '_'),
  );
  await mkdir(dir, { recursive: true });
  return join(dir, name);
}

export async function routeConfig(page, override = {}) {
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
        ai: { enabled: true, provider: 'claude', ready: true, issues: [] },
        siteName: 'VoxelLab',
        disclaimer: 'Not for clinical use. For research and educational purposes only.',
        ...override,
        features: {
          cloudProcessing: true,
          aiAnalysis: true,
          ...(override.features || {}),
        },
      }),
    });
  });
}

export async function routeManifest(page, manifest = EMPTY_STUDY) {
  await page.route('**/data/manifest.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(manifest),
    });
  });
}

export async function waitForControlsReady(page, timeout = 10_000) {
  await page.waitForFunction(
    () => document.documentElement.dataset.voxellabControlsReady === 'true',
    null,
    { timeout },
  );
}

export async function openViewer(page, path = '/') {
  const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
  expect(response && response.ok(), `root response status: ${response && response.status()}`).toBe(true);
  await waitForControlsReady(page);
  return response;
}

export async function openAdvancedOptions(page) {
  const advanced = page.locator('#upload-advanced-options');
  if (!await advanced.evaluate(element => element.open)) {
    await advanced.locator('summary').click();
  }
}

export async function openUploadModal(page) {
  const waitForUploadReady = async (timeout) => {
    await expect(page.locator('#btn-upload')).toBeVisible({ timeout });
    await waitForControlsReady(page, timeout);
  };
  let lastError = null;
  const readinessTimeouts = [5_000, 7_000, 7_000];
  for (let attempt = 0; attempt < readinessTimeouts.length; attempt += 1) {
    const suffix = attempt === 0 ? '' : `?testReload=${Date.now()}-${attempt}`;
    await page.goto(`/${suffix}`, { waitUntil: 'domcontentloaded' });
    try {
      await waitForUploadReady(readinessTimeouts[attempt]);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
}

export async function openStudyUploadModal(page) {
  await openUploadModal(page);
  await expect(page.locator('#upload-modal .ask-title')).toHaveText('Open study');
  await openAdvancedOptions(page);
}

export async function openEmptyStudyUploadModal(page) {
  await routeManifest(page);
  await openStudyUploadModal(page);
}

export async function reopenUploadModal(page) {
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
}

export async function acceleratePolling(page) {
  await page.addInitScript(() => {
    const realSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (fn, ms = 0, ...args) => realSetTimeout(fn, Math.min(Number(ms) || 0, 10), ...args);
  });
}

export async function dismissOnboardingHint(page) {
  const dismiss = page.getByRole('button', { name: 'Got it' });
  if (await dismiss.isVisible()) await dismiss.click();
}
