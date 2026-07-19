/* global DataTransfer, File, URL, document, window */
import { expect, test } from '@playwright/test';

async function routeConfig(page, override = {}) {
  await page.route(/\/config(?:\.local)?\.json$/, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      modalWebhookBase: '',
      r2PublicUrl: '',
      trustedUploadOrigins: [],
      localApiToken: '',
      localAiAvailable: true,
      ai: { enabled: true, provider: 'local', ready: true, issues: [] },
      siteName: 'VoxelLab',
      disclaimer: 'Not for clinical use. For research and educational purposes only.',
      features: { cloudProcessing: true, aiAnalysis: true },
      ...override,
    }),
  }));
}

async function openAdvancedOptions(page) {
  const advanced = page.locator('#upload-advanced-options');
  if (!await advanced.evaluate(element => element.open)) {
    await advanced.locator('summary').click();
  }
}

async function openUploadModal(page) {
  await page.route('**/data/manifest.json', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ patient: 'anonymous', studyDate: '', series: [] }),
  }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.voxellabControlsReady === 'true');
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await openAdvancedOptions(page);
}

async function startDelayedFolderDrop(page, key, { fileName, type }) {
  await page.locator('#upload-zone').evaluate((target, options) => {
    window.__delayedFolderDrops ||= {};
    const drop = { readStarted: false, fileRead: false, resolve: null };
    window.__delayedFolderDrops[options.key] = drop;
    const file = new File([new Uint8Array([1, 2, 3, 4])], options.fileName, { type: options.type });
    const fileEntry = {
      name: file.name,
      isFile: true,
      isDirectory: false,
      file(resolve) {
        drop.fileRead = true;
        resolve(file);
      },
    };
    let done = false;
    const root = {
      name: `${options.key}-study`,
      fullPath: `/${options.key}-study`,
      isFile: false,
      isDirectory: true,
      createReader() {
        return {
          readEntries(resolve) {
            if (done) return resolve([]);
            done = true;
            drop.readStarted = true;
            drop.resolve = () => resolve([fileEntry]);
          },
        };
      },
    };
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { items: [{ webkitGetAsEntry: () => root }], files: [] },
    });
    target.dispatchEvent(event);
  }, { key, fileName, type });
  await expect.poll(() => page.evaluate(
    dropKey => window.__delayedFolderDrops[dropKey].readStarted,
    key,
  )).toBe(true);
}

test('the newest drop wins even when an older folder traversal resolves later', async ({ page }) => {
  await routeConfig(page, {
    modalWebhookBase: 'https://voxellab.example.modal.run',
    r2PublicUrl: 'https://voxellab.example.r2.dev',
  });
  await openUploadModal(page);
  await startDelayedFolderDrop(page, 'older', { fileName: 'older.dcm', type: 'application/dicom' });

  await page.locator('#upload-zone').evaluate((target) => {
    const bytes = new Uint8Array(360);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, 348, true);
    view.setInt16(40, 3, true);
    view.setInt16(42, 2, true);
    view.setInt16(44, 2, true);
    view.setInt16(46, 2, true);
    view.setInt16(70, 2, true);
    view.setInt16(72, 8, true);
    view.setFloat32(80, 1, true);
    view.setFloat32(84, 1, true);
    view.setFloat32(88, 1, true);
    view.setFloat32(108, 352, true);
    view.setUint8(123, 2);
    bytes.set([0x6e, 0x2b, 0x31, 0], 344);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'newer.nii'));
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    target.dispatchEvent(event);
  });

  const status = page.locator('#upload-status');
  await expect(status).toContainText('Opened (NIfTI)');
  await page.evaluate(() => window.__delayedFolderDrops.older.resolve());
  await expect.poll(() => page.evaluate(() => window.__delayedFolderDrops.older.fileRead)).toBe(true);
  await page.waitForTimeout(100);
  await expect(status).toContainText('Opened (NIfTI)');
  await expect(status).not.toContainText('DICOM');
});

test('dismissed upload sessions ignore delayed folder traversal after reopen', async ({ page }) => {
  await routeConfig(page, {
    modalWebhookBase: 'https://voxellab.example.modal.run',
    r2PublicUrl: 'https://voxellab.example.r2.dev',
  });
  await openUploadModal(page);
  await page.evaluate(() => { window.__dismissedUploadStatus = document.getElementById('upload-status'); });
  await startDelayedFolderDrop(page, 'dismissed', { fileName: 'dismissed.dcm', type: 'application/dicom' });

  await page.keyboard.press('Escape');
  await page.locator('#btn-upload').click();
  await page.evaluate(() => window.__delayedFolderDrops.dismissed.resolve());
  await expect.poll(() => page.evaluate(() => window.__delayedFolderDrops.dismissed.fileRead)).toBe(true);
  await page.waitForTimeout(100);

  await expect.poll(() => page.evaluate(() => window.__dismissedUploadStatus.textContent)).toBe('');
  await expect(page.locator('#upload-status')).toHaveText('');
});

