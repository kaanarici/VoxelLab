import { expect } from '@playwright/test';

export async function assertNoRoiResultsOverflow(page) {
  const metrics = await page.evaluate(() => {
    const root = document.documentElement;
    const panel = document.getElementById('roi-results-panel');
    const exportButton = document.getElementById('roi-results-export');
    const jsonExportButton = document.getElementById('roi-results-json-export');
    const exportRect = exportButton?.getBoundingClientRect();
    const jsonExportRect = jsonExportButton?.getBoundingClientRect();
    const rows = [...document.querySelectorAll('[data-roi-result-row]')];
    return {
      viewport: { width: innerWidth, height: innerHeight },
      rootScrollWidth: root.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      panelRight: panel ? Math.ceil(panel.getBoundingClientRect().right) : 0,
      exportFits: !exportRect || (exportRect.left >= -1 && exportRect.right <= innerWidth + 1),
      jsonExportFits: !jsonExportRect || (jsonExportRect.left >= -1 && jsonExportRect.right <= innerWidth + 1),
      visibleRowsFit: rows.every((row) => row.scrollWidth <= row.clientWidth + 1),
      visibleMetricCellsFit: [...document.querySelectorAll('.roi-result-metrics b')]
        .every((cell) => cell.scrollWidth <= cell.clientWidth + 1),
    };
  });
  expect(metrics.rootScrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewport.width + 1);
  expect(metrics.bodyScrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewport.width + 1);
  expect(metrics.exportFits, JSON.stringify(metrics)).toBe(true);
  expect(metrics.jsonExportFits, JSON.stringify(metrics)).toBe(true);
  expect(metrics.visibleRowsFit, JSON.stringify(metrics)).toBe(true);
  expect(metrics.visibleMetricCellsFit, JSON.stringify(metrics)).toBe(true);
}

const MICROSCOPY_WORKFLOW_CHROME = [
  '#microscopy-channel-select',
  '#microscopy-channel-color',
  '#microscopy-time-select',
  '.hyperstack-channel-text',
  '.hyperstack-status',
  '#microscopy-split-preview',
  '#microscopy-calibration',
  '#scale-bar',
  '#microscopy-recipe-export',
  '#microscopy-recipe-import',
  '#microscopy-recipe-status',
  '[data-roi-result-row]',
  '#roi-results-export',
  '#roi-results-json-export',
  '#roi-results-json-import',
  '#roi-results-status',
];

export async function assertNoMicroscopyChromeOverflow(page) {
  const metrics = await page.evaluate((selectors) => {
    const visibleRect = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) return null;
      return {
        selector,
        right: rect.right,
        bottom: rect.bottom,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflow: el.scrollWidth > el.clientWidth + 1,
      };
    };
    const checked = selectors.map(visibleRect).filter(Boolean);
    return {
      viewportWidth: innerWidth,
      rootScrollWidth: document.documentElement.scrollWidth,
      overflowing: checked.filter(item => item.overflow),
      outOfViewport: checked.filter(item => item.right > innerWidth + 1),
    };
  }, MICROSCOPY_WORKFLOW_CHROME);
  expect(metrics.rootScrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.overflowing, JSON.stringify(metrics)).toEqual([]);
  expect(metrics.outOfViewport, JSON.stringify(metrics)).toEqual([]);
}

export async function expectUploadModalMatrixFits(page) {
  const metrics = await page.locator('#upload-modal .ask-card').evaluate((card) => {
    const body = card.querySelector('.ask-body-wrap');
    const cardRect = card.getBoundingClientRect();
    const checked = [...card.querySelectorAll('.format-capability-title, .format-capability-head, .format-capability-row')]
      .filter((node) => node.getClientRects().length > 0);
    return {
      bodyClientWidth: body?.clientWidth || 0,
      bodyScrollWidth: body?.scrollWidth || 0,
      overflowing: checked.map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          className: node.className,
          left: rect.left,
          right: rect.right,
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
          outside: rect.left < cardRect.left - 1 || rect.right > cardRect.right + 1,
        };
      }).filter(item => item.outside || item.scrollWidth > item.clientWidth + 1),
    };
  });
  expect(metrics.bodyScrollWidth, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.bodyClientWidth + 1);
  expect(metrics.overflowing, JSON.stringify(metrics)).toEqual([]);
}

export async function openDetailsPanelForViewport(page, viewport) {
  if (viewport.width > 1100) return;
  const rightPanel = page.locator('aside.right');
  if (!(await rightPanel.evaluate((panel) => panel.classList.contains('mobile-open')))) {
    await page.locator('#btn-show-right').click();
  }
  await expect(rightPanel).toHaveClass(/mobile-open/);
  await page.waitForFunction(() => {
    const panel = document.querySelector('aside.right');
    if (!panel?.classList.contains('mobile-open')) return false;
    const rect = panel.getBoundingClientRect();
    return rect.left >= -1 && rect.right <= window.innerWidth + 1;
  });
}

export async function waitForThreeSurface(page) {
  await expect.poll(async () => page.evaluate(() => {
    const container = document.getElementById('three-container');
    const canvas = container?.querySelector('canvas');
    return {
      active: container?.classList.contains('active') || false,
      mounted: Boolean(canvas),
      painted: Math.min(
        canvas?.width || 0,
        canvas?.height || 0,
        canvas?.clientWidth || 0,
        canvas?.clientHeight || 0,
      ) > 0,
    };
  }), { timeout: 10_000 }).toEqual({ active: true, mounted: true, painted: true });
}

export async function expectThreeCanvasFitsContainer(page) {
  await expect.poll(async () => page.evaluate(() => {
    const container = document.getElementById('three-container');
    const canvas = container?.querySelector('canvas');
    const containerRect = container?.getBoundingClientRect();
    const canvasRect = canvas?.getBoundingClientRect();
    if (!containerRect || !canvasRect) return false;
    return Math.abs(containerRect.width - canvasRect.width) <= 2
      && Math.abs(containerRect.height - canvasRect.height) <= 2;
  }), { timeout: 10_000 }).toBe(true);
}
