import { test, expect } from '@playwright/test';

import { routeManifest, waitForControlsReady } from '../helpers/browser/app.mjs';

test('Tools / Overlays toolbox triggers only show dot when a panel tool is active', async ({ page }) => {
  await routeManifest(page);
  await page.goto('/');
  try {
    await waitForControlsReady(page);
  } catch {
    await page.goto(`/?testReload=${Date.now()}`);
    await waitForControlsReady(page);
  }

  const measure = page.locator('#toolbox-measure .toolbox-trigger');
  const overlays = page.locator('#toolbox-overlays .toolbox-trigger');
  await expect(measure).not.toHaveClass(/has-active/);
  await expect(overlays).not.toHaveClass(/has-active/);

  await page.reload();
  await waitForControlsReady(page);
  await expect(measure).not.toHaveClass(/has-active/);
  await expect(overlays).not.toHaveClass(/has-active/);
});