test('dismissed DICOMweb work cannot mutate a reopened upload session', async ({ page }) => {
  await routeConfig(page);
  let releaseStudyDiscovery;
  let markStudyStarted;
  const studyStarted = new Promise(resolve => { markStudyStarted = resolve; });
  const studyGate = new Promise(resolve => { releaseStudyDiscovery = resolve; });
  let releaseMetadata;
  let markMetadataStarted;
  const metadataStarted = new Promise(resolve => { markMetadataStarted = resolve; });
  const metadataGate = new Promise(resolve => { releaseMetadata = resolve; });
  await page.route('https://pacs.example/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/studies') {
      markStudyStarted();
      await studyGate;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ '0020000D': { vr: 'UI', Value: ['stale.study'] } }]) });
    }
    if (path.endsWith('/metadata')) {
      markMetadataStarted();
      await metadataGate;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ '00080060': { vr: 'CS', Value: ['CT'] } }]) });
    }
    throw new Error(`Unhandled DICOMweb request: ${path}`);
  });

  await openUploadModal(page);
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.evaluate(() => { window.__dismissedDicomwebStudyInput = document.getElementById('dicomweb-study'); });
  await page.locator('#dicomweb-find-studies-btn').click();
  await studyStarted;
  await page.keyboard.press('Escape');
  await page.locator('#btn-upload').click();
  await openAdvancedOptions(page);
  releaseStudyDiscovery();
  await page.waitForTimeout(100);
  await expect.poll(() => page.evaluate(() => window.__dismissedDicomwebStudyInput.value)).toBe('');
  await expect(page.locator('#dicomweb-study')).toHaveValue('');

  await openAdvancedOptions(page);
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.locator('#dicomweb-study').fill('1.2.study');
  await page.locator('#dicomweb-series').fill('1.2.series');
  await page.locator('#upload-dicomweb-btn').click();
  await metadataStarted;
  await page.keyboard.press('Escape');
  await page.locator('#btn-upload').click();
  await openAdvancedOptions(page);
  releaseMetadata();
  await page.waitForTimeout(100);

  await expect(page.locator('#series-list li')).toHaveCount(0);
  await expect(page.locator('#upload-status')).toHaveText('');
  await expect(page.locator('#upload-dicomweb-btn')).toBeEnabled();
});

test('dismissed desktop intake cannot import into a reopened upload session', async ({ page }) => {
  await routeConfig(page);
  await page.addInitScript(() => {
    const bytes = new ArrayBuffer(360);
    const view = new DataView(bytes);
    view.setInt32(0, 348, true);
    new Uint8Array(bytes).set([0x6e, 0x2b, 0x31, 0], 344);
    view.setInt16(40, 3, true);
    view.setInt16(42, 2, true);
    view.setInt16(44, 2, true);
    view.setInt16(46, 2, true);
    view.setInt16(70, 2, true);
    view.setInt16(72, 8, true);
    view.setFloat32(80, 1, true);
    view.setFloat32(84, 1, true);
    view.setFloat32(88, 1, true);
    view.setFloat32(108, 352, true);
    view.setUint8(123, 2);
    let releaseRead;
    const readGate = new Promise(resolve => { releaseRead = resolve; });
    window.__releaseDesktopRead = releaseRead;
    window.voxellabDesktop = {
      onMenuCommand() {},
      onOpenPaths(handler) { window.__dispatchDesktopOpen = handler; },
      async rendererReady() {},
      async getCloudSettings() { return {}; },
      async saveCloudSettings() {},
      async openFolder() {},
      async getConverterCapabilities() { return { tools: [] }; },
      async readFileRange(_path, { start = 0, end = bytes.byteLength } = {}) {
        window.__desktopReadStarted = true;
        await readGate;
        window.__desktopReadFinished = true;
        return { bytes: bytes.slice(start, end) };
      },
    };
  });
  await page.route('**/data/manifest.json', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ patient: 'anonymous', studyDate: '', series: [] }),
  }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.__dispatchDesktopOpen === 'function');

  await page.evaluate(() => {
    void window.__dispatchDesktopOpen({
      supported: [{ kind: 'file', name: 'dismissed.nii', path: '/tmp/dismissed.nii', size: 360 }],
      unsupported: [],
      convertible: [],
    });
  });
  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__desktopReadStarted)).toBe(true);
  await page.keyboard.press('Escape');
  await page.locator('#btn-upload').click();
  await page.evaluate(() => window.__releaseDesktopRead());
  await expect.poll(() => page.evaluate(() => window.__desktopReadFinished)).toBe(true);

  await expect(page.locator('#series-list li')).toHaveCount(0);
  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toHaveText('');
});

