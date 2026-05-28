import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';
import { dropFiles, openUploadModal, routeConfig } from './microscopy-upload-helpers.mjs';

async function writePlaceholderFile(path) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'not a proprietary microscopy container\n');
}

test('proprietary microscopy files stay outside native browser import scope', async ({ page }, testInfo) => {
  await routeConfig(page, { features: { cloudProcessing: false } });
  await openUploadModal(page);

  const bridgeRow = page.locator('.format-capability-row', { hasText: 'CZI / ND2 / LIF bridge' });
  await expect(bridgeRow.locator('.format-capability-status')).toHaveText('Planned');
  await expect(bridgeRow).toContainText('Optional local converter/plugin path only');
  await expect(bridgeRow).toContainText('no first-party browser Bio-Formats parity claim');

  const initialSeriesCount = await page.locator('#series-list li').count();
  const paths = await Promise.all(['sample.czi', 'sample.nd2', 'sample.lif'].map(async (name) => {
    const path = testInfo.outputPath(name);
    await writePlaceholderFile(path);
    return path;
  }));

  await dropFiles(page, '#upload-zone', paths.map((path) => ({ path })));

  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toHaveText('Could not parse files. Check format.');
  await expect.poll(async () => page.locator('#series-list li').count()).toBe(initialSeriesCount);
});
