import { expect, test as base } from '@playwright/test';
import { dismissOnboardingHint } from '../helpers/browser/app.mjs';
import {
  canvasSamples,
  canvasSignature,
  waitForMprVolumeReady,
} from '../helpers/browser/canvas.mjs';
import { localVolumeSeries, openLocalStudy } from '../helpers/browser/local-study.mjs';

const test = base.extend({
  runtimeErrors: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (response.ok()) return;
      if (response.url().includes('config.local.json')) return;
      if (response.url().endsWith('_asks.json')) return;
      if (response.status() === 404 && response.url().includes('/data/analysis-v2-')) return;
      errors.push(`${response.status()} ${response.url()}`);
    });
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (message.text().includes('Failed to load resource')) return;
      if (message.location().url.includes('config.local.json')) return;
      errors.push(message.text());
    });
    await use(errors);
  },
});

async function readState(page) {
  return page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    return {
      mode: state.mode,
      window: state.window,
      level: state.level,
      invertDisplay: state.invertDisplay,
      colormap: state.colormap,
      zoom: state.zoom,
      tx: state.tx,
      ty: state.ty,
    };
  });
}

async function windowLevel(page) {
  const state = await readState(page);
  return { window: state.window, level: state.level };
}

async function viewerMode(page) {
  return page.evaluate(async () => (await import('/js/core/state.js')).state.mode);
}

async function shiftDragOnView(page, from, to) {
  await page.evaluate(({ start, end }) => {
    const view = document.getElementById('view');
    view.dispatchEvent(new MouseEvent('mousedown', { clientX: start.x, clientY: start.y, bubbles: true, button: 0, shiftKey: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: end.x, clientY: end.y, bubbles: true, shiftKey: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: end.x, clientY: end.y, bubbles: true, shiftKey: true }));
  }, { start: from, end: to });
}

async function openToolbarStudy(page, options = {}) {
  const series = options.series || [
    localVolumeSeries('toolbar_volume_a', 'Toolbar Volume A'),
    localVolumeSeries('toolbar_volume_b', 'Toolbar Volume B'),
  ];
  await openLocalStudy(page, series, { viewport: options.viewport ?? null });
  await page.locator('#series-list li').first().click();
  await expect(page.locator('#series-name')).toHaveText(series[0].name);
  await expect(page.locator('#view')).toBeVisible();
  await expect.poll(() => page.locator('#view').evaluate((canvas) => canvas.width * canvas.height)).toBeGreaterThan(0);
  return series;
}

async function forceManualCompareGroups(page) {
  await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const current = state.manifest.series[state.seriesIdx]?.slug;
    const peer = state.manifest.series.find((series) => series.slug !== current)?.slug;
    state.manifest.series.forEach((series, index) => {
      series.group = `manual-compare-${index}`;
      series.frameOfReferenceUID = `manual-compare-${index}`;
      series.compareGroup = `manual-compare-${index}`;
    });
    state.cmpManualSlugs = [current, peer].filter(Boolean);
  });
}

test('bottom toolbar divider resizes the slice slider and restores on double-click', async ({ page }) => {
  await openLocalStudy(page, [localVolumeSeries('scrubber_resize_volume', 'Scrubber Resize Volume')], {
    viewport: { width: 1400, height: 900 },
  });
  await page.locator('#series-list li').first().click();
  await dismissOnboardingHint(page);

  const handle = page.locator('#scrubber-resize-handle');
  await expect(handle).toBeVisible();
  await expect(handle).toHaveAttribute('role', 'separator');
  await expect(handle).toHaveAttribute('aria-orientation', 'vertical');
  await expect(handle).toHaveAttribute('tabindex', '0');

  const start = await page.evaluate(() => ({
    scrubber: document.querySelector('.scrubber').getBoundingClientRect().width,
    wrap: document.getElementById('tool-rail-wrap').getBoundingClientRect().width,
  }));
  expect(start.scrubber).toBeGreaterThan(80);

  const box = await handle.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();

  const afterLeft = await page.evaluate(() => {
    const handleEl = document.getElementById('scrubber-resize-handle');
    return {
      scrubber: document.querySelector('.scrubber').getBoundingClientRect().width,
      wrap: document.getElementById('tool-rail-wrap').getBoundingClientRect().width,
      now: Number(handleEl.getAttribute('aria-valuenow')),
      min: Number(handleEl.getAttribute('aria-valuemin')),
    };
  });
  expect(afterLeft.scrubber).toBeLessThan(start.scrubber - 40);
  expect(afterLeft.wrap).toBeGreaterThan(start.wrap + 40);
  expect(Math.abs(afterLeft.now - afterLeft.scrubber)).toBeLessThanOrEqual(1);
  expect(afterLeft.min).toBe(Math.round(start.scrubber * 0.5));

  const boxMin = await handle.boundingBox();
  await page.mouse.move(boxMin.x + boxMin.width / 2, boxMin.y + boxMin.height / 2);
  await page.mouse.down();
  await page.mouse.move(boxMin.x - 800, boxMin.y + boxMin.height / 2, { steps: 12 });
  await page.mouse.up();
  const atMin = await page.evaluate(() => document.querySelector('.scrubber').getBoundingClientRect().width);
  expect(atMin).toBeGreaterThanOrEqual(start.scrubber * 0.5 - 1);
  expect(atMin).toBeLessThanOrEqual(start.scrubber * 0.5 + 2);

  const fps = page.locator('#fps');
  const fpsBefore = await fps.inputValue();
  const fpsBox = await fps.boundingBox();
  expect(fpsBox).toBeTruthy();
  await page.mouse.click(fpsBox.x + fpsBox.width * 0.85, fpsBox.y + fpsBox.height / 2);
  await expect.poll(() => fps.inputValue()).not.toBe(fpsBefore);

  await handle.focus();
  await page.keyboard.press('ArrowRight');
  const afterArrow = await page.evaluate(() => document.querySelector('.scrubber').getBoundingClientRect().width);
  expect(afterArrow).toBeGreaterThan(atMin + 4);

  await handle.dblclick();
  await expect.poll(() => page.evaluate(() => document.querySelector('.scrubber').getBoundingClientRect().width))
    .toBeCloseTo(start.scrubber, 0);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mri-viewer/shellLayout/v1')));
  expect(stored.scrubberWidth).toBeGreaterThan(0);
  expect(stored.scrubberWidth).toBeLessThan(start.scrubber);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(async () => page.evaluate(() => document.querySelector('.scrubber')?.getBoundingClientRect().width || 0))
    .toBeCloseTo(stored.scrubberWidth, 0);
});

