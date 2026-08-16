/* global document, localStorage */
import { expect, test } from '@playwright/test';
import { localVolumeSeries, routeLocalVolumeStudy } from './local-volume-fixture.mjs';

test('restored 3D anatomy and labels become visible without toggling', async ({ page }) => {
  const slug = 'restored_anatomy';
  const slices = 80;
  const series = {
    ...localVolumeSeries(slug, 'Restored Anatomy', { slices, width: 16, height: 16 }),
    hasRegions: true,
  };
  const seriesKey = `anonymous||||${slug}`;

  await page.addInitScript(({ key }) => {
    localStorage.setItem('voxellab.anatomy.labels3d', '1');
    localStorage.setItem('voxellab:interaction-hint-seen', '1');
    localStorage.setItem('mri-viewer/session/v1', JSON.stringify({
      lastActiveKey: key,
      views: {
        [key]: {
          mode: '3d',
          sliceIdx: 0,
          window: null,
          level: null,
          overlays: {
            useBrain: false,
            useSeg: false,
            useRegions: true,
            useSym: false,
          },
          lockedLabels: [],
        },
      },
    }));
  }, { key: seriesKey });
  await routeLocalVolumeStudy(page, [series]);
  await page.route(`**/data/${slug}_regions/*.png`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="rgb(1,1,1)"/></svg>',
    });
  });
  await page.route(`**/data/${slug}_regions.json`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        regions: { 1: { name: 'Fixture anatomy' } },
        colors: { 1: [255, 80, 80] },
      }),
    });
  });

  await page.goto('/?localBackend=1', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#series-name')).toHaveText('Restored Anatomy');
  await expect(page.locator('#btn-regions')).toHaveClass(/active/);
  await expect(page.locator('#btn-anatomy-labels')).toHaveClass(/active/);

  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    return {
      loaded: state.regionImgs.filter(image => image?.complete && image.naturalWidth > 0).length,
      voxels: state.regionVoxels?.length || 0,
    };
  }), { timeout: 30_000 }).toEqual({ loaded: slices, voxels: 16 * 16 * slices });

  await expect.poll(() => page.locator('#atlas3d-svg .atlas-item').count()).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(async () => {
    const { getThreeRuntime } = await import('/js/runtime/viewer-runtime.js');
    return getThreeRuntime().mesh?.material?.uniforms?.uLabelMode?.value ?? 0;
  })).toBe(2);

  await page.waitForTimeout(1_000);
  expect(await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const { getThreeRuntime } = await import('/js/runtime/viewer-runtime.js');
    return {
      loaded: state.regionImgs.filter(image => image?.complete && image.naturalWidth > 0).length,
      voxels: state.regionVoxels?.length || 0,
      labelMode: getThreeRuntime().mesh?.material?.uniforms?.uLabelMode?.value ?? 0,
      labels: document.querySelectorAll('#atlas3d-svg .atlas-item').length,
    };
  })).toEqual({
    loaded: slices,
    voxels: 16 * 16 * slices,
    labelMode: 2,
    labels: 1,
  });
});
