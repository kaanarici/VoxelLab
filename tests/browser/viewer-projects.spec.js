import { expect, test } from '@playwright/test';

test('project rename dialog traps focus and returns to the folder menu button', async ({ page }) => {
  const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBe(true);
  await expect(page.locator('#btn-new-folder')).toBeVisible();
  await page.waitForFunction(() => Boolean(document.getElementById('btn-new-folder')?._wired));

  const before = await page.locator('.project-folder').count();
  await page.locator('#btn-new-folder').click();
  await expect(page.locator('.project-folder')).toHaveCount(before + 1);

  const folder = page.locator('.project-folder').last();
  const menuButton = folder.locator('.project-menu-btn');
  await menuButton.click();
  await folder.locator('.folder-menu .popover-item', { hasText: 'Rename' }).click();

  const dialog = page.locator('.project-rename-overlay');
  const input = dialog.locator('.project-rename-dialog-input');
  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(dialog.locator('.rename-save')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(input).toBeFocused();

  await input.fill('QA focus folder');
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(menuButton).toBeFocused();
  await expect(folder.locator('.project-name')).toHaveText('QA focus folder');
});
