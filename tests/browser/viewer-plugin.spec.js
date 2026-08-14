import { expect, test } from '@playwright/test';

test('plugin panels live inside the right-sidebar scroll owner', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.voxellabControlsReady === 'true');

  await page.locator('.right-panel-scroll').evaluate((scroll) => {
    scroll.style.flex = 'none';
    scroll.style.height = '240px';
  });

  await page.evaluate(async () => {
    const { registerPlugin } = await import('/js/plugin.js');
    registerPlugin({
      name: 'scroll-panel-proof',
      init(api) {
        api.addPanel({
          id: 'scroll-panel-proof',
          title: 'Scroll proof',
          render(root) {
            root.append(...Array.from({ length: 120 }, (_, index) => {
              const row = document.createElement('p');
              row.textContent = `Plugin row ${index + 1}`;
              return row;
            }));
          },
        });
      },
    });
  });

  const panel = page.locator('[data-panel="scroll-panel-proof"]');
  await expect(panel).toBeAttached();
  await expect(panel.locator('.sec-title')).toBeVisible();
  await panel.locator('.sec-title').click();
  const scrollState = await page.locator('.right-panel-scroll').evaluate((scroll) => {
    scroll.scrollTop = scroll.scrollHeight;
    return {
      panelParent: document.querySelector('[data-panel="scroll-panel-proof"]')?.parentElement === scroll,
      scrollTop: scroll.scrollTop,
      scrollable: scroll.scrollHeight > scroll.clientHeight,
    };
  });
  expect(scrollState.panelParent).toBe(true);
  expect(scrollState.scrollable).toBe(true);
  expect(scrollState.scrollTop).toBeGreaterThan(0);
});