test('newer desktop intake supersedes an older intake during modal setup', async ({ page }) => {
  await routeConfig(page);
  let markTemplateStarted;
  let releaseTemplate;
  const templateStarted = new Promise(resolve => { markTemplateStarted = resolve; });
  const templateGate = new Promise(resolve => { releaseTemplate = resolve; });
  await page.route('**/templates/upload-modal.html', async (route) => {
    markTemplateStarted();
    await templateGate;
    await route.continue();
  });
  await page.addInitScript(() => {
    const bytes = new ArrayBuffer(360);
    const view = new DataView(bytes);
    view.setInt32(0, 348, true);
    new Uint8Array(bytes).set([0x6e, 0x2b, 0x31, 0], 344);
    view.setInt16(40, 3, true);
    view.setInt16(42, 2, true);
    view.setInt16(44, 2, true);
    view.setInt16(46, 2, true);
    view.setInt16(70, 2, true);
    view.setInt16(72, 8, true);
    view.setFloat32(80, 1, true);
    view.setFloat32(84, 1, true);
    view.setFloat32(88, 1, true);
    view.setFloat32(108, 352, true);
    view.setUint8(123, 2);
    window.voxellabDesktop = {
      onMenuCommand() {},
      onOpenPaths(handler) { window.__dispatchDesktopOpen = handler; },
      async rendererReady() {},
      async getCloudSettings() { return {}; },
      async saveCloudSettings() {},
      async openFolder() {},
      async getConverterCapabilities() { return { tools: [] }; },
      async readFileRange(_path, { start = 0, end = bytes.byteLength } = {}) {
        return { bytes: bytes.slice(start, end) };
      },
    };
  });
  await page.route('**/data/manifest.json', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ patient: 'anonymous', studyDate: '', series: [] }),
  }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.__dispatchDesktopOpen === 'function');

  await page.evaluate(() => {
    void window.__dispatchDesktopOpen({
      supported: [{ kind: 'file', name: 'older.nii', path: '/tmp/older.nii', size: 360 }],
      unsupported: [],
      convertible: [],
    });
  });
  await templateStarted;
  await page.evaluate(() => {
    void window.__dispatchDesktopOpen({
      supported: [{ kind: 'file', name: 'newer.nii', path: '/tmp/newer.nii', size: 360 }],
      unsupported: [],
      convertible: [],
    });
  });
  releaseTemplate();

  await expect(page.locator('#series-list li')).toHaveCount(1);
  await expect(page.locator('#series-name')).toHaveText('newer');
  await expect(page.locator('#confirm-modal')).toBeHidden();
  await expect(page.locator('#confirm-title')).not.toHaveText('Open microscopy image first');
});

test('newer desktop intake dismisses an already-visible sidecar-only warning', async ({ page }) => {
  await routeConfig(page);
  await page.addInitScript(() => {
    const bytes = new ArrayBuffer(360);
    const view = new DataView(bytes);
    view.setInt32(0, 348, true);
    new Uint8Array(bytes).set([0x6e, 0x2b, 0x31, 0], 344);
    view.setInt16(40, 3, true);
    view.setInt16(42, 2, true);
    view.setInt16(44, 2, true);
    view.setInt16(46, 2, true);
    view.setInt16(70, 2, true);
    view.setInt16(72, 8, true);
    view.setFloat32(80, 1, true);
    view.setFloat32(84, 1, true);
    view.setFloat32(88, 1, true);
    view.setFloat32(108, 352, true);
    view.setUint8(123, 2);
    window.voxellabDesktop = {
      onMenuCommand() {},
      onOpenPaths(handler) { window.__dispatchDesktopOpen = handler; },
      async rendererReady() {},
      async getCloudSettings() { return {}; },
      async saveCloudSettings() {},
      async openFolder() {},
      async getConverterCapabilities() { return { tools: [] }; },
      async readFileRange(_path, { start = 0, end = bytes.byteLength } = {}) {
        return { bytes: bytes.slice(start, end) };
      },
    };
  });
  await page.route('**/data/manifest.json', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ patient: 'anonymous', studyDate: '', series: [] }),
  }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.__dispatchDesktopOpen === 'function');

  await page.evaluate(() => {
    void window.__dispatchDesktopOpen({
      supported: [{ kind: 'file', name: 'workflow.json', path: '/tmp/workflow.json', size: 2 }],
      unsupported: [],
      convertible: [],
    });
  });
  await expect(page.locator('#confirm-modal')).toBeVisible();
  await expect(page.locator('#confirm-title')).toHaveText('Open microscopy image first');

  await page.evaluate(() => {
    void window.__dispatchDesktopOpen({
      supported: [{ kind: 'file', name: 'newer.nii', path: '/tmp/newer.nii', size: 360 }],
      unsupported: [],
      convertible: [],
    });
  });

  await expect(page.locator('#series-list li')).toHaveCount(1);
  await expect(page.locator('#series-name')).toHaveText('newer');
  await expect(page.locator('#confirm-modal')).toBeHidden();
});
