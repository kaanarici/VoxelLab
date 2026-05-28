import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

async function launchVoxelLab(extraArgs = []) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-electron-smoke-'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(tempDir, 'profile')}`, ...extraArgs],
    cwd: REPO_ROOT,
  });
  const page = await app.firstWindow({ timeout: 20_000 });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForFunction(() => (
    document.readyState !== 'loading'
    && document.getElementById('canvas-wrap')
    && document.getElementById('view')
    && document.getElementById('empty-state')
    && typeof globalThis.voxellabDesktop === 'object'
  ), null, { timeout: 20_000 });
  return { app, page, pageErrors, tempDir };
}

async function closeApp(app) {
  try {
    await app.close();
  } catch {
    // The Electron process may already be closing after a failed launch assertion.
  }
}

async function assertShellFits(page) {
  const metrics = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    bodyScrollWidth: document.body.scrollWidth,
    bodyScrollHeight: document.body.scrollHeight,
    viewRect: document.getElementById('view')?.getBoundingClientRect().toJSON?.(),
    emptyStateRect: document.getElementById('empty-state')?.getBoundingClientRect().toJSON?.(),
  }));
  assert.ok(metrics.width >= 1024);
  assert.ok(metrics.height >= 720);
  assert.ok(metrics.scrollWidth <= metrics.width + 1, `document overflow: ${metrics.scrollWidth} > ${metrics.width}`);
  assert.ok(metrics.bodyScrollWidth <= metrics.width + 1, `body overflow: ${metrics.bodyScrollWidth} > ${metrics.width}`);
  assert.ok(metrics.scrollHeight <= metrics.height + 1, `document vertical overflow: ${metrics.scrollHeight} > ${metrics.height}`);
  assert.ok(metrics.bodyScrollHeight <= metrics.height + 1, `body vertical overflow: ${metrics.bodyScrollHeight} > ${metrics.height}`);
  assert.ok(metrics.viewRect, 'missing viewer canvas');
  assert.ok(metrics.viewRect.bottom <= metrics.height + 1, `viewer canvas overflows: ${metrics.viewRect.bottom} > ${metrics.height}`);
  if (metrics.emptyStateRect && metrics.emptyStateRect.width > 0) {
    assert.ok(metrics.emptyStateRect.bottom <= metrics.height + 1, `empty state overflows: ${metrics.emptyStateRect.bottom} > ${metrics.height}`);
  }
}

async function assertMacWindowControlsAvoidSidebar(page, app) {
  const chrome = await page.evaluate(() => ({
    isMac: document.documentElement.classList.contains('desktop-macos'),
    fullscreen: document.documentElement.classList.contains('desktop-fullscreen'),
    inset: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--desktop-window-control-inset')) || 0,
    leftHeaderPadding: parseFloat(getComputedStyle(document.querySelector('.sidebar-header-left')).paddingLeft) || 0,
    leftToggleLeft: document.getElementById('btn-toggle-left')?.getBoundingClientRect().left || 0,
  }));
  if (process.platform !== 'darwin') {
    assert.equal(chrome.isMac, false);
    return;
  }
  assert.equal(chrome.isMac, true);
  assert.equal(chrome.fullscreen, false);
  assert.ok(chrome.inset >= 80, `macOS traffic-light inset too small: ${chrome.inset}`);
  assert.ok(chrome.leftHeaderPadding >= chrome.inset, `sidebar padding ${chrome.leftHeaderPadding} < inset ${chrome.inset}`);
  assert.ok(chrome.leftToggleLeft >= chrome.inset, `sidebar toggle overlaps traffic-light zone: ${chrome.leftToggleLeft} < ${chrome.inset}`);

  await page.click('#btn-toggle-left');
  await page.waitForFunction(() => document.querySelector('.app')?.classList.contains('left-collapsed'), null, { timeout: 5_000 });
  const collapsedChrome = await page.evaluate(() => ({
    viewerHeaderPadding: parseFloat(getComputedStyle(document.getElementById('viewer-header')).paddingLeft) || 0,
    showLeftButtonLeft: document.getElementById('btn-show-left')?.getBoundingClientRect().left || 0,
  }));
  assert.ok(collapsedChrome.viewerHeaderPadding >= chrome.inset, `collapsed viewer header padding ${collapsedChrome.viewerHeaderPadding} < inset ${chrome.inset}`);
  assert.ok(collapsedChrome.showLeftButtonLeft >= chrome.inset, `show-sidebar button overlaps traffic-light zone: ${collapsedChrome.showLeftButtonLeft} < ${chrome.inset}`);

  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.focus();
    if (process.platform === 'darwin') window.setSimpleFullScreen(true);
    else window.setFullScreen(true);
  });
  await page.waitForFunction(() => document.documentElement.classList.contains('desktop-fullscreen'), null, { timeout: 10_000 });
  const fullscreenChrome = await page.evaluate(() => ({
    leftHeaderPadding: parseFloat(getComputedStyle(document.querySelector('.sidebar-header-left')).paddingLeft) || 0,
    viewerHeaderPadding: parseFloat(getComputedStyle(document.getElementById('viewer-header')).paddingLeft) || 0,
    showLeftButtonLeft: document.getElementById('btn-show-left')?.getBoundingClientRect().left || 0,
  }));
  assert.ok(fullscreenChrome.leftHeaderPadding < chrome.leftHeaderPadding, 'sidebar controls should move left in fullscreen');
  assert.ok(fullscreenChrome.viewerHeaderPadding < collapsedChrome.viewerHeaderPadding, 'viewer header should not keep the traffic-light inset in fullscreen');
  assert.ok(fullscreenChrome.showLeftButtonLeft < chrome.inset, 'show-sidebar button should move left in fullscreen');
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.focus();
    if (process.platform === 'darwin') window.setSimpleFullScreen(false);
    else window.setFullScreen(false);
  });
  await page.waitForFunction(() => !document.documentElement.classList.contains('desktop-fullscreen'), null, { timeout: 10_000 });
  await page.click('#btn-show-left');
  await page.waitForFunction(() => !document.querySelector('.app')?.classList.contains('left-collapsed'), null, { timeout: 5_000 });
}

