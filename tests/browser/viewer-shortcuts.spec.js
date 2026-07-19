/* global document, localStorage */
import { expect, test } from '@playwright/test';

test('page metadata and Help describe the experimental local-first build', async ({ page }) => {
  await page.route('**/data/manifest.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ patient: 'anonymous', studyDate: '', series: [] }),
    });
  });

  const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBe(true);
  await expect(page).toHaveTitle('VoxelLab');
  await expect(page.locator('meta[name="application-name"]')).toHaveAttribute('content', 'VoxelLab');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /local-first experimental workbench/);

  await expect(page.locator('#btn-help')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => document.documentElement.dataset.voxellabControlsReady === 'true');
  await page.locator('#btn-help').click();
  await expect(page.locator('#help-modal')).toHaveClass(/visible/);
  await expect(page.locator('.help-about')).toContainText('About this build');
  await expect(page.locator('.help-about')).toContainText('built end-to-end through human-directed AI');
  await expect(page.locator('.help-about')).toContainText('calibration and provenance boundaries explicit');
  await expect(page.locator('.help-about')).toContainText('Not for clinical use');
});

test('sidebar toggle stays aligned with the sidebar action icon column', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('mri-viewer/shellLayout/v1'));
  const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBe(true);
  await expect(page.locator('#btn-toggle-left')).toBeVisible();

  const openMetrics = await page.evaluate(() => {
    const hideIcon = document.querySelector('#btn-toggle-left svg').getBoundingClientRect();
    const uploadIcon = document.querySelector('#btn-upload .sidebar-ico').getBoundingClientRect();
    const searchIcon = document.querySelector('#btn-cmdk-open .sidebar-ico').getBoundingClientRect();
    return {
      hideLeft: hideIcon.left,
      uploadLeft: uploadIcon.left,
      searchLeft: searchIcon.left,
    };
  });
  expect(openMetrics.hideLeft).toBeCloseTo(openMetrics.uploadLeft, 1);
  expect(openMetrics.hideLeft).toBeCloseTo(openMetrics.searchLeft, 1);

  await page.locator('#btn-toggle-left').click();
  await page.waitForFunction(() => document.querySelector('.app')?.classList.contains('left-collapsed'));
  const collapsedMetrics = await page.evaluate(() => ({
    showLeft: document.querySelector('#btn-show-left svg').getBoundingClientRect().left,
  }));
  expect(collapsedMetrics.showLeft).toBeCloseTo(openMetrics.hideLeft, 1);
});

test('shortcut customizer edits, clears, resets, and blocks duplicate bindings', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (message.text().includes('Failed to load resource')) return;
    if (message.text().includes('config.local.json')) return;
    errors.push(message.text());
  });
  await page.addInitScript(() => localStorage.removeItem('voxellab.keyboardShortcuts.v1'));
  await page.route('**/data/manifest.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ patient: 'anonymous', studyDate: '', series: [] }),
    });
  });

  const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBe(true);
  await expect(page.locator('#btn-cmdk-open')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => document.documentElement.dataset.voxellabControlsReady === 'true');

  await page.locator('#btn-cmdk-open').click();
  await page.locator('#cmdk-input').fill('shortcuts');
  await page.getByRole('button', { name: /Customize shortcuts/ }).click();
  await expect(page.locator('#shortcuts-modal')).toHaveClass(/visible/);
  await expect(page.locator('#shortcuts-close')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || '')).toContain('Clear shortcut for');
  await page.keyboard.press('Tab');
  await expect(page.locator('#shortcuts-close')).toBeFocused();

  const screenshotRow = page.locator('.shortcut-row', { hasText: 'Screenshot' });
  await expect(screenshotRow.locator('.shortcut-keycaps kbd')).toHaveText('S');
  await screenshotRow.hover();
  await page.getByLabel('Edit shortcut for Screenshot').click();
  await expect(screenshotRow.locator('.shortcut-capture')).toHaveText('Press shortcut');
  await page.keyboard.press('X');
  await expect(screenshotRow.locator('.shortcut-keycaps kbd')).toHaveText('X');
  await expect(page.getByLabel('Reset shortcut for Screenshot')).toBeVisible();
  await expect(page.getByLabel('Clear shortcut for Screenshot')).toBeVisible();

  const mprRow = page.locator('.shortcut-row', { hasText: 'MPR mode' });
  await mprRow.hover();
  await page.getByLabel('Edit shortcut for MPR mode').click();
  await page.keyboard.press('X');
  await expect(mprRow.locator('.shortcut-conflict')).toContainText('Already assigned to Screenshot');
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.getByLabel('Clear shortcut for Screenshot').click();
  await expect(screenshotRow.locator('.shortcut-unassigned')).toHaveText('Unassigned');
  await page.getByLabel('Reset shortcut for Screenshot').click();
  await expect(screenshotRow.locator('.shortcut-keycaps kbd')).toHaveText('S');

  await page.locator('#shortcuts-close').click();
  await page.locator('#btn-help').click();
  await page.locator('#help-shortcuts-open').click();
  await expect(page.locator('#shortcuts-modal')).toHaveClass(/visible/);

  expect(errors).toEqual([]);
});
