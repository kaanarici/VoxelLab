import { expect } from '@playwright/test';

export async function canvasPaintStats(page, selector = '#view') {
  return page.locator(selector).evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rect = canvas.getBoundingClientRect();
    if (!ctx || canvas.width === 0 || canvas.height === 0) {
      return {
        hasContext: Boolean(ctx),
        width: canvas.width,
        height: canvas.height,
        displayWidth: Math.round(rect.width),
        displayHeight: Math.round(rect.height),
        aspectDelta: 0,
        nonTransparentPixels: 0,
        nonBlackPixels: 0,
        maxChannel: 0,
      };
    }
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonTransparentPixels = 0;
    let nonBlackPixels = 0;
    let maxChannel = 0;
    for (let index = 0; index < data.length; index += 4) {
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      if (data[index + 3] !== 0) nonTransparentPixels += 1;
      if (r !== 0 || g !== 0 || b !== 0) nonBlackPixels += 1;
      maxChannel = Math.max(maxChannel, r, g, b);
    }
    return {
      hasContext: true,
      width: canvas.width,
      height: canvas.height,
      displayWidth: Math.round(rect.width),
      displayHeight: Math.round(rect.height),
      aspectDelta: Math.abs((rect.width / rect.height) - (canvas.width / canvas.height)),
      nonTransparentPixels,
      nonBlackPixels,
      maxChannel,
    };
  });
}

export async function waitForCanvasPaint(page, selector = '#view', timeout = 10_000) {
  let stats = null;
  await expect.poll(async () => {
    stats = await canvasPaintStats(page, selector);
    return stats.hasContext && stats.nonBlackPixels > 0 && stats.maxChannel > 0;
  }, {
    timeout,
    message: `${selector} never painted a non-black pixel`,
  }).toBe(true);
  await expect(page.locator(selector)).toBeVisible();
  return stats;
}

export async function waitForSlicePaint(page, selector = '#view', timeout = 10_000) {
  const stats = await waitForCanvasPaint(page, selector, timeout);
  await expect(page.locator('#view-xform')).not.toHaveClass(/view-awaiting-slice/);
  return stats;
}

export function expectUndistortedCanvas(stats, label) {
  expect(stats.displayWidth, `${label} rendered width: ${JSON.stringify(stats)}`).toBeGreaterThan(0);
  expect(stats.displayHeight, `${label} rendered height: ${JSON.stringify(stats)}`).toBeGreaterThan(0);
  expect(stats.aspectDelta, `${label} rendered aspect drift: ${JSON.stringify(stats)}`).toBeLessThan(0.025);
}

export async function waitForWebGlCanvasPaint(page, selector = '#three-container.active canvas', timeout = 15_000) {
  let stats = null;
  await expect.poll(async () => {
    stats = await page.locator(selector).evaluate(async (canvas) => {
      const { getThreeRuntime } = await import('/js/runtime/viewer-runtime.js');
      getThreeRuntime().renderNow?.();
      const gl = canvas.getContext('webgl2');
      if (!gl) return { hasContext: false, nonBlackPixels: 0, maxChannel: 0 };
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let nonBlackPixels = 0;
      let maxChannel = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const channel = Math.max(pixels[index], pixels[index + 1], pixels[index + 2]);
        if (channel > 0) nonBlackPixels += 1;
        maxChannel = Math.max(maxChannel, channel);
      }
      return { hasContext: true, nonBlackPixels, maxChannel };
    });
    return stats.hasContext && stats.nonBlackPixels > 0;
  }, {
    timeout,
    message: `${selector} never painted a non-black WebGL pixel`,
  }).toBe(true);
  return stats;
}

export async function renderThreeNow(page) {
  await page.evaluate(async () => {
    const { getThreeRuntime } = await import('/js/runtime/viewer-runtime.js');
    getThreeRuntime().renderNow?.();
  });
}

export async function waitForThreeMesh(page, timeout = 30_000) {
  await expect.poll(() => page.evaluate(async () => (
    Boolean((await import('/js/runtime/viewer-runtime.js')).getThreeRuntime().mesh)
  )), { timeout }).toBe(true);
}

export async function waitForMprVolumeReady(page, timeout = 30_000) {
  await expect.poll(async () => page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    return {
      mode: state.mode,
      ready: Boolean(state.hrVoxels || state.voxels),
    };
  }), { timeout }).toMatchObject({ mode: 'mpr', ready: true });
}

export async function canvasChecksum(page, selector) {
  return page.locator(selector).evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx || canvas.width === 0 || canvas.height === 0) return 'blank';
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    const stride = Math.max(4, Math.floor(data.length / 4096));
    for (let index = 0; index < data.length; index += stride) {
      hash ^= data[index];
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return `${canvas.width}x${canvas.height}:${hash}`;
  });
}

export async function canvasSignature(page, selector = '#view') {
  return page.locator(selector).evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const stride = Math.max(4, Math.floor(data.length / 4096 / 4) * 4);
    let checksum = 0;
    let nonBlack = 0;
    let maxChannel = 0;
    for (let i = 0; i < data.length; i += stride) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      checksum = (checksum + r * 3 + g * 5 + b * 7 + i) % 1000000007;
      if (r || g || b) nonBlack += 1;
      maxChannel = Math.max(maxChannel, r, g, b);
    }
    return { width: canvas.width, height: canvas.height, checksum, nonBlack, maxChannel };
  });
}

export async function canvasSamples(page, selector = '#view') {
  return page.locator(selector).evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const points = [
      [Math.floor(canvas.width * 0.5), Math.floor(canvas.height * 0.5)],
      [Math.floor(canvas.width * 0.45), Math.floor(canvas.height * 0.45)],
      [Math.floor(canvas.width * 0.6), Math.floor(canvas.height * 0.55)],
    ];
    return points.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data));
  });
}

export async function canvasPixel(page, x = 0, y = 0, selector = '#view') {
  return page.locator(selector).evaluate((canvas, point) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return Array.from(ctx.getImageData(point.x, point.y, 1, 1).data);
  }, { x, y });
}

export async function canvasImageData(page, selector = '#view') {
  return page.locator(selector).evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  });
}

export async function clickCanvasPixel(page, x, y, selector = '#view') {
  const canvas = page.locator(selector);
  const box = await canvas.boundingBox();
  expect(box, `${selector} must be visible to click`).toBeTruthy();
  const size = await canvas.evaluate(element => ({ width: element.width, height: element.height }));
  await page.mouse.click(
    box.x + (x / size.width) * box.width,
    box.y + (y / size.height) * box.height,
  );
}

export async function setSliderValue(page, selector, value) {
  await page.locator(selector).evaluate((input, next) => {
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

export async function settleFrames(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
