import { expect, test } from '@playwright/test';

async function canvasSamples(page, selector = '#view') {
  return page.evaluate((sel) => {
    const canvas = document.querySelector(sel);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const points = [
      [Math.floor(canvas.width * 0.5), Math.floor(canvas.height * 0.5)],
      [Math.floor(canvas.width * 0.45), Math.floor(canvas.height * 0.45)],
      [Math.floor(canvas.width * 0.6), Math.floor(canvas.height * 0.55)],
    ];
    return points.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data));
  }, selector);
}

async function canvasSignature(page, selector) {
  return page.evaluate((sel) => {
    const canvas = document.querySelector(sel);
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
  }, selector);
}

async function waitForMprVolumeReady(page) {
  await expect.poll(async () => page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return {
      mode: state.mode,
      ready: !!(state.hrVoxels || state.voxels),
    };
  }), { timeout: 30_000 }).toMatchObject({ mode: 'mpr', ready: true });
}

test('display toolbar controls update render state and compare picker stays polished', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.ok()) return;
    if (response.url().includes('config.local.json')) return;
    if (response.url().endsWith('_asks.json')) return;
    errors.push(`${response.status()} ${response.url()}`);
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (message.text().includes('Failed to load resource')) return;
    if (message.location().url.includes('config.local.json')) return;
    errors.push(message.text());
  });

  const response = await page.goto('/?localBackend=1', { waitUntil: 'domcontentloaded' });
  expect(response && response.ok(), `root response status: ${response && response.status()}`).toBe(true);
  const manifest = await page.evaluate(() => fetch('/data/manifest.json').then(r => r.json()));
  const localVolumeIndex = manifest.series.findIndex((series) => series.slug === 'demo_on01802_dwi');
  test.skip(localVolumeIndex < 0, 'OpenNeuro DWI demo volume is not available');
  await page.locator('#series-list li').nth(localVolumeIndex).click();
  await expect(page.locator('#series-name')).toHaveText(manifest.series[localVolumeIndex].name);
  await expect(page.locator('#view')).toBeVisible();
  await expect.poll(() => page.locator('#view').evaluate((canvas) => canvas.width * canvas.height)).toBeGreaterThan(0);

  const before = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return { window: state.window, level: state.level, invertDisplay: state.invertDisplay, zoom: state.zoom };
  });

  await page.locator('#btn-auto').click();
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return `${state.window}/${state.level}`;
  })).not.toBe(`${before.window}/${before.level}`);
  await expect(page.locator('#wl-readout')).toHaveText(/\d+ \/ \d+/);
  const afterAuto = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return { window: state.window, level: state.level };
  });
  await expect(page.locator('#mr-presets [data-mrpreset].active')).toHaveCount(0);
  await page.evaluate(() => {
    const view = document.getElementById('view');
    view.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, clientY: 100, bubbles: true, button: 0, shiftKey: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 110, clientY: 94, bubbles: true, shiftKey: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 110, clientY: 94, bubbles: true, shiftKey: true }));
  });
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return { window: state.window, level: state.level };
  })).toEqual({
    window: Math.min(512, afterAuto.window + 10),
    level: Math.min(255, afterAuto.level + 6),
  });

  const preInvert = await canvasSamples(page);
  await page.locator('#btn-invert').click();
  await expect(page.locator('#btn-invert')).toHaveClass(/active/);
  const afterInvert = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return {
      invertDisplay: state.invertDisplay,
      filter: getComputedStyle(document.querySelector('#view')).filter,
    };
  });
  expect(afterInvert).toEqual({ invertDisplay: true, filter: 'none' });
  expect(await canvasSamples(page)).not.toEqual(preInvert);
  await expect(page.locator('#mr-presets')).toBeVisible();
  await page.locator('#mr-presets [data-mrpreset="contrast"]').click();
  await expect(page.locator('#mr-presets [data-mrpreset="contrast"]')).toHaveClass(/active/);
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return { window: state.window, level: state.level };
  })).toEqual({ window: 150, level: 90 });
  await page.evaluate(() => {
    const view = document.getElementById('view');
    view.dispatchEvent(new MouseEvent('mousedown', { clientX: 50, clientY: 50, bubbles: true, button: 0, shiftKey: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 58, clientY: 47, bubbles: true, shiftKey: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 58, clientY: 47, bubbles: true, shiftKey: true }));
  });
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return { window: state.window, level: state.level };
  })).toEqual({ window: 158, level: 93 });
  await expect(page.locator('#mr-presets [data-mrpreset="contrast"]')).not.toHaveClass(/active/);

  await page.locator('#btn-zoomfit').click();
  const fit = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return { zoom: state.zoom, tx: state.tx, ty: state.ty };
  });
  expect(fit.zoom).toBeGreaterThan(0);
  expect(fit.tx).toBe(0);
  expect(fit.ty).toBe(0);

  await page.locator('#cmap-trigger').click();
  await page.locator('#cmap-menu .dd-item', { hasText: 'Hot' }).click();
  await expect(page.locator('#cmap-label')).toHaveText('Hot');
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return state.colormap;
  })).toBe('hot');

  await page.locator('#btn-mpr').click();
  await expect(page.locator('#mpr-ax')).toBeVisible();
  await waitForMprVolumeReady(page);
  await expect.poll(async () => (await canvasSignature(page, '#mpr-ax')).nonBlack).toBeGreaterThan(0);
  const mprHot = await canvasSignature(page, '#mpr-ax');
  expect(mprHot.nonBlack, `MPR stayed blank before display changes: ${JSON.stringify(mprHot)}`).toBeGreaterThan(0);
  await page.evaluate(async () => {
    const { setMprViewport } = await import('/js/state/viewer-commands.js');
    setMprViewport('ax', { zoom: 2, tx: 14, ty: -8 });
    setMprViewport('co', { zoom: 2.5, tx: -9, ty: 6 });
  });
  await page.locator('#btn-zoomfit').click();
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return {
      ax: state.mpr.viewports.ax,
      co: state.mpr.viewports.co,
    };
  })).toEqual({
    ax: { zoom: 1, tx: 0, ty: 0 },
    co: { zoom: 1, tx: 0, ty: 0 },
  });
  await page.locator('#btn-invert').click();
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return state.invertDisplay;
  })).toBe(false);
  const mprHotInverted = await canvasSignature(page, '#mpr-ax');
  expect(mprHotInverted.checksum).not.toBe(mprHot.checksum);
  await page.locator('#cmap-trigger').click();
  await page.locator('#cmap-menu .dd-item', { hasText: 'Grayscale' }).click();
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return state.colormap;
  })).toBe('grayscale');
  const mprGray = await canvasSignature(page, '#mpr-ax');
  expect(mprGray.checksum).not.toBe(mprHotInverted.checksum);
  await page.locator('#btn-mpr').click();
  await expect(page.locator('#mpr-ax')).not.toBeVisible();

  await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const current = state.manifest.series[state.seriesIdx]?.slug;
    const peer = state.manifest.series.find((series) => series.slug !== current)?.slug;
    state.manifest.series.forEach((series, index) => {
      series.group = `manual-compare-${index}`;
      series.frameOfReferenceUID = `manual-compare-${index}`;
      series.compareGroup = `manual-compare-${index}`;
    });
    state.cmpManualSlugs = [current, peer].filter(Boolean);
  });
  await page.locator('#btn-compare').click();
  await expect(page.locator('#cmp-grid')).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return state.mode;
  })).toBe('cmp');
  await page.evaluate(async () => {
    const { setWindowLevel } = await import('/js/state/viewer-commands.js');
    setWindowLevel(120, 70);
    const grid = document.getElementById('cmp-grid');
    grid.dispatchEvent(new MouseEvent('mousedown', { clientX: 80, clientY: 80, bubbles: true, button: 0 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 86, clientY: 76, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 86, clientY: 76, bubbles: true }));
  });
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return { window: state.window, level: state.level };
  })).toEqual({ window: 126, level: 74 });
  await page.evaluate(async () => {
    const { setCompareViewport } = await import('/js/state/viewer-commands.js');
    setCompareViewport({ zoom: 2.5, tx: 18, ty: -12 });
  });
  await page.locator('#btn-zoomfit').click();
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return state.compare.viewport;
  })).toEqual({ zoom: 1, tx: 0, ty: 0 });

  await page.locator('#btn-compare').click({ button: 'right' });
  await expect(page.locator('#cmp-dropdown')).toHaveClass(/open/);
  await expect(page.locator('#cmp-menu input[type="checkbox"]:checked')).toHaveCount(2);
  await page.locator('#cmp-menu .cmp-pick').filter({
    has: page.locator('input[type="checkbox"]:checked'),
  }).first().click();
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return state.mode;
  })).toBe('2d');
  await expect(page.locator('#cmp-grid')).not.toBeVisible();
  await page.keyboard.press('Escape');

  await page.locator('#btn-3d').click();
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    const { getThreeRuntime } = await import('/js/runtime/viewer-runtime.js');
    return { mode: state.mode, hasCamera: !!getThreeRuntime().camera };
  }), { timeout: 30_000 }).toEqual({ mode: '3d', hasCamera: true });
  await expect(page.locator('#btn-auto')).toBeDisabled();
  await expect(page.locator('#btn-invert')).toBeDisabled();
  await expect(page.locator('#cmap-trigger')).toBeDisabled();
  await expect(page.locator('#btn-zoomfit')).toBeEnabled();
  const threeDisplayBefore = await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return { window: state.window, level: state.level, invertDisplay: state.invertDisplay };
  });
  await page.keyboard.press('a');
  await page.keyboard.press('i');
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return { window: state.window, level: state.level, invertDisplay: state.invertDisplay };
  })).toEqual(threeDisplayBefore);
  await page.evaluate(async () => {
    const { getThreeRuntime } = await import('/js/runtime/viewer-runtime.js');
    const { camera } = getThreeRuntime();
    camera.position.set(2.4, 0, 0);
    camera.up.set(0, 0, 1);
    document.activeElement?.blur?.();
  });
  await page.keyboard.press('f');
  const threeFit = await page.evaluate(async () => {
    const { getThreeRuntime } = await import('/js/runtime/viewer-runtime.js');
    const { camera } = getThreeRuntime();
    return {
      x: Number(camera.position.x.toFixed(3)),
      y: Number(camera.position.y.toFixed(3)),
      z: Number(camera.position.z.toFixed(3)),
      upY: Number(camera.up.y.toFixed(3)),
    };
  });
  expect(threeFit).toEqual({ x: 1.469, y: 1.202, z: 1.469, upY: 1 });
  await page.locator('#btn-3d').click();
  await expect.poll(() => page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return state.mode;
  })).toBe('2d');
  await expect(page.locator('#btn-auto')).toBeEnabled();
  await expect(page.locator('#btn-invert')).toBeEnabled();
  await expect(page.locator('#cmap-trigger')).toBeEnabled();

  await page.evaluate(async () => {
    const { state } = await import('/js/state.js');
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
    const label = first.children[1];
    const menuRect = menu.getBoundingClientRect();
    const rowRect = first.getBoundingClientRect();
    const checkboxRect = checkbox.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    const menuStyle = getComputedStyle(menu);
    const rowStyle = getComputedStyle(first);
    const labelStyle = getComputedStyle(label);
    const tip = document.querySelector('.tip-bubble');
    return {
      rowCount: rows.length,
      menuBottom: Math.round(menuRect.bottom),
      viewportHeight: window.innerHeight,
      borderTopWidth: menuStyle.borderTopWidth,
      radius: menuStyle.borderRadius,
      rowRadius: rowStyle.borderRadius,
      rowHeight: Math.round(rowRect.height),
      leftInset: Math.round(checkboxRect.left - rowRect.left),
      labelGap: Math.round(labelRect.left - checkboxRect.right),
      labelRightPad: Math.round(rowRect.right - labelRect.right),
      textOverflow: labelStyle.textOverflow,
      tooltipVisible: !!tip && !tip.hidden && tip.classList.contains('visible'),
    };
  });
  expect(compareMenu.rowCount).toBeGreaterThan(1);
  expect(compareMenu.menuBottom).toBeLessThanOrEqual(compareMenu.viewportHeight);
  expect(compareMenu.borderTopWidth).toBe('0px');
  expect(compareMenu.radius).toBe('6px');
  expect(compareMenu.rowRadius).toBe('4px');
  expect(compareMenu.rowHeight).toBe(30);
  expect(compareMenu.leftInset).toBe(8);
  expect(compareMenu.labelGap).toBe(8);
  expect(compareMenu.labelRightPad).toBeGreaterThanOrEqual(10);
  expect(compareMenu.textOverflow).toBe('ellipsis');
  expect(compareMenu.tooltipVisible).toBe(false);

  const longNameMenu = await page.locator('#cmp-menu').evaluate((menu) => {
    const row = menu.querySelector('.cmp-pick');
    row.children[1].textContent = 'Very long imported DICOM series description with scanner sequence details and acquisition suffix';
    const menuRect = menu.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const labelRect = row.children[1].getBoundingClientRect();
    return {
      menuWidth: Math.round(menuRect.width),
      rowWidth: Math.round(rowRect.width),
      labelRight: Math.round(labelRect.right),
      rowRight: Math.round(rowRect.right),
    };
  });
  expect(longNameMenu.menuWidth).toBeLessThanOrEqual(198);
  expect(longNameMenu.rowWidth).toBeLessThanOrEqual(196);
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

  expect(errors).toEqual([]);
});
