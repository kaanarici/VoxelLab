import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { localVolumeSeries, routeLocalVolumeStudy } from './local-volume-fixture.mjs';

async function routeRegistrationStudy(page) {
  const primary = localVolumeSeries('reg_primary', 'Registration Primary', { slices: 4 });
  const peer = localVolumeSeries('reg_peer', 'Registration Peer', { slices: 4 });
  primary.sourceSeriesUID = '1.2.826.registration.fixed';
  for (const series of [primary, peer]) {
    series.group = 'registration-fixture';
    series.compareGroup = 'registration-fixture';
    series.frameOfReferenceUID = '1.2.826.registration.fixture';
  }
  await routeLocalVolumeStudy(page, [primary, peer], {
    registration: {
      reference: '1.2.826.registration.fixed',
      pairs: {
        reg_peer: {
          translation_mm: [0.5, -0.25, 3.2],
          translation_magnitude_mm: 3.246,
          rotation_deg: 0.42,
          dice: 0.82,
          verdict: 'slightly off',
        },
      },
    },
  });
  return { primary, peer };
}

test('registration evidence opens fixed/moving compare with verdict labels', async ({ page }) => {
  await routeRegistrationStudy(page);

  const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBe(true);
  await expect(page.locator('#series-name')).toHaveText('Registration Primary');

  await page.locator('#series-list li').nth(1).click();
  await expect(page.locator('#series-name')).toHaveText('Registration Peer');
  const registrationRow = page.locator('#meta .meta-row', {
    has: page.locator('.mk', { hasText: /^Registration$/ }),
  });
  await expect(registrationRow).toContainText('data/registration.json');
  await expect(registrationRow).toContainText('slightly off');
  await expect(registrationRow).toContainText('displacement 3.25 mm');
  await expect(registrationRow).toContainText('rotation 0.42 deg');
  await expect(registrationRow).toContainText('Dice 0.82');
  await expect(page.locator('#registration-evidence-export-json')).toBeVisible();
  await expect(page.locator('#registration-evidence-open-compare')).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#registration-evidence-export-json').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('voxellab-registration-evidence-reg_peer.json');
  const evidence = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(evidence.schema).toBe('voxellab.registration-evidence.v1');
  expect(evidence.disclaimer).toContain('not clinical output');
  expect(evidence.fixedImage.slug).toBe('reg_primary');
  expect(evidence.movingImage.slug).toBe('reg_peer');
  expect(evidence.registration.referenceSlug).toBe('1.2.826.registration.fixed');
  expect(evidence.registration.movingSlug).toBe('reg_peer');
  expect(evidence.registration.transform.translationMm).toEqual([0.5, -0.25, 3.2]);
  expect(evidence.registration.transform.translationMagnitudeMm).toBe(3.246);
  expect(evidence.registration.quality.mm).toBe(3.25);
  expect(JSON.stringify(evidence)).not.toContain('fixture-local-token');

  await page.locator('#registration-evidence-open-compare').click();
  await expect(page.locator('#series-name')).toHaveText('Registration Primary');
  await expect(page.locator('#canvas-wrap')).toHaveClass(/cmp/);
  await expect(page.locator('.cmp-cell')).toHaveCount(2);
  await expect(page.locator('.cmp-cell').nth(0).locator('.cmp-lbl')).toHaveText('Registration Primary');
  await expect(page.locator('.cmp-cell').nth(1).locator('.cmp-lbl')).toHaveText('Registration Peer · slightly off · 3.25 mm');
});

test('Ask registration action opens fixed/moving compare', async ({ page }) => {
  await routeRegistrationStudy(page);

  let postedPayload = {};
  await page.route('**/api/ask/stream', async (route) => {
    postedPayload = route.request().postDataJSON() || {};
    const result = {
      cached: false,
      key: '0:study:regctx',
      slice: 0,
      x: 0,
      y: 0,
      question: 'Show me the registration evidence.',
      answer: 'Registration comparison is available.',
      crop: 'data/reg_peer_asks/0000_study_regctx.png',
      actions: [
        {
          id: 'open-registration-compare',
          label: 'Open Registration Compare',
          detail: 'Active registration evidence: series Registration Peer; inspect Metadata panel Compare opens fixed/moving compare with Registration Primary as fixed image.',
        },
      ],
    };
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ type: 'result', result })}\n\n`,
    });
  });

  const response = await page.goto('/?localBackend=1', { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBe(true);
  await page.locator('#series-list li').nth(1).click();
  await expect(page.locator('#series-name')).toHaveText('Registration Peer');

  await page.locator('#btn-ask').click();
  await expect(page.locator('#ask-composer')).toBeVisible();
  await page.locator('#ask-bar-input').fill('Show me the registration evidence.');
  await page.locator('#ask-bar-send').click();

  await expect.poll(() => postedPayload.viewerContext || '').toContain('Active registration evidence');
  expect(postedPayload.viewerContext).toContain('Registration Peer');
  expect(postedPayload.viewerContext).toContain('inspect Metadata panel Compare opens fixed/moving compare with Registration Primary as fixed image');
  await expect(page.locator('.ask-qa-a')).toContainText('Registration comparison is available.');
  const askAction = page.locator('.ask-action-chip', { hasText: 'Open Registration Compare' });
  await expect(askAction).toBeVisible();
  await expect(askAction).toContainText('fixed/moving compare');

  await askAction.click();
  await expect(page.locator('#series-name')).toHaveText('Registration Primary');
  await expect(page.locator('#canvas-wrap')).toHaveClass(/cmp/);
  await expect(page.locator('.cmp-cell')).toHaveCount(2);
  await expect(page.locator('.cmp-cell').nth(0).locator('.cmp-lbl')).toHaveText('Registration Primary');
  await expect(page.locator('.cmp-cell').nth(1).locator('.cmp-lbl')).toHaveText('Registration Peer · slightly off · 3.25 mm');
});