test('minimum desktop viewport keeps the horizontal tool rail reachable', async ({ page }) => {
  await openLocalStudy(page, [
    localVolumeSeries('minimum_viewport_volume', 'Minimum Viewport Volume'),
    localVolumeSeries('minimum_viewport_peer', 'Minimum Viewport Peer'),
  ], { viewport: { width: 1024, height: 720 } });
  await page.locator('#series-list li').first().click();
  await dismissOnboardingHint(page);

  const rail = page.locator('#tool-rail');
  const wrap = page.locator('#tool-rail-wrap');
  await expect.poll(() => rail.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect(wrap).toHaveClass(/has-overflow-right/);
  await expect(wrap).not.toHaveClass(/has-overflow-left/);

  await page.locator('#btn-auto').focus();
  for (let index = 0; index < 24; index += 1) {
    if (await page.evaluate(() => document.activeElement?.id === 'btn-compare')) break;
    await page.keyboard.press('Tab');
  }
  await expect(page.locator('#btn-compare')).toBeFocused();
  await expect.poll(() => rail.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect(wrap).toHaveClass(/has-overflow-left/);
  const compareHit = await page.locator('#btn-compare').evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const wrapRect = document.getElementById('tool-rail-wrap').getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      reachable: hit === button || button.contains(hit),
      button: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      wrap: { left: wrapRect.left, right: wrapRect.right, top: wrapRect.top, bottom: wrapRect.bottom },
      scrollLeft: document.getElementById('tool-rail').scrollLeft,
      hit: hit ? { id: hit.id, className: hit.className, tagName: hit.tagName } : null,
    };
  });
  expect(compareHit.reachable, JSON.stringify(compareHit)).toBe(true);

  for (let index = 0; index < 24; index += 1) {
    if (await page.evaluate(() => document.activeElement?.id === 'btn-auto')) break;
    await page.keyboard.press('Shift+Tab');
  }
  await expect(page.locator('#btn-auto')).toBeFocused();
  await expect.poll(() => rail.evaluate((element) => element.scrollLeft)).toBeLessThanOrEqual(2);
  expect(await page.locator('#btn-auto').evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit === button || button.contains(hit);
  })).toBe(true);
  expect(await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth > window.innerWidth,
    vertical: document.documentElement.scrollHeight > window.innerHeight,
  }))).toEqual({ horizontal: false, vertical: false });
});

test('removing a compare peer refreshes the retained active viewer', async ({ page }) => {
  await openLocalStudy(page, [
    localVolumeSeries('removal_primary', 'Removal Primary'),
    localVolumeSeries('removal_peer', 'Removal Peer'),
  ]);
  await page.locator('li[data-series-slug="removal_primary"]').click();
  await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    state.manifest.series.forEach((series, index) => {
      series.group = `removal-${index}`;
      series.frameOfReferenceUID = `removal-${index}`;
      series.compareGroup = `removal-${index}`;
    });
    state.cmpManualSlugs = ['removal_primary', 'removal_peer'];
  });
  await page.locator('#btn-compare').click();
  await expect(page.locator('#cmp-grid .cmp-cell')).toHaveCount(2);

  await page.locator('li[data-series-slug="removal_peer"]').click({ button: 'right' });
  await page.locator('.context-menu .popover-item', { hasText: 'Remove from viewer' }).click();
  await expect(page.locator('#confirm-modal')).toHaveClass(/visible/);
  await page.locator('#remove-series-confirm').click();

  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    return { mode: state.mode, slugs: state.manifest.series.map(series => series.slug) };
  })).toEqual({ mode: '2d', slugs: ['removal_primary'] });
  await expect(page.locator('#cmp-grid')).not.toBeVisible();
  await expect(page.locator('#series-name')).toHaveText('Removal Primary');
});

