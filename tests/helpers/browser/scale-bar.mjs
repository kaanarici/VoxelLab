import { expect } from '@playwright/test';

export async function expectScaleBarFits(page) {
  const metrics = await page.locator('#scale-bar').evaluate(async (bar) => {
    const { state } = await import('/js/core/state.js');
    const { calibratedScaleBarModel } = await import('/js/overlay/scale-bar.js');
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

export async function scaleBarSnapshot(page) {
  await expectScaleBarFits(page);
  return page.locator('#scale-bar').evaluate((bar) => ({
    label: document.getElementById('scale-bar-label')?.textContent || '',
    lineWidth: Math.round(document.getElementById('scale-bar-line')?.getBoundingClientRect().width || 0),
    aria: bar.getAttribute('aria-label') || '',
  }));
}
