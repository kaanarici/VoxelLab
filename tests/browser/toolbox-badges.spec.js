import { test, expect } from '@playwright/test';

test('Tools / Overlays toolbox triggers only show dot when a panel tool is active', async ({ page }) => {
  await page.route('**/data/manifest.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ patient: 'anonymous', studyDate: '', series: [] }),
    });
  });
  await page.goto('/');
  try {
    await page.waitForFunction(() => document.documentElement.dataset.voxellabControlsReady === 'true', null, { timeout: 10_000 });
  } catch {
    await page.goto(`/?testReload=${Date.now()}`);
    await page.waitForFunction(() => document.documentElement.dataset.voxellabControlsReady === 'true');
  }

  const measure = page.locator('#toolbox-measure .toolbox-trigger');
  const overlays = page.locator('#toolbox-overlays .toolbox-trigger');
  await expect(measure).not.toHaveClass(/has-active/);
  await expect(overlays).not.toHaveClass(/has-active/);

  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.voxellabControlsReady === 'true');
  await expect(measure).not.toHaveClass(/has-active/);
  await expect(overlays).not.toHaveClass(/has-active/);
});