test('compare uses one physical scale and distinguishes unregistered series', async ({ page }) => {
  const dwi = localVolumeSeries('scale_dwi', 'DWI', {
    width: 128,
    height: 128,
    pixelSpacing: [2, 2],
    description: 'Study A · b0 volume',
  });
  const adc = localVolumeSeries('scale_adc', 'ADC', {
    width: 256,
    height: 256,
    pixelSpacing: [1, 1],
    description: 'Study A · ADC map',
  });
  const other = localVolumeSeries('scale_other', 'Other T1', {
    width: 192,
    height: 192,
    pixelSpacing: [1.2, 1.2],
    description: 'Study B · T1',
  });
  for (const [series, group] of [[dwi, 'study-a'], [adc, 'study-a'], [other, 'study-b']]) {
    series.group = group;
    series.frameOfReferenceUID = group;
  }
  await openLocalStudy(page, [dwi, adc, other], { viewport: { width: 1366, height: 768 } });
  await page.locator('li[data-series-slug="scale_dwi"]').click();
  await page.locator('#btn-compare').click();
  await expect(page.locator('#cmp-grid .cmp-cell')).toHaveCount(2);

  const panes = await page.locator('#cmp-grid .cmp-cell canvas').evaluateAll((canvases) => canvases.map((canvas) => ({
    source: [canvas.width, canvas.height],
    display: [canvas.getBoundingClientRect().width, canvas.getBoundingClientRect().height],
  })));
  expect(panes.map((pane) => pane.source)).toEqual([[128, 128], [256, 256]]);
  expect(Math.abs(panes[0].display[0] - panes[1].display[0]), JSON.stringify(panes)).toBeLessThan(1);
  expect(Math.abs(panes[0].display[1] - panes[1].display[1]), JSON.stringify(panes)).toBeLessThan(1);
  await expect(page.locator('#cmp-menu .cmp-menu-section')).toHaveText([
    'Aligned series',
    'Other or unknown study · not registered',
  ]);
  await expect(page.locator('#cmp-menu .cmp-pick-detail')).toContainText([
    'Study A · b0 volume · 128 × 128 · 2.00 × 2.00 mm/px',
    'Study A · ADC map · 256 × 256 · 1.00 × 1.00 mm/px',
    'Study B · T1 · 192 × 192 · 1.20 × 1.20 mm/px',
  ]);
  await page.locator('#cmp-menu input[value="scale_other"]').check();
  await expect(page.locator('#cmp-grid .cmp-cell')).toHaveCount(3);
  await expect(page.locator('#cmp-grid .cmp-cell[data-slug="scale_other"] .cmp-lbl')).toContainText('index sync · not registered');
});

