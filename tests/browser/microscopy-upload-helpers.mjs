/* global DataTransfer, Event, File, document, window */
import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';

export async function routeConfig(page, override = {}) {
  await page.route('**/config.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        modalWebhookBase: '',
        r2PublicUrl: '',
        trustedUploadOrigins: [],
        localApiToken: '',
        localAiAvailable: true,
        ai: { enabled: true, provider: 'claude', ready: true, issues: [] },
        siteName: 'VoxelLab',
        disclaimer: 'Not for clinical use. For research and educational purposes only.',
        features: {
          cloudProcessing: true,
          aiAnalysis: true,
          ...(override.features || {}),
        },
        ...override,
      }),
    });
  });
}

export async function openUploadModal(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#btn-upload')).toBeVisible();
  await page.waitForFunction(() => typeof document.getElementById('btn-upload')?.onclick === 'function');
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
}

export async function dropFiles(page, selector, files) {
  const payload = await Promise.all(files.map(async ({ path, mimeType = 'application/octet-stream', relativePath = '' }) => ({
    bytes: Array.from(await readFile(path)),
    name: path.split('/').pop(),
    mimeType,
    relativePath,
  })));
  const dataTransfer = await page.evaluateHandle((items) => {
    const dt = new DataTransfer();
    for (const item of items) {
      const file = new File([new Uint8Array(item.bytes)], item.name, { type: item.mimeType });
      if (item.relativePath) Object.defineProperty(file, 'webkitRelativePath', { value: item.relativePath });
      dt.items.add(file);
    }
    return dt;
  }, payload);
  await page.locator(selector).evaluate((target, transfer) => {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    target.dispatchEvent(event);
  }, dataTransfer);
}

export async function waitForCanvasPaint(page, selector) {
  await expect.poll(async () => page.locator(selector).evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return 0;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonBlackPixels = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] !== 0 || data[index + 1] !== 0 || data[index + 2] !== 0) nonBlackPixels += 1;
    }
    return nonBlackPixels;
  }), { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(page.locator(selector)).toBeVisible();
  await expect(page.locator('#view-xform')).not.toHaveClass(/view-awaiting-slice/);
}

export async function drawEllipseRoi(page) {
  await page.locator('#toolbox-measure .toolbox-trigger').click();
  await page.locator('#btn-roi-ell').click();
  const box = await page.locator('#view').boundingBox();
  expect(box).toBeTruthy();
  const x1 = box.x + box.width * 0.35;
  const y1 = box.y + box.height * 0.35;
  const x2 = box.x + box.width * 0.68;
  const y2 = box.y + box.height * 0.68;
  await page.mouse.click(x1, y1);
  await page.mouse.move(x2, y2);
  await page.mouse.click(x2, y2);
}

export async function drawPointRoi(page, xRatio = 0.52, yRatio = 0.48) {
  if (!await page.locator('#btn-roi-point').isVisible()) {
    await page.locator('#toolbox-measure .toolbox-trigger').click();
  }
  if (!await page.locator('#btn-roi-point').evaluate(button => button.classList.contains('active'))) {
    await page.locator('#btn-roi-point').click();
  }
  const box = await page.locator('#view').boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.click(box.x + box.width * xRatio, box.y + box.height * yRatio);
}

export async function expectScaleBarFits(page) {
  const metrics = await page.locator('#scale-bar').evaluate(async (bar) => {
    const { state } = await import('/js/state.js');
    const { calibratedScaleBarModel } = await import('/js/scale-bar.js');
    const rect = bar.getBoundingClientRect();
    const line = document.getElementById('scale-bar-line');
    const label = document.getElementById('scale-bar-label');
    const canvas = document.getElementById('view');
    const cssWidth = Number.parseFloat(canvas?.style?.width || '') || canvas?.getBoundingClientRect?.().width || 0;
    const expected = calibratedScaleBarModel(state.manifest?.series?.[state.seriesIdx], {
      canvasCssWidth: cssWidth,
      imageWidth: canvas?.width || 0,
      zoom: state.zoom,
    });
    return {
      hidden: bar.hidden,
      label: label?.textContent || '',
      aria: bar.getAttribute('aria-label') || '',
      expected,
      width: rect.width,
      lineWidth: line?.getBoundingClientRect().width || 0,
      lineStyleWidth: Number.parseFloat(line?.style?.width || ''),
      right: rect.right,
      bottom: rect.bottom,
      lineOverflow: line ? line.scrollWidth > line.clientWidth + 1 : false,
      labelOverflow: label ? label.scrollWidth > label.clientWidth + 1 : false,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  expect(metrics.hidden, JSON.stringify(metrics)).toBe(false);
  expect(metrics.expected, JSON.stringify(metrics)).toBeTruthy();
  expect(metrics.label, JSON.stringify(metrics)).toBe(metrics.expected.label);
  expect(metrics.aria, JSON.stringify(metrics)).toContain(metrics.label);
  expect(metrics.lineWidth, JSON.stringify(metrics)).toBeGreaterThan(20);
  expect(metrics.lineStyleWidth, JSON.stringify(metrics)).toBe(metrics.expected.widthPx);
  expect(Math.abs(metrics.lineWidth - metrics.lineStyleWidth), JSON.stringify(metrics)).toBeLessThanOrEqual(0.5);
  expect(metrics.right, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.bottom, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewportHeight + 1);
  expect(metrics.lineOverflow, JSON.stringify(metrics)).toBe(false);
  expect(metrics.labelOverflow, JSON.stringify(metrics)).toBe(false);
}
