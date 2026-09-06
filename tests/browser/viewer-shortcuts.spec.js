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
  await expect(page.locator('#help-version')).toHaveText(/^Version \d+\.\d+\.\d+$/);
  await expect(page.locator('#help-check-updates')).toHaveAttribute(
    'href',
    'https://github.com/kaanarici/VoxelLab/releases',
  );
  await page.context().route('https://github.com/kaanarici/VoxelLab/releases', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<title>VoxelLab releases</title>',
  }));
  const popupPromise = page.waitForEvent('popup');
  await page.locator('#help-check-updates').click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL('https://github.com/kaanarici/VoxelLab/releases');
  await popup.close();
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

test('right sidebar restores open sections and collapsed controls are inert', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('mri-viewer/collapsed/v1', JSON.stringify({ 'roi-results': false }));
  });
  const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBe(true);
  await page.waitForFunction(() => document.documentElement.dataset.voxellabControlsReady === 'true');

  const roiSection = page.locator('.rp-section[data-panel="roi-results"]');
  await expect(roiSection).not.toHaveClass(/collapsed/);
  await expect(roiSection.locator('.sec-title')).toHaveAttribute('aria-expanded', 'true');
  expect(await roiSection.locator('.rp-body').evaluate(body => body.inert)).toBe(false);

  await roiSection.locator('.sec-title').click();
  await expect(roiSection).toHaveClass(/collapsed/);
  await expect(roiSection.locator('.sec-title')).toHaveAttribute('aria-expanded', 'false');
  expect(await roiSection.locator('.rp-body').evaluate(body => body.inert)).toBe(true);

  const regionsSection = page.locator('.rp-section[data-panel="regions"]');
  const wasCollapsed = await regionsSection.evaluate(section => section.classList.contains('collapsed'));
  await page.locator('#info-regions').evaluate(icon => icon.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(await regionsSection.evaluate(section => section.classList.contains('collapsed'))).toBe(wasCollapsed);
});

async function shortcutChipColors(page) {
  return page.evaluate(() => {
    const kbd = getComputedStyle(document.querySelector('#btn-cmdk-open .sidebar-shortcut kbd'));
    const sort = getComputedStyle(document.querySelector('#btn-sort-studies'));
    const folder = getComputedStyle(document.querySelector('#btn-new-folder'));
    const searchIco = getComputedStyle(document.querySelector('#btn-cmdk-open .sidebar-ico'));
    return {
      kbd: kbd.color,
      sort: sort.color,
      folder: folder.color,
      searchIco: searchIco.color,
    };
  });
}

test('⌘K keycaps match sidebar action icon color in dark and light', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('mri-viewer/shellLayout/v1'));
  const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBe(true);
  await expect(page.locator('#btn-cmdk-open')).toBeVisible();
  await expect(page.locator('#btn-sort-studies')).toBeVisible();
  await page.waitForFunction(() => document.documentElement.dataset.voxellabControlsReady === 'true');

  const dark = await shortcutChipColors(page);
  expect(dark.kbd).toBe(dark.sort);
  expect(dark.kbd).toBe(dark.folder);
  expect(dark.kbd).toBe(dark.searchIco);

  await page.locator('#btn-cmdk-open').hover();
  const hovered = await page.evaluate(() => ({
    kbd: getComputedStyle(document.querySelector('#btn-cmdk-open .sidebar-shortcut kbd')).color,
    ico: getComputedStyle(document.querySelector('#btn-cmdk-open .sidebar-ico')).color,
  }));
  expect(hovered.kbd).toBe(hovered.ico);

  await page.locator('#btn-theme').click();
  await page.waitForFunction(() => document.documentElement.classList.contains('light'));
  const light = await shortcutChipColors(page);
  expect(light.kbd).toBe(light.sort);
  expect(light.kbd).toBe(light.folder);
  expect(light.kbd).toBe(light.searchIco);
  expect(light.kbd).not.toBe(dark.kbd);
});

test('left sidebar resizes up to the right rail and the right rail stays fixed', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBe(true);
  await expect(page.locator('#sidebar-resize-handle')).toBeVisible();
  await expect(page.locator('#sidebar-resize-handle')).toHaveAttribute('tabindex', '0');
  await expect(page.locator('#sidebar-resize-handle')).toHaveAttribute('aria-valuenow', /\d+/);
  await expect(page.locator('aside.right .sidebar-resize-handle')).toHaveCount(0);

  const start = await page.evaluate(() => ({
    left: document.querySelector('aside.left').getBoundingClientRect().width,
    right: document.querySelector('aside.right').getBoundingClientRect().width,
  }));
  expect(start.left).toBeCloseTo(208, 0);
  expect(start.right).toBeCloseTo(312, 0);

  const handle = page.locator('#sidebar-resize-handle');
  const box = await handle.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box.x + box.width / 2, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x - 80, box.y + 80, { steps: 8 });
  await page.mouse.up();
  const atMin = await page.evaluate(() => document.querySelector('aside.left').getBoundingClientRect().width);
  expect(atMin).toBeCloseTo(208, 0);

  const box2 = await handle.boundingBox();
  await page.mouse.move(box2.x + box2.width / 2, box2.y + 80);
  await page.mouse.down();
  await page.mouse.move(box2.x + 400, box2.y + 80, { steps: 12 });
  await page.mouse.up();

  const atMax = await page.evaluate(() => ({
    left: document.querySelector('aside.left').getBoundingClientRect().width,
    right: document.querySelector('aside.right').getBoundingClientRect().width,
    handleOnRight: !!document.querySelector('aside.right .sidebar-resize-handle'),
  }));
  expect(atMax.left).toBeCloseTo(atMax.right, 0);
  expect(atMax.left).toBeLessThanOrEqual(atMax.right + 0.5);
  expect(atMax.right).toBeCloseTo(312, 0);
  expect(atMax.handleOnRight).toBe(false);

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mri-viewer/shellLayout/v1')));
  expect(stored.leftWidth).toBe(312);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#sidebar-resize-handle')).toBeVisible();
  await expect(page.locator('#sidebar-resize-handle')).toHaveAttribute('aria-valuenow', '312');
  const restored = await page.evaluate(() => document.querySelector('aside.left').getBoundingClientRect().width);
  expect(restored).toBeCloseTo(312, 0);

  await handle.focus();
  await page.keyboard.press('Home');
  await expect(handle).toHaveAttribute('aria-valuenow', '208');
  await page.keyboard.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '216');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '248');
  await page.keyboard.press('End');
  await expect(handle).toHaveAttribute('aria-valuenow', '312');

  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(page.locator('#sidebar-resize-handle')).toBeHidden();
  const tablet = await page.evaluate(() => document.querySelector('aside.left').getBoundingClientRect().width);
  expect(tablet).toBeCloseTo(208, 0);
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

  await page.locator('#shortcuts-close').click();
  await page.locator('#btn-help').click();
  await expect(page.locator('#help-modal kbd[data-shortcut-id="screenshot"]')).toHaveText('X');
  await expect(page.locator('#btn-shot')).toHaveAttribute('data-key', 'x');
  await page.evaluate(() => {
    window.__screenshotShortcutRuns = 0;
    document.querySelector('#btn-shot').onclick = () => { window.__screenshotShortcutRuns += 1; };
  });
  await page.locator('#help-close').click();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('X');
  await page.keyboard.press('S');
  expect(await page.evaluate(() => window.__screenshotShortcutRuns)).toBe(1);
  await page.locator('#btn-help').click();
  await page.locator('#help-shortcuts-open').click();
  await expect(page.locator('#shortcuts-modal')).toHaveClass(/visible/);

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
