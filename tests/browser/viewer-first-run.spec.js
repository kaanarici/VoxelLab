import { expect, test } from '@playwright/test';

test('the first-run action opens the existing study upload flow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/data/manifest.json', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ patient: 'anonymous', studyDate: '', series: [] }),
  }));

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.voxellabControlsReady === 'true');

  const emptyState = page.locator('#empty-state');
  await expect(emptyState).toBeVisible();
  await expect(page.locator('#btn-upload')).toHaveAttribute('aria-label', 'Open study');
  await expect(page.locator('#empty-state-upload')).toHaveAccessibleName('Open study');
  await expect(emptyState.locator('.empty-state-title')).toHaveText('Research imaging, locally.');
  await expect(emptyState).toContainText('local-first research imaging workbench');
  await expect(emptyState).toContainText('Not for clinical use');
  await expect(emptyState.locator('.empty-state-badge')).toContainText(['DICOM', 'NIfTI', 'OME-TIFF', 'TIFF']);
  const widths = await emptyState.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      emptyState: element.scrollWidth,
      left: bounds.left,
      right: bounds.right,
    };
  });
  expect(widths.document).toBe(widths.viewport);
  expect(widths.emptyState).toBe(widths.viewport);
  expect(widths.left).toBeGreaterThanOrEqual(0);
  expect(widths.right).toBeLessThanOrEqual(widths.viewport);

  const openStudy = page.locator('#empty-state-upload');
  await openStudy.focus();
  await expect(openStudy).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-modal .ask-title')).toHaveText('Open study');

  const advanced = page.locator('#upload-advanced-options');
  const advancedSummary = advanced.locator('summary');
  await expect(advanced).not.toHaveAttribute('open', '');
  await expect(page.locator('#upload-zone')).toBeVisible();
  await expect(page.locator('#upload-folder-btn')).toBeVisible();
  await expect(page.locator('#upload-cloud-actions')).toBeHidden();

  await page.evaluate(() => {
    window.__localOpenClicks = { files: 0, folders: 0 };
    document.querySelector('#upload-file-input').addEventListener('click', (event) => {
      event.preventDefault();
      window.__localOpenClicks.files += 1;
    });
    document.querySelector('#upload-folder-input').addEventListener('click', (event) => {
      event.preventDefault();
      window.__localOpenClicks.folders += 1;
    });
  });
  await page.locator('#upload-zone').click();
  await page.locator('#upload-folder-btn').click();
  await expect.poll(() => page.evaluate(() => ({
    files: window.__localOpenClicks.files > 0,
    folders: window.__localOpenClicks.folders > 0,
  }))).toEqual({ files: true, folders: true });

  await advancedSummary.focus();
  await page.keyboard.press('Enter');
  await expect(advanced).toHaveAttribute('open', '');
  await expect(page.locator('#upload-cloud-actions')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Format support matrix' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(advanced).not.toHaveAttribute('open', '');
});
