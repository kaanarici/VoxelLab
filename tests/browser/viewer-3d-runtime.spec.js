import { expect, test } from '@playwright/test';
import {
  localVolumeSeries,
  openPerfViewer,
  openPerfVolumeFixture,
  routeLocalVolumeStudy,
  selectVolumeSeries,
} from '../helpers/browser/local-study.mjs';
import { setSliderValue, waitForThreeMesh } from '../helpers/browser/canvas.mjs';
import { ensurePanelOpen } from '../helpers/browser/panels.mjs';

test.setTimeout(90_000);

async function viewerMode(page) {
  return page.evaluate(async () => (await import('/js/core/state.js')).state.mode);
}

async function sliceIndex(page) {
  return page.evaluate(async () => (await import('/js/core/state.js')).state.sliceIdx);
}

async function sliceAndClip(page) {
  return page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    return { slice: state.sliceIdx, clipZ: state.three.clipMax[2] };
  });
}

test('repeated 3D mode cycles reuse one renderer canvas', async ({ page }) => {
  await openPerfVolumeFixture(page);
  await page.locator('#btn-3d').click();
  await expect(page.locator('#three-container.active canvas')).toBeVisible();
  await waitForThreeMesh(page);
  await ensurePanelOpen(page, '#panel-3d');

  const renderer = await page.evaluate(async () => {
    const { getThreeRuntime } = await import('/js/runtime/viewer-runtime.js');
    const runtime = getThreeRuntime();
    return {
      orthographic: runtime.camera?.isOrthographicCamera === true,
      pixelRatio: runtime.renderer?.getPixelRatio(),
    };
  });
  expect(renderer.orthographic).toBe(true);
  expect(renderer.pixelRatio).toBeLessThanOrEqual(1.5);

  const sampling = await page.evaluate(async () => {
    const { getThreeRuntime } = await import('/js/runtime/viewer-runtime.js');
    const runtime = getThreeRuntime();
    const before = runtime.mesh.material.uniforms.uSteps.value;
    runtime.controls.dispatchEvent({ type: 'start' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const during = runtime.mesh.material.uniforms.uSteps.value;
    runtime.controls.dispatchEvent({ type: 'end' });
    return { before, during };
  });
  expect(sampling.during).toBe(sampling.before);

  await page.evaluate(() => { globalThis.__voxellabSoakCanvas = document.querySelector('#three-container canvas'); });
  for (let index = 0; index < 12; index += 1) {
    await page.locator('#btn-3d').click();
    await page.locator('#btn-3d').click();
    await expect(page.locator('#three-container.active canvas')).toBeVisible();
  }
  expect(await page.evaluate(() => ({
    canvasCount: document.querySelectorAll('#three-container canvas').length,
    reused: globalThis.__voxellabSoakCanvas === document.querySelector('#three-container canvas'),
  }))).toEqual({ canvasCount: 1, reused: true });
});

test('turntable and render-mode controls drive the shared renderer', async ({ page }) => {
  await openPerfVolumeFixture(page);
  await page.locator('#btn-3d').click();
  await expect(page.locator('#three-container.active canvas')).toBeVisible();
  await waitForThreeMesh(page);
  await ensurePanelOpen(page, '#panel-3d');

  const cameraPosition = async () => page.evaluate(async () => (
    (await import('/js/runtime/viewer-runtime.js')).getThreeRuntime().camera?.position.toArray()
  ));
  await page.locator('#three-turntable').click();
  await expect(page.locator('#three-turntable')).toHaveAttribute('aria-pressed', 'true');
  const turnStart = await cameraPosition();
  await expect.poll(cameraPosition, {
    message: 'turntable should keep moving the camera',
  }).not.toEqual(turnStart);
  expect(await page.evaluate(async () => (
    (await import('/js/runtime/viewer-runtime.js')).getThreeRuntime().renderer?.getPixelRatio()
  ))).toBeLessThanOrEqual(1);

  await page.locator('.preset-btn[data-view="reset"]').click();
  await expect(page.locator('#three-turntable')).toHaveAttribute('aria-pressed', 'false');

  await page.locator('#render-mode .pill[data-mode="mip"]').click();
  await expect(page.locator('#s-gain')).toBeDisabled();
  await page.locator('#render-mode .pill[data-mode="alpha"]').click();
  await expect(page.locator('#s-gain')).toBeEnabled();
});

test('3D renderer failure returns to a supported view without an unhandled rejection', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(type, ...args) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
      return original.call(this, type, ...args);
    };
  });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await openPerfVolumeFixture(page);

  await page.locator('#btn-3d').click();

  await expect(page.locator('#btn-3d')).not.toHaveClass(/active/);
  await expect(page.locator('#three-container')).not.toHaveClass(/active/);
  await expect(page.locator('[data-notify-id="three-renderer-unavailable"]')).toContainText('3D rendering is unavailable');
  await expect.poll(() => viewerMode(page)).toBe('2d');
  expect(pageErrors).toEqual([]);
});

test('entering 3D preserves the review slice and keeps a full volume until a scrubber cuts it', async ({ page }) => {
  await openPerfVolumeFixture(page);
  await page.locator('#scrub').fill('1');
  await page.locator('#btn-mpr').click();
  await expect.poll(() => sliceIndex(page)).toBe(1);

  await page.locator('#btn-3d').click();

  await expect(page.locator('#btn-3d')).toHaveClass(/active/);
  await expect.poll(() => sliceAndClip(page)).toEqual({ slice: 1, clipZ: 1 });
  await expect(page.locator('#s-zscrub')).toHaveValue('2');

  await setSliderValue(page, '#s-zscrub', 0);
  await expect.poll(() => sliceAndClip(page)).toEqual({ slice: 0, clipZ: 1 / 3 });

  await setSliderValue(page, '#scrub', 1);
  await expect.poll(() => sliceAndClip(page)).toEqual({ slice: 1, clipZ: 2 / 3 });
});

test('3D keeps a supported preview when the full volume exceeds the live GPU texture limit', async ({ page }) => {
  await page.addInitScript(() => {
    const original = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function getParameter(parameter) {
      return parameter === 0x8073 ? 256 : original.call(this, parameter);
    };
  });
  const series = localVolumeSeries('preview_only_volume', 'Preview-only Volume', {
    width: 512,
    height: 792,
    slices: 192,
    pixelSpacing: [0.5, 1],
  });
  series.sliceSpacing = 3;
  series.lastIPP = [0, 0, 573];
  series.hasPreview = true;
  series.previewDims = [16, 24, 8];
  await routeLocalVolumeStudy(page, [series]);
  await page.route('**/data/preview_only_volume_preview.raw', route => route.fulfill({
    status: 200,
    contentType: 'application/octet-stream',
    body: Buffer.alloc(16 * 24 * 8, 180),
  }));
  const manifest = await openPerfViewer(page, '/?localBackend=1');
  await selectVolumeSeries(page, manifest);

  await page.locator('#btn-3d').click();
  await expect(page.locator('#three-container.active canvas')).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const { getThreeRuntime } = await import('/js/runtime/viewer-runtime.js');
    const runtime = getThreeRuntime();
    return {
      preview: runtime.previewShown,
      materialPreview: runtime.mesh?.material?.userData?.preview,
      textureDims: runtime.mesh?.material?.userData?.textureDims,
      densityScale: runtime.mesh?.material?.uniforms?.uVolSize?.value?.toArray(),
    };
  }), { timeout: 10_000 }).toEqual({
    preview: true,
    materialPreview: true,
    textureDims: { width: 16, height: 24, depth: 8 },
    densityScale: [1024, 792, 1152],
  });
});