test.describe('display toolbar controls', () => {
  test('window/level, invert, presets, fit, and colormap update 2D render state', async ({ page, runtimeErrors }) => {
    await openToolbarStudy(page);
    const before = await readState(page);

    await page.locator('#btn-auto').click();
    await expect.poll(async () => {
      const state = await windowLevel(page);
      return `${state.window}/${state.level}`;
    }).not.toBe(`${before.window}/${before.level}`);
    await expect(page.locator('#wl-readout')).toHaveText(/\d+ \/ \d+/);
    const afterAuto = await windowLevel(page);
    await expect(page.locator('#mr-presets [data-mrpreset].active')).toHaveCount(0);

    await shiftDragOnView(page, { x: 100, y: 100 }, { x: 110, y: 94 });
    await expect.poll(() => windowLevel(page)).toEqual({
      window: Math.min(512, afterAuto.window + 10),
      level: Math.min(255, afterAuto.level + 6),
    });

    const preInvert = await canvasSamples(page);
    await page.locator('#btn-invert').click();
    await expect(page.locator('#btn-invert')).toHaveClass(/active/);
    expect(await page.evaluate(async () => {
      const { state } = await import('/js/core/state.js');
      return {
        invertDisplay: state.invertDisplay,
        filter: getComputedStyle(document.querySelector('#view')).filter,
      };
    })).toEqual({ invertDisplay: true, filter: 'none' });
    expect(await canvasSamples(page)).not.toEqual(preInvert);

    await expect(page.locator('#mr-presets')).toBeVisible();
    await page.locator('#mr-presets [data-mrpreset="contrast"]').click();
    await expect(page.locator('#mr-presets [data-mrpreset="contrast"]')).toHaveClass(/active/);
    await expect.poll(() => windowLevel(page)).toEqual({ window: 150, level: 90 });

    await shiftDragOnView(page, { x: 50, y: 50 }, { x: 58, y: 47 });
    await expect.poll(() => windowLevel(page)).toEqual({ window: 158, level: 93 });
    await expect(page.locator('#mr-presets [data-mrpreset="contrast"]')).not.toHaveClass(/active/);

    await page.locator('#btn-zoomfit').click();
    const fit = await readState(page);
    expect(fit.zoom).toBeGreaterThan(0);
    expect(fit.tx).toBe(0);
    expect(fit.ty).toBe(0);

    await page.locator('#cmap-trigger').click();
    await expect(page.locator('#cmap-dropdown')).toHaveClass(/open/);
    await page.locator('#cmap-menu .dd-item', { hasText: 'Hot' }).click();
    await expect(page.locator('#cmap-label')).toHaveText('Hot');
    await expect.poll(async () => (await readState(page)).colormap).toBe('hot');
    expect(runtimeErrors).toEqual([]);
  });

  test('MPR honours colormap and invert changes and zoom-fit resets every pane viewport', async ({ page, runtimeErrors }) => {
    await openToolbarStudy(page);
    await page.locator('#cmap-trigger').click();
    await page.locator('#cmap-menu .dd-item', { hasText: 'Hot' }).click();
    await expect.poll(async () => (await readState(page)).colormap).toBe('hot');

    await page.locator('#btn-mpr').click();
    await expect(page.locator('#mpr-ax')).toBeVisible();
    await waitForMprVolumeReady(page);
    await expect.poll(async () => (await canvasSignature(page, '#mpr-ax')).nonBlack).toBeGreaterThan(0);
    const mprHot = await canvasSignature(page, '#mpr-ax');

    await page.evaluate(async () => {
      const { setMprViewport } = await import('/js/core/state/viewer-commands.js');
      setMprViewport('ax', { zoom: 2, tx: 14, ty: -8 });
      setMprViewport('co', { zoom: 2.5, tx: -9, ty: 6 });
    });
    await page.locator('#btn-zoomfit').click();
    await expect.poll(() => page.evaluate(async () => {
      const { state } = await import('/js/core/state.js');
      return { ax: state.mpr.viewports.ax, co: state.mpr.viewports.co };
    })).toEqual({
      ax: { zoom: 1, tx: 0, ty: 0 },
      co: { zoom: 1, tx: 0, ty: 0 },
    });

    await page.locator('#btn-invert').click();
    await expect.poll(async () => (await readState(page)).invertDisplay).toBe(true);
    const mprHotInverted = await canvasSignature(page, '#mpr-ax');
    expect(mprHotInverted.checksum).not.toBe(mprHot.checksum);

    await page.locator('#cmap-trigger').click();
    await page.locator('#cmap-menu .dd-item', { hasText: 'Grayscale' }).click();
    await expect.poll(async () => (await readState(page)).colormap).toBe('grayscale');
    expect((await canvasSignature(page, '#mpr-ax')).checksum).not.toBe(mprHotInverted.checksum);

    await page.locator('#btn-mpr').click();
    await expect(page.locator('#mpr-ax')).not.toBeVisible();
    expect(runtimeErrors).toEqual([]);
  });

  test('compare mode shares window/level and zoom-fit, and unchecking the peer leaves compare', async ({ page, runtimeErrors }) => {
    await openToolbarStudy(page);
    await forceManualCompareGroups(page);

    await page.locator('#btn-compare').click();
    await expect(page.locator('#cmp-grid')).toBeVisible();
    await expect(page.locator('#cmp-dropdown')).toHaveClass(/open/);
    await expect(page.locator('#cmp-menu .cmp-menu-head')).toHaveText('Compare series');
    await expect(page.locator('#cmp-menu .cmp-stop')).toBeVisible();
    await expect.poll(() => viewerMode(page)).toBe('cmp');

    await page.evaluate(async () => {
      const { setWindowLevel } = await import('/js/core/state/viewer-commands.js');
      setWindowLevel(120, 70);
      const grid = document.getElementById('cmp-grid');
      grid.dispatchEvent(new MouseEvent('mousedown', { clientX: 80, clientY: 80, bubbles: true, button: 0 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 86, clientY: 76, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 86, clientY: 76, bubbles: true }));
    });
    await expect.poll(() => windowLevel(page)).toEqual({ window: 126, level: 74 });

    await page.evaluate(async () => {
      const { setCompareViewport } = await import('/js/core/state/viewer-commands.js');
      setCompareViewport({ zoom: 2.5, tx: 18, ty: -12 });
    });
    await page.locator('#btn-zoomfit').click();
    await expect.poll(() => page.evaluate(async () => (await import('/js/core/state.js')).state.compare.viewport))
      .toEqual({ zoom: 1, tx: 0, ty: 0 });

    await page.locator('#btn-compare').click({ button: 'right' });
    await expect(page.locator('#cmp-dropdown')).toHaveClass(/open/);
    await expect(page.locator('#cmp-menu input[type="checkbox"]:checked')).toHaveCount(2);
    await page.locator('#cmp-menu .cmp-pick').filter({
      has: page.locator('input[type="checkbox"]:checked'),
    }).first().click();
    await expect.poll(() => viewerMode(page)).toBe('2d');
    await expect(page.locator('#cmp-grid')).not.toBeVisible();
    await page.keyboard.press('Escape');

    await forceManualCompareGroups(page);
    await page.locator('#btn-compare').click();
    await expect(page.locator('#cmp-grid')).toBeVisible();
    await page.locator('#cmp-menu .cmp-stop').click();
    await expect.poll(() => viewerMode(page)).toBe('2d');
    await expect(page.locator('#cmp-grid')).not.toBeVisible();
    expect(runtimeErrors).toEqual([]);
  });

  test('3D mode disables 2D display controls and keeps their keyboard shortcuts inert', async ({ page, runtimeErrors }) => {
    await openToolbarStudy(page);

    await page.locator('#btn-3d').click();
    await expect.poll(() => page.evaluate(async () => {
      const { state } = await import('/js/core/state.js');
      const { getThreeRuntime } = await import('/js/runtime/viewer-runtime.js');
      return { mode: state.mode, hasCamera: !!getThreeRuntime().camera };
    }), { timeout: 30_000 }).toEqual({ mode: '3d', hasCamera: true });
    await expect(page.locator('#btn-auto')).toBeDisabled();
    await expect(page.locator('#btn-invert')).toBeDisabled();
    await expect(page.locator('#cmap-trigger')).toBeDisabled();
    await expect(page.locator('#btn-zoomfit')).toBeEnabled();

    const displayBefore = await page.evaluate(async () => {
      const { state } = await import('/js/core/state.js');
      return { window: state.window, level: state.level, invertDisplay: state.invertDisplay };
    });
    await page.keyboard.press('a');
    await page.keyboard.press('i');
    await expect.poll(() => page.evaluate(async () => {
      const { state } = await import('/js/core/state.js');
      return { window: state.window, level: state.level, invertDisplay: state.invertDisplay };
    })).toEqual(displayBefore);

    await page.evaluate(async () => {
      const { getThreeRuntime } = await import('/js/runtime/viewer-runtime.js');
      const { camera } = getThreeRuntime();
      camera.position.set(2.4, 0, 0);
      camera.up.set(0, 0, 1);
      document.activeElement?.blur?.();
    });
    await page.keyboard.press('f');
    expect(await page.evaluate(async () => {
      const { camera } = (await import('/js/runtime/viewer-runtime.js')).getThreeRuntime();
      return {
        x: Number(camera.position.x.toFixed(3)),
        y: Number(camera.position.y.toFixed(3)),
        z: Number(camera.position.z.toFixed(3)),
        upY: Number(camera.up.y.toFixed(3)),
      };
    })).toEqual({ x: 1.469, y: 1.202, z: 1.469, upY: 1 });

    await page.locator('#btn-3d').click();
    await expect.poll(() => viewerMode(page)).toBe('2d');
    await expect(page.locator('#btn-auto')).toBeEnabled();
    await expect(page.locator('#btn-invert')).toBeEnabled();
    await expect(page.locator('#cmap-trigger')).toBeEnabled();
    expect(runtimeErrors).toEqual([]);
  });

  test('the compare picker stays keyboard operable and clamps long series names', async ({ page, runtimeErrors }) => {
    await openToolbarStudy(page);
    await page.evaluate(async () => {
      const { state } = await import('/js/core/state.js');
      state.cmpManualSlugs = null;
      state.manifest.series.forEach((series, index) => {
        series.group = `keyboard-picker-${index}`;
        series.frameOfReferenceUID = `keyboard-picker-${index}`;
        series.compareGroup = `keyboard-picker-${index}`;
      });
      document.activeElement?.blur?.();
    });

    await page.keyboard.press('c');
    await expect(page.locator('#cmp-dropdown')).toHaveClass(/open/);
    await expect(page.locator('#btn-compare')).not.toHaveAttribute('aria-haspopup', /.+/);
    await expect(page.locator('#btn-compare')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#cmp-menu')).toHaveAttribute('role', 'group');

    const compareMenu = await page.locator('#cmp-menu').evaluate((menu) => {
      const rows = [...menu.querySelectorAll('.cmp-pick')];
      const first = rows[0];
      const checkbox = first.querySelector('.ui-checkbox-toggle');
      const copy = first.querySelector('.cmp-pick-copy');
      const label = first.querySelector('.cmp-pick-name');
      const menuRect = menu.getBoundingClientRect();
      const rowRect = first.getBoundingClientRect();
      const checkboxRect = checkbox.getBoundingClientRect();
      const copyRect = copy.getBoundingClientRect();
      const menuStyle = getComputedStyle(menu);
      const tip = document.querySelector('.tip-bubble');
      return {
        rowCount: rows.length,
        menuBottom: Math.round(menuRect.bottom),
        viewportHeight: window.innerHeight,
        borderTopWidth: menuStyle.borderTopWidth,
        radius: menuStyle.borderRadius,
        rowRadius: getComputedStyle(first).borderRadius,
        rowHeight: Math.round(rowRect.height),
        leftInset: Math.round(checkboxRect.left - rowRect.left),
        labelGap: Math.round(copyRect.left - checkboxRect.right),
        labelRightPad: Math.round(rowRect.right - copyRect.right),
        textOverflow: getComputedStyle(label).textOverflow,
        tooltipVisible: !!tip && !tip.hidden && tip.classList.contains('visible'),
      };
    });
    expect(compareMenu.rowCount).toBeGreaterThan(1);
    expect(compareMenu.menuBottom).toBeLessThanOrEqual(compareMenu.viewportHeight);
    expect(compareMenu.borderTopWidth).toBe('0px');
    expect(compareMenu.radius).toBe('10px');
    expect(compareMenu.rowRadius).toBe('6px');
    expect(compareMenu.rowHeight).toBe(42);
    expect(compareMenu.leftInset).toBe(8);
    expect(compareMenu.labelGap).toBe(8);
    expect(compareMenu.labelRightPad).toBeGreaterThanOrEqual(10);
    expect(compareMenu.textOverflow).toBe('ellipsis');
    expect(compareMenu.tooltipVisible).toBe(false);

    const stickyHead = await page.locator('#cmp-menu').evaluate((menu) => {
      const head = menu.querySelector('.cmp-menu-head');
      menu.style.maxHeight = '96px';
      const restGap = Math.round(head.getBoundingClientRect().top - menu.getBoundingClientRect().top);
      menu.scrollTop = Math.max(1, menu.scrollHeight - menu.clientHeight);
      const menuRect = menu.getBoundingClientRect();
      const headRect = head.getBoundingClientRect();
      const hit = document.elementFromPoint(menuRect.left + menuRect.width / 2, menuRect.top + 2);
      return {
        restGap,
        scrolledGap: Math.round(headRect.top - menuRect.top),
        hitHead: Boolean(hit?.closest('.cmp-menu-head')),
      };
    });
    expect(stickyHead).toEqual({ restGap: 0, scrolledGap: 0, hitHead: true });

    const longNameMenu = await page.locator('#cmp-menu').evaluate((menu) => {
      const row = menu.querySelector('.cmp-pick');
      row.querySelector('.cmp-pick-name').textContent = 'Very long imported DICOM series description with scanner sequence details and acquisition suffix';
      const menuRect = menu.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const labelRect = row.querySelector('.cmp-pick-copy').getBoundingClientRect();
      return {
        menuWidth: Math.round(menuRect.width),
        rowWidth: Math.round(rowRect.width),
        labelRight: Math.round(labelRect.right),
        rowRight: Math.round(rowRect.right),
      };
    });
    expect(longNameMenu.menuWidth).toBeLessThanOrEqual(232);
    expect(longNameMenu.rowWidth).toBeLessThanOrEqual(230);
    expect(longNameMenu.labelRight).toBeLessThanOrEqual(longNameMenu.rowRight);

    await page.keyboard.press('Escape');
    await expect(page.locator('#cmp-dropdown')).not.toHaveClass(/open/);
    await expect(page.locator('#btn-compare')).toHaveAttribute('aria-expanded', 'false');
    await page.locator('#btn-compare').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#cmp-dropdown')).toHaveClass(/open/);
    await expect(page.locator('#btn-compare')).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => page.locator('#cmp-menu input[type="checkbox"]').first().evaluate((input) => ({
      focused: document.activeElement === input,
      checked: input.checked,
    }))).toMatchObject({ focused: true });
    const firstChecked = await page.locator('#cmp-menu input[type="checkbox"]').first().isChecked();
    await page.keyboard.press('Space');
    await expect.poll(() => page.locator('#cmp-menu input[type="checkbox"]').first().isChecked()).toBe(!firstChecked);
    expect(runtimeErrors).toEqual([]);
  });
});

