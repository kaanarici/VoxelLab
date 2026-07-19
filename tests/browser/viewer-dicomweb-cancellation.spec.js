/* global document, window */
import { expect, test } from '@playwright/test';

async function routeConfig(page) {
  await page.route(/\/config(?:\.local)?\.json$/, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      modalWebhookBase: '',
      r2PublicUrl: '',
      trustedUploadOrigins: [],
      localApiToken: '',
      localAiAvailable: true,
      ai: { enabled: true, provider: 'local', ready: true, issues: [] },
      siteName: 'VoxelLab',
      disclaimer: 'Not for clinical use. For research and educational purposes only.',
      features: { cloudProcessing: true, aiAnalysis: true },
    }),
  }));
}

async function openAdvancedOptions(page) {
  const advanced = page.locator('#upload-advanced-options');
  if (!await advanced.evaluate(element => element.open)) {
    await advanced.locator('summary').click();
  }
}

test('replacing or dismissing the upload modal aborts DICOMweb discovery and cannot update the next session', async ({ page }) => {
  await routeConfig(page);
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__dicomwebAbortRecords = [];
    window.fetch = (input, options = {}) => {
      const url = String(input);
      if (!url.startsWith('https://pacs.example/')) return nativeFetch(input, options);
      return new Promise((_resolve, reject) => {
        const record = { url, aborted: false };
        window.__dicomwebAbortRecords.push(record);
        options.signal?.addEventListener('abort', () => {
          record.aborted = true;
          reject(new DOMException('cancelled', 'AbortError'));
        }, { once: true });
      });
    };
  });
  await page.route('**/data/manifest.json', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ patient: 'anonymous', studyDate: '', series: [] }),
  }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.voxellabControlsReady === 'true');
  await page.locator('#btn-upload').click();
  await openAdvancedOptions(page);
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.evaluate(() => { window.__dismissedDicomwebStudyInput = document.getElementById('dicomweb-study'); });
  await page.locator('#dicomweb-find-studies-btn').click();
  await expect.poll(() => page.evaluate(() => window.__dicomwebAbortRecords.length)).toBe(1);

  // Buttons are disabled while a request owns the modal, but an external
  // re-entry (for example, a desktop command) must still replace that owner.
  await page.locator('#dicomweb-find-studies-btn').evaluate((button) => { void button.onclick(); });
  await expect.poll(() => page.evaluate(() => window.__dicomwebAbortRecords.length)).toBe(2);
  await expect.poll(() => page.evaluate(() => window.__dicomwebAbortRecords[0].aborted)).toBe(true);

  // A new upload command re-renders the modal without necessarily toggling the
  // old element's visibility. The old request must still be cancelled.
  await page.locator('#btn-upload').evaluate(button => button.click());
  await expect.poll(() => page.evaluate(() => window.__dicomwebAbortRecords[1].aborted)).toBe(true);
  await expect(page.locator('#upload-modal')).toBeVisible();
  await openAdvancedOptions(page);
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.locator('#dicomweb-find-studies-btn').click();
  await expect.poll(() => page.evaluate(() => window.__dicomwebAbortRecords.length)).toBe(3);

  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.__dicomwebAbortRecords[2].aborted)).toBe(true);
  await page.locator('#btn-upload').click();
  await openAdvancedOptions(page);

  await expect.poll(() => page.evaluate(() => window.__dismissedDicomwebStudyInput.value)).toBe('');
  await expect(page.locator('#dicomweb-study')).toHaveValue('');
  await expect(page.locator('#upload-status')).toHaveText('');
});
