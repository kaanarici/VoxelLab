/* global Buffer */
import { expect, test } from '@playwright/test';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6p2ioAAAAASUVORK5CYII=',
  'base64',
);

test('remote slice metadata advances only after the requested pixels load', async ({ page }) => {
  let releaseSecondSlice;
  const secondSliceReady = new Promise(resolve => { releaseSecondSlice = resolve; });
  const slug = 'cloud_delayed_slice';
  await page.route('**/config.json', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      localAiAvailable: true,
      ai: { enabled: true, ready: true, provider: 'codex', issues: [] },
      features: { aiAnalysis: true, cloudProcessing: false },
    }),
  }));
  await page.route('**/data/manifest.json', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      patient: 'anonymous',
      studyDate: '',
      series: [{
        slug,
        name: 'Delayed cloud CT',
        modality: 'CT',
        slices: 2,
        width: 1,
        height: 1,
        pixelSpacing: [1, 1],
        sliceThickness: 1,
        sliceUrlBase: `https://cloud-slice.example/${slug}`,
      }],
    }),
  }));
  await page.route(`**/api/proxy-asset?url=*${slug}%2F0000.png*`, route => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: ONE_PIXEL_PNG,
  }));
  await page.route(`**/api/proxy-asset?url=*${slug}%2F0001.png*`, async (route) => {
    await secondSliceReady;
    await route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG });
  });

  const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBe(true);
  await expect(page.locator('#slice-cur')).toHaveText('1', { timeout: 20_000 });
  await expect(page.locator('#gen-current-analysis')).toHaveText('Observe slice 1');

  await page.locator('#scrub').evaluate((slider) => {
    slider.value = '1';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#scrub')).toHaveValue('1');
  await expect(page.locator('#slice-cur')).toHaveText('1');
  await expect(page.locator('#gen-current-analysis')).toHaveText('Observe slice 1');
  await expect(page.locator('#viewer-spinner')).toBeVisible({ timeout: 2_000 });

  releaseSecondSlice();
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await expect(page.locator('#gen-current-analysis')).toHaveText('Observe slice 2');
  await expect(page.locator('#viewer-spinner')).toBeHidden({ timeout: 2_000 });
});