test('sidebar toggles keep the active 3D canvas stable', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('mri-viewer/shellLayout/v1'));
  await openLocalStudy(page, [localVolumeSeries('sidebar_3d_volume', 'Sidebar 3D Volume')]);

  await page.locator('#series-list li').first().click();
  await page.locator('#btn-3d').click();
  await expect(page.locator('#three-container.active canvas')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(async () => (
    Boolean((await import('/js/runtime/viewer-runtime.js')).getThreeRuntime().mesh)
  )), { timeout: 30_000 }).toBe(true);

  await page.evaluate(() => {
    window.__sidebarResizeEvents = 0;
    window.__sidebarThreeCanvas = document.querySelector('#three-container canvas');
    window.addEventListener('resize', () => {
      window.__sidebarResizeEvents += 1;
    });
  });

  await page.locator('#btn-toggle-left').click();
  await expect(page.locator('.app')).toHaveClass(/left-collapsed/);
  await expect(page.locator('#three-container.active canvas')).toBeVisible();
  await page.locator('#btn-show-left').click();
  await expect(page.locator('.app')).not.toHaveClass(/left-collapsed/);

  await page.locator('#btn-toggle-right').click();
  await expect(page.locator('.app')).toHaveClass(/right-collapsed/);
  await expect(page.locator('#three-container.active canvas')).toBeVisible();
  await page.locator('#btn-show-right').click();
  await expect(page.locator('.app')).not.toHaveClass(/right-collapsed/);

  await expect.poll(() => page.evaluate(() => {
    const container = document.getElementById('three-container');
    const canvas = container?.querySelector('canvas');
    return {
      active: container?.classList.contains('active') || false,
      sameCanvas: canvas === window.__sidebarThreeCanvas,
      resizeEvents: window.__sidebarResizeEvents,
      painted: Math.min(canvas?.clientWidth || 0, canvas?.clientHeight || 0) > 0,
    };
  })).toEqual({ active: true, sameCanvas: true, resizeEvents: 0, painted: true });
});

