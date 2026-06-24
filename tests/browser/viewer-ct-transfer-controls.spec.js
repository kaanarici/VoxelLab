import { expect, test } from '@playwright/test';
import { localVolumeSeries, routeLocalVolumeStudy } from './local-volume-fixture.mjs';

test('CT HU transfer controls are CT-only and clear stale active state', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
      errors.push(message.text());
    }
  });

  await routeLocalVolumeStudy(page, [
    localVolumeSeries('ct_research_volume', 'CT Research Volume', { modality: 'CT' }),
    localVolumeSeries('ct_named_mr_volume', 'CT Named MR Volume', { modality: 'MR' }),
  ]);
  const response = await page.goto('/?localBackend=1', { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBe(true);

  await page.locator('#series-list li').nth(0).click();
  await page.locator('#btn-3d').click();
  // The VOLUME (3D) panel starts collapsed by default; expand it to reach the CT
  // HU Range controls (same reveal step the other panel tests use).
  if (await page.locator('#panel-3d').evaluate((el) => el.classList.contains('collapsed'))) {
    await page.locator('#panel-3d .sec-title').click();
  }
  await expect(page.locator('#ct-window-title')).toHaveText('CT HU Range');
  await expect(page.locator('#ct-window')).toBeVisible();
  await expect(page.locator('#ct-window .pill')).toHaveText(['Full', 'Soft', 'Lung', 'Bone']);
  await expect(page.locator('#ct-window .pill.active')).toHaveText('Full');

  await page.locator('#ct-window .pill', { hasText: 'Lung' }).click();
  await expect(page.locator('#ct-window .pill.active')).toHaveText('Lung');
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    return {
      lowT: Number(state.lowT.toFixed(4)),
      highT: Number(state.highT.toFixed(4)),
    };
  })).toEqual({ lowT: 0, highT: 0.4147 });

  await page.locator('#preset-surface').click();
  await expect(page.locator('#ct-window .pill.active')).toHaveCount(0);

  await page.locator('#btn-3d').click();
  await page.locator('#series-list li').nth(1).click();
  await page.locator('#btn-3d').click();
  await expect(page.locator('#ct-window')).toBeHidden();
  await expect(page.locator('#ct-window-title')).toBeHidden();

  expect(errors).toEqual([]);
});
