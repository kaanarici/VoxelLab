import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { localVolumeSeries, routeLocalVolumeStudy } from './local-volume-fixture.mjs';

function violationSummary(results) {
  return results.violations.map(violation => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.map(node => node.target.join(' ')),
  }));
}

async function expectNoSeriousViolations(page, include) {
  await page.waitForTimeout(500);
  const results = await new AxeBuilder({ page })
    .include(include)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
  expect(serious, JSON.stringify(violationSummary({ violations: serious }), null, 2)).toEqual([]);
}

test('viewer, exact MPR angles, and arbitrary 3D clipping pass serious WCAG checks', async ({ page }) => {
  await routeLocalVolumeStudy(page, [localVolumeSeries('a11y_volume', 'Accessibility Volume')]);
  await page.goto('/?localBackend=1', { waitUntil: 'domcontentloaded' });
  await page.locator('#series-list li').first().click();
  const navigationHelp = page.getByRole('dialog', { name: 'How to navigate' });
  if (await navigationHelp.isVisible()) await navigationHelp.getByRole('button', { name: 'Got it' }).click();

  await expectNoSeriousViolations(page, '.app');

  await page.locator('#btn-mpr').click();
  await expect(page.locator('#mpr-toolbar')).toBeVisible();
  await expectNoSeriousViolations(page, '#mpr-toolbar');
  await page.locator('#btn-mpr').click();

  await page.locator('#btn-3d').click();
  const volumePanel = page.locator('#panel-3d');
  await expect(volumePanel).toBeVisible();
  await page.waitForTimeout(350);
  if (await volumePanel.evaluate(panel => panel.classList.contains('collapsed'))) {
    await volumePanel.locator('.sec-title').click();
  }
  const clippingDetails = volumePanel.locator('.rp-more');
  if (!(await clippingDetails.evaluate(details => details.open))) {
    await clippingDetails.locator('.rp-more-summary').click();
  }
  await expect(page.locator('#s-clip-plane-enabled')).toBeVisible();
  await expectNoSeriousViolations(page, '#panel-3d');
});