test('toasts do not cover an open compare menu or the MPR toolbar', async ({ page }) => {
  await openLocalStudy(page, [
    localVolumeSeries('toast_chrome_a', 'Toast Chrome A'),
    localVolumeSeries('toast_chrome_b', 'Toast Chrome B'),
    localVolumeSeries('toast_chrome_c', 'Toast Chrome C'),
    localVolumeSeries('toast_chrome_d', 'Toast Chrome D'),
    localVolumeSeries('toast_chrome_e', 'Toast Chrome E'),
    localVolumeSeries('toast_chrome_f', 'Toast Chrome F'),
  ], { viewport: { width: 1400, height: 900 } });
  await page.locator('#series-list li').first().click();
  await dismissOnboardingHint(page);

  await page.locator('#btn-compare').click();
  await expect(page.locator('#cmp-dropdown')).toHaveClass(/open/);
  await page.evaluate(async () => {
    const { notify } = await import('/js/notify.js');
    notify('Toast over compare menu', { kind: 'info', duration: 120000, id: 'toast-chrome' });
  });
  await expect(page.locator('#notify-container .notify-item')).toBeVisible();
  const menuHit = await page.evaluate(() => {
    const toast = document.querySelector('#notify-container .notify-item');
    const toastRect = toast.getBoundingClientRect();
    const cx = toastRect.x + toastRect.width / 2;
    const cy = toastRect.y + toastRect.height / 2;
    const top = document.elementFromPoint(cx, cy);
    const menuCoversToast = [...document.querySelectorAll('#cmp-menu .cmp-pick, #cmp-menu')].some((el) => {
      const r = el.getBoundingClientRect();
      return r.left <= cx && r.right >= cx && r.top <= cy && r.bottom >= cy;
    });
    return {
      menuCoversToast,
      hitMenu: Boolean(top?.closest('#cmp-menu')),
      hitToast: Boolean(top?.closest('.notify-item')),
      toastZ: Number(getComputedStyle(document.getElementById('notify-container')).zIndex),
      toolbarZ: Number(getComputedStyle(document.getElementById('toolbar-root')).zIndex),
    };
  });
  expect(menuHit.toastZ).toBeLessThan(menuHit.toolbarZ);
  expect(menuHit.menuCoversToast).toBe(true);
  expect(menuHit.hitToast).toBe(false);
  expect(menuHit.hitMenu).toBe(true);

  await page.locator('#toolbox-measure .toolbox-trigger').click();
  await expect(page.locator('#toolbox-measure')).toHaveClass(/open/);
  const toolsHit = await page.evaluate(() => {
    const toast = document.querySelector('#notify-container .notify-item');
    const panel = document.querySelector('#toolbox-measure .toolbox-panel');
    if (!toast || !panel) return { panel: false };
    const a = toast.getBoundingClientRect();
    const b = panel.getBoundingClientRect();
    const x = Math.min(a.right, b.right) - 8;
    const y = Math.min(a.bottom, b.bottom) - 8;
    const overlaps = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 8
      && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 8;
    const top = document.elementFromPoint(x, y);
    return {
      panel: true,
      overlaps,
      hitPanel: Boolean(top?.closest('#toolbox-measure .toolbox-panel')),
      hitToast: Boolean(top?.closest('.notify-item')),
    };
  });
  if (toolsHit.overlaps) {
    expect(toolsHit.hitToast).toBe(false);
    expect(toolsHit.hitPanel).toBe(true);
  }

  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    document.querySelectorAll('#notify-container .notify-item').forEach((el) => el.remove());
  });

  await page.locator('#btn-mpr').click();
  await waitForMprVolumeReady(page);
  await page.evaluate(async () => {
    const { notify } = await import('/js/notify.js');
    notify('Toast over MPR toolbar', { kind: 'info', duration: 120000, id: 'toast-chrome' });
  });
  const mprHit = await page.evaluate(() => {
    const toast = document.querySelector('#notify-container .notify-item');
    const toolbar = document.getElementById('mpr-toolbar-wrap');
    const a = toast.getBoundingClientRect();
    const b = toolbar.getBoundingClientRect();
    return {
      overlap: Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
        && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1,
      toastBottom: a.bottom,
      toolbarTop: b.top,
    };
  });
  expect(mprHit.overlap).toBe(false);
  expect(mprHit.toastBottom).toBeLessThanOrEqual(mprHit.toolbarTop + 1);
});

