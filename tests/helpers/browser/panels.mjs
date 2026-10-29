import { expect } from '@playwright/test';

export async function ensurePanelOpen(page, panelSelector, visibleSelector = '') {
  const panel = page.locator(panelSelector);
  if (await panel.evaluate(element => element.classList.contains('collapsed')).catch(() => false)) {
    await panel.locator('.sec-title').click();
  }
  await expect(panel).not.toHaveClass(/collapsed/);
  await expect(visibleSelector ? page.locator(visibleSelector).first() : panel).toBeVisible();
}

async function revealMeasureTool(page, button) {
  const trigger = page.locator('#toolbox-measure .toolbox-trigger');
  for (let attempt = 0; attempt < 2 && !await button.isVisible(); attempt += 1) {
    await trigger.click();
  }
  await expect(button).toBeVisible();
}

export async function selectMeasureTool(page, selector) {
  const button = page.locator(selector);
  const isActive = async () => button.evaluate(element => element.classList.contains('active')).catch(() => false);
  if (!await isActive()) {
    await revealMeasureTool(page, button);
    await button.click();
  }
  await expect(button).toHaveClass(/active/);
}

export async function drawEllipseRoi(page) {
  await selectMeasureTool(page, '#btn-roi-ell');
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
  await selectMeasureTool(page, '#btn-roi-point');
  const box = await page.locator('#view').boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.click(box.x + box.width * xRatio, box.y + box.height * yRatio);
}

export async function drawLineMeasurement(page) {
  await selectMeasureTool(page, '#btn-measure');
  const box = await page.locator('#view').boundingBox();
  expect(box).toBeTruthy();
  const y = box.y + box.height * 0.55;
  await page.mouse.click(box.x + box.width * 0.25, y);
  await page.mouse.click(box.x + box.width * 0.75, y);
}

export async function drawAngleMeasurement(page) {
  await selectMeasureTool(page, '#btn-angle');
  const box = await page.locator('#view').boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.42);
  await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.42);
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.62);
}

export async function clearSliceDrawings(page) {
  await page.evaluate(async () => {
    const { clearCurrentSliceDrawings } = await import('/js/clear-slice-drawings.js');
    clearCurrentSliceDrawings();
  });
  await page.locator('#clear-confirm').click();
  await expect(page.locator('#roi-results-count')).toHaveText('0');
}