test('Electron runtime boots the hardened renderer and native menu bridge', async () => {
  const { app, page, pageErrors } = await launchVoxelLab();
  try {
    await page.waitForLoadState('domcontentloaded');
    const renderer = await page.evaluate(async () => ({
      href: window.location.href,
      title: document.title,
      requireType: typeof globalThis.require,
      processType: typeof globalThis.process,
      desktopType: typeof globalThis.voxellabDesktop,
      desktopKeys: Object.keys(globalThis.voxellabDesktop).sort(),
      appInfo: await globalThis.voxellabDesktop.getAppInfo(),
      emptyStateVisible: getComputedStyle(document.getElementById('empty-state')).display !== 'none',
      viewerVisible: getComputedStyle(document.getElementById('view')).display !== 'none',
    }));

    assert.equal(renderer.href, 'voxellab://app/index.html');
    assert.equal(renderer.title, 'VoxelLab');
    assert.equal(renderer.requireType, 'undefined');
    assert.equal(renderer.processType, 'undefined');
    assert.equal(renderer.desktopType, 'object');
    assert.ok(renderer.desktopKeys.includes('readFileRange'));
    assert.ok(renderer.desktopKeys.includes('getConverterCapabilities'));
    assert.ok(renderer.desktopKeys.includes('startConversionJob'));
    assert.equal(renderer.desktopKeys.includes('readFiles'), false);
    assert.equal(renderer.appInfo.appUrl, 'voxellab://app/index.html');
    assert.equal(renderer.appInfo.name, 'VoxelLab');
    assert.equal(renderer.emptyStateVisible || renderer.viewerVisible, true);
    await assertMacWindowControlsAvoidSidebar(page, app);

    const menu = await app.evaluate(({ BrowserWindow, Menu }) => {
      const file = Menu.getApplicationMenu()?.items.find(item => item.label === 'File');
      const upload = file?.submenu?.items.find(item => item.label === 'Upload Study Panel');
      upload?.click(undefined, BrowserWindow.getAllWindows()[0], undefined);
      return file?.submenu?.items.map(item => item.label || item.role || item.type) || [];
    });
    assert.ok(menu.includes('Open Images...'));
    assert.ok(menu.includes('Open Folder...'));
    assert.ok(menu.includes('Upload Study Panel'));
    await page.waitForSelector('#upload-modal.visible', { timeout: 5_000 });
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});

test('Electron runtime delivers queued launch paths after renderer bridge readiness', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-open-path-'));
  const unsupported = path.join(tempDir, 'notes.md');
  await fs.writeFile(unsupported, 'notes');

  const { app, page, pageErrors } = await launchVoxelLab([unsupported]);
  try {
    await page.waitForSelector('#confirm-modal.visible', { timeout: 10_000 });
    await page.waitForSelector('#upload-modal.visible', { timeout: 10_000 });
    const dialog = await page.evaluate(() => ({
      title: document.getElementById('confirm-title')?.textContent,
      body: document.getElementById('confirm-body')?.textContent,
    }));
    assert.equal(dialog.title, 'Unsupported desktop selection');
    assert.match(dialog.body || '', /notes\.md/);
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});

test('Electron runtime exposes app-managed recent files through native menu and bridge', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-recent-runtime-'));
  const opened = path.join(tempDir, 'recent-study.dcm');
  await fs.writeFile(opened, 'not a real dicom');

  const { app, page, pageErrors } = await launchVoxelLab([opened]);
  try {
    await page.waitForSelector('#upload-modal.visible', { timeout: 10_000 });
    await page.waitForFunction(() => globalThis.voxellabDesktop.getRecentDocuments().then(items => items.length > 0), null, { timeout: 10_000 });
    const bridgeRecents = await page.evaluate(() => globalThis.voxellabDesktop.getRecentDocuments());
    assert.equal(bridgeRecents[0].name, 'recent-study.dcm');
    assert.equal(bridgeRecents[0].kind, 'file');
    const firstBytes = await page.evaluate(async (filePath) => {
      const range = await globalThis.voxellabDesktop.readFileRange(filePath, { start: 0, end: 4 });
      return new TextDecoder().decode(range.bytes);
    }, opened);
    assert.equal(firstBytes, 'not ');

    const menuRecents = await app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()?.items.find(item => item.label === 'File');
      const recent = file?.submenu?.items.find(item => item.label === 'Open Recent');
      return recent?.submenu?.items.map(item => item.label) || [];
    });
    assert.ok(menuRecents.includes('recent-study.dcm'));

    const cleared = await page.evaluate(() => globalThis.voxellabDesktop.clearRecentDocuments());
    assert.deepEqual(cleared, []);
    assert.deepEqual(await page.evaluate(() => globalThis.voxellabDesktop.getRecentDocuments()), []);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});
