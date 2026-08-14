import { expect, test } from '@playwright/test';
import { localVolumeSeries, routeLocalVolumeStudy } from './local-volume-fixture.mjs';

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

test('slow project persistence renders late and rapid collapsed-folder clicks keep the newest series', async ({ page }) => {
  const series = [
    localVolumeSeries('project_series_a', 'Project Series A', { slices: 2 }),
    localVolumeSeries('project_series_b', 'Project Series B', { slices: 2 }),
  ];
  await routeLocalVolumeStudy(page, series);
  await page.addInitScript(({ slugs }) => {
    localStorage.setItem('mri-viewer/pinned-series', JSON.stringify(slugs));
    window.__projectReadDelays = [125];
    window.__projectReadFailures = [];
    window.__projectReadStarts = 0;
    window.__projectReadCompletions = 0;
    window.__projectRecords = slugs.map((slug, index) => ({
      id: `folder-${index}`,
      name: `Folder ${index + 1}`,
      color: '#888',
      order: index,
      collapsed: true,
      seriesSlugs: [slug],
    }));
    const originalGetAll = IDBObjectStore.prototype.getAll;
    Object.defineProperty(IDBObjectStore.prototype, 'getAll', {
      configurable: true,
      value(...args) {
        if (this.name !== 'projects') return originalGetAll.apply(this, args);
        const request = {};
        const delay = window.__projectReadDelays.shift() || 0;
        const fail = !!window.__projectReadFailures.shift();
        window.__projectReadStarts += 1;
        setTimeout(() => {
          if (fail) {
            request.error = new Error('project store unavailable');
            request.onerror?.({ target: request });
            return;
          }
          request.result = window.__projectRecords.map(project => ({
            ...project,
            seriesSlugs: [...project.seriesSlugs],
          }));
          window.__projectReadCompletions += 1;
          request.onsuccess?.({ target: request });
        }, delay);
        return request;
      },
    });
  }, { slugs: series.map(item => item.slug) });

  const response = await page.goto('/?localBackend=1', { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBe(true);
  await expect(page.locator('.project-folder')).toHaveCount(2);
  await expect(page.locator('#pinned-list [data-series-slug]')).toHaveCount(2);
  await expect(page.locator('#series-name')).toHaveText('Project Series A');

  await page.evaluate(() => {
    window.__projectReadDelays = [200, 10];
    window.__projectReadCompletions = 0;
  });
  await page.locator('#pinned-list [data-series-slug="project_series_b"]').click();
  await page.locator('#pinned-list [data-series-slug="project_series_a"]').click();

  await expect.poll(async () => page.evaluate(() => window.__projectReadCompletions)).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(250);
  await expect(page.locator('#series-name')).toHaveText('Project Series A');
  await expect.poll(async () => page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    return state.manifest.series[state.seriesIdx]?.slug;
  })).toBe('project_series_a');

  await page.evaluate(() => {
    window.__projectReadDelays = [0, 0, 200, 0, 0, 0];
    window.__projectReadFailures = [];
    window.__projectReadStarts = 0;
    window.__projectReadCompletions = 0;
  });
  await page.locator('#pinned-list [data-series-slug="project_series_b"]').click();
  await expect.poll(async () => page.evaluate(() => window.__projectReadStarts)).toBeGreaterThanOrEqual(3);
  await page.locator('#pinned-list [data-series-slug="project_series_a"]').click();
  await expect.poll(async () => page.evaluate(() => window.__projectReadCompletions)).toBeGreaterThanOrEqual(6);
  await expect(page.locator('#series-name')).toHaveText('Project Series A');

  await page.evaluate(() => {
    window.__projectReadDelays = [];
    window.__projectReadFailures = [true, true];
  });
  await page.locator('#pinned-list [data-series-slug="project_series_b"]').click();
  await expect(page.locator('#series-name')).toHaveText('Project Series B');
  await expect(page.locator('.project-folder')).toHaveCount(2);
  await expect(page.locator('#pinned-list [data-series-slug].active')).toHaveAttribute('data-series-slug', 'project_series_b');
  await expect(page.locator('[data-notify-id="projects-storage-warning"]')).toContainText('series remain openable');
});

test('project store rejection keeps the cold flat series fallback usable', async ({ page }) => {
  const series = [
    localVolumeSeries('fallback_series_a', 'Fallback Series A', { slices: 2 }),
    localVolumeSeries('fallback_series_b', 'Fallback Series B', { slices: 2 }),
  ];
  await routeLocalVolumeStudy(page, series);
  await page.addInitScript(() => {
    const originalGetAll = IDBObjectStore.prototype.getAll;
    Object.defineProperty(IDBObjectStore.prototype, 'getAll', {
      configurable: true,
      value(...args) {
        if (this.name !== 'projects') return originalGetAll.apply(this, args);
        const request = {};
        setTimeout(() => {
          request.error = new Error('project store unavailable');
          request.onerror?.({ target: request });
        });
        return request;
      },
    });
  });

  await page.goto('/?localBackend=1', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#series-list li[data-series-slug]')).toHaveCount(2);
  await expect(page.locator('#series-name')).toHaveText('Fallback Series A');
  await expect(page.locator('[data-notify-id="projects-storage-warning"]')).toContainText('series remain openable');
});