test('toasts stay above the bottom toolbar and clear the open right rail', async ({ page }) => {
  await openLocalStudy(page, [
    localVolumeSeries('toast_geometry_a', 'Toast Geometry A'),
    localVolumeSeries('toast_geometry_b', 'Toast Geometry B'),
  ], { viewport: { width: 1400, height: 900 } });
  await page.locator('#series-list li').first().click();
  await dismissOnboardingHint(page);

  const showToast = async () => {
    await page.evaluate(async () => {
      const { notify } = await import('/js/notify.js');
      notify('Toast placement probe', { kind: 'info', duration: 120000, id: 'toast-geometry' });
    });
    await expect(page.locator('#notify-container .notify-item')).toBeVisible();
  };

  const placement = async () => page.evaluate(() => {
    const toast = document.querySelector('#notify-container .notify-item').getBoundingClientRect();
    const toolbar = document.getElementById('toolbar-root').getBoundingClientRect();
    const rail = document.getElementById('right-panels-root');
    const railRect = rail?.getBoundingClientRect();
    const railVisible = !!railRect && railRect.width > 0 && getComputedStyle(rail).display !== 'none';
    return {
      toastTop: Math.round(toast.top),
      toastBottom: Math.round(toast.bottom),
      toastLeft: Math.round(toast.left),
      toastRight: Math.round(toast.right),
      toolbarTop: Math.round(toolbar.top),
      railLeft: railVisible ? Math.round(railRect.left) : null,
      railVisible,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });

  await showToast();
  const expanded = await placement();
  expect(expanded.railVisible, JSON.stringify(expanded)).toBe(true);
  expect(expanded.toastBottom, JSON.stringify(expanded)).toBeLessThanOrEqual(expanded.toolbarTop);
  expect(expanded.toastRight, JSON.stringify(expanded)).toBeLessThanOrEqual(expanded.railLeft);
  expect(expanded.toastLeft, JSON.stringify(expanded)).toBeGreaterThanOrEqual(0);
  expect(expanded.toastTop, JSON.stringify(expanded)).toBeGreaterThanOrEqual(0);

  await page.locator('#btn-toggle-right').click();
  await expect(page.locator('.app')).toHaveClass(/right-collapsed/);
  const collapsed = await placement();
  expect(collapsed.toastRight, JSON.stringify({ expanded, collapsed })).toBeGreaterThan(expanded.toastRight);
  expect(collapsed.toastRight, JSON.stringify(collapsed)).toBeLessThanOrEqual(collapsed.viewportWidth);
  expect(collapsed.toastBottom, JSON.stringify(collapsed)).toBeLessThanOrEqual(collapsed.toolbarTop);
  await page.locator('#btn-show-right').click();
  await expect(page.locator('.app')).not.toHaveClass(/right-collapsed/);

  await page.locator('#btn-mpr').click();
  await waitForMprVolumeReady(page);
  const mpr = await placement();
  expect(mpr.toastBottom, JSON.stringify({ expanded, mpr })).toBeLessThan(expanded.toastBottom);
  expect(mpr.toastBottom, JSON.stringify(mpr)).toBeLessThanOrEqual(
    Math.round((await page.locator('#mpr-toolbar-wrap').boundingBox()).y),
  );

  const stacking = async () => page.evaluate(() => ({
    toastZ: Number(getComputedStyle(document.getElementById('notify-container')).zIndex),
    toolbarZ: Number(getComputedStyle(document.getElementById('toolbar-root')).zIndex),
  }));
  const closedMenus = await stacking();
  expect(closedMenus.toastZ, JSON.stringify(closedMenus)).toBeGreaterThan(closedMenus.toolbarZ);

  await page.locator('#toolbox-measure .toolbox-trigger').click();
  await expect(page.locator('#toolbox-measure')).toHaveClass(/open/);
  const openMenu = await stacking();
  expect(openMenu.toastZ, JSON.stringify(openMenu)).toBeLessThan(openMenu.toolbarZ);
  const panelHit = await page.evaluate(() => {
    const toast = document.querySelector('#notify-container .notify-item').getBoundingClientRect();
    const panel = document.querySelector('#toolbox-measure .toolbox-panel').getBoundingClientRect();
    const overlapWidth = Math.min(toast.right, panel.right) - Math.max(toast.left, panel.left);
    const overlapHeight = Math.min(toast.bottom, panel.bottom) - Math.max(toast.top, panel.top);
    if (overlapWidth <= 8 || overlapHeight <= 8) return { overlaps: false };
    const top = document.elementFromPoint(
      Math.min(toast.right, panel.right) - 8,
      Math.min(toast.bottom, panel.bottom) - 8,
    );
    return {
      overlaps: true,
      hitPanel: Boolean(top?.closest('#toolbox-measure .toolbox-panel')),
      hitToast: Boolean(top?.closest('.notify-item')),
    };
  });
  if (panelHit.overlaps) {
    expect(panelHit.hitToast, JSON.stringify(panelHit)).toBe(false);
    expect(panelHit.hitPanel, JSON.stringify(panelHit)).toBe(true);
  }
});
