import { expect, test } from '@playwright/test';

import {
  openAdvancedOptions,
  openEmptyStudyUploadModal,
  reopenUploadModal,
  routeConfig,
  routeManifest,
} from '../helpers/browser/app.mjs';
import { settleFrames } from '../helpers/browser/canvas.mjs';
import {
  desktopFile,
  desktopOpenFilesCalls,
  dispatchDesktopOpen,
  expectDesktopReadStarted,
  installDesktopBridgeStub,
  releaseDesktopRead,
  tinyNiftiByteArray,
  waitForDesktopBridge,
} from '../helpers/browser/desktop-bridge.mjs';

const LOCAL_AI_CONFIG = { ai: { enabled: true, provider: 'local', ready: true, issues: [] } };

async function openLifecycleUploadModal(page, override = {}) {
  await routeConfig(page, { ...LOCAL_AI_CONFIG, ...override });
  await openEmptyStudyUploadModal(page);
}

async function openDesktopViewer(page, stubOptions = {}) {
  await routeConfig(page, LOCAL_AI_CONFIG);
  await installDesktopBridgeStub(page, stubOptions);
  await routeManifest(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForDesktopBridge(page);
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

async function resolveDelayedFolderDrop(page, key) {
  await page.evaluate(dropKey => window.__delayedFolderDrops[dropKey].resolve(), key);
  await expect.poll(() => page.evaluate(
    dropKey => window.__delayedFolderDrops[dropKey].fileRead,
    key,
  )).toBe(true);
  await settleFrames(page);
}

async function dropTinyNiftiFile(page, fileName) {
  await page.locator('#upload-zone').evaluate((target, payload) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(payload.bytes)], payload.fileName));
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    target.dispatchEvent(event);
  }, { bytes: tinyNiftiByteArray(), fileName });
}

test('the newest drop wins even when an older folder traversal resolves later', async ({ page }) => {
  await openLifecycleUploadModal(page, {
    modalWebhookBase: 'https://voxellab.example.modal.run',
    r2PublicUrl: 'https://voxellab.example.r2.dev',
    trustedUploadOrigins: ['https://account.r2.cloudflarestorage.com'],
  });
  await startDelayedFolderDrop(page, 'older', { fileName: 'older.dcm', type: 'application/dicom' });
  await dropTinyNiftiFile(page, 'newer.nii');

  const status = page.locator('#upload-status');
  await expect(status).toContainText('Opened (NIfTI)');
  await resolveDelayedFolderDrop(page, 'older');
  await expect(status).toContainText('Opened (NIfTI)');
  await expect(status).not.toContainText('DICOM');
});

test('dismissed upload sessions ignore delayed folder traversal after reopen', async ({ page }) => {
  await openLifecycleUploadModal(page, {
    modalWebhookBase: 'https://voxellab.example.modal.run',
    r2PublicUrl: 'https://voxellab.example.r2.dev',
  });
  await page.evaluate(() => { window.__dismissedUploadStatus = document.getElementById('upload-status'); });
  await startDelayedFolderDrop(page, 'dismissed', { fileName: 'dismissed.dcm', type: 'application/dicom' });

  await page.keyboard.press('Escape');
  await reopenUploadModal(page);
  await resolveDelayedFolderDrop(page, 'dismissed');

  await expect.poll(() => page.evaluate(() => window.__dismissedUploadStatus.textContent)).toBe('');
  await expect(page.locator('#upload-status')).toHaveText('');
});

test('dismissed DICOMweb work cannot mutate a reopened upload session', async ({ page }) => {
  const gate = () => {
    const marks = {};
    marks.started = new Promise(resolve => { marks.markStarted = resolve; });
    marks.open = new Promise(resolve => { marks.release = resolve; });
    marks.delivered = new Promise(resolve => { marks.markDelivered = resolve; });
    return marks;
  };
  const studies = gate();
  const metadata = gate();
  const deliver = async (marks, route, body) => {
    marks.markStarted();
    await marks.open;
    try {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    } catch {
      marks.markDelivered();
      return;
    }
    marks.markDelivered();
  };
  await page.route('https://pacs.example/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/studies') return deliver(studies, route, [{ '0020000D': { vr: 'UI', Value: ['stale.study'] } }]);
    if (path.endsWith('/metadata')) return deliver(metadata, route, [{ '00080060': { vr: 'CS', Value: ['CT'] } }]);
    throw new Error(`Unhandled DICOMweb request: ${path}`);
  });

  await openLifecycleUploadModal(page);
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.evaluate(() => { window.__dismissedDicomwebStudyInput = document.getElementById('dicomweb-study'); });
  await page.locator('#dicomweb-find-studies-btn').click();
  await studies.started;
  await page.keyboard.press('Escape');
  await reopenUploadModal(page);
  await openAdvancedOptions(page);

  studies.release();
  await studies.delivered;
  await settleFrames(page);
  await expect.poll(() => page.evaluate(() => window.__dismissedDicomwebStudyInput.value)).toBe('');
  await expect(page.locator('#dicomweb-study')).toHaveValue('');

  await openAdvancedOptions(page);
  await page.locator('#dicomweb-base').fill('https://pacs.example');
  await page.locator('#dicomweb-study').fill('1.2.study');
  await page.locator('#dicomweb-series').fill('1.2.series');
  await page.locator('#upload-dicomweb-btn').click();
  await metadata.started;
  await page.keyboard.press('Escape');
  await reopenUploadModal(page);
  await openAdvancedOptions(page);

  metadata.release();
  await metadata.delivered;
  await settleFrames(page);

  await expect(page.locator('#series-list li')).toHaveCount(0);
  await expect(page.locator('#upload-status')).toHaveText('');
  await expect(page.locator('#upload-dicomweb-btn')).toBeEnabled();
});

test('dismissed desktop intake cannot import into a reopened upload session', async ({ page }) => {
  await openDesktopViewer(page, { gateReads: true });

  await dispatchDesktopOpen(page, { supported: [desktopFile('dismissed.nii')] });
  await expect(page.locator('#upload-modal')).toBeVisible();
  await expectDesktopReadStarted(page);
  await page.keyboard.press('Escape');
  await reopenUploadModal(page);
  await releaseDesktopRead(page);

  await expect(page.locator('#series-list li')).toHaveCount(0);
  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toHaveText('');
});

test('newer desktop intake supersedes an older intake during modal setup', async ({ page }) => {
  let markTemplateStarted;
  let releaseTemplate;
  const templateStarted = new Promise(resolve => { markTemplateStarted = resolve; });
  const templateGate = new Promise(resolve => { releaseTemplate = resolve; });
  await page.route('**/templates/upload-modal.html', async (route) => {
    markTemplateStarted();
    await templateGate;
    await route.continue();
  });
  await openDesktopViewer(page);

  await dispatchDesktopOpen(page, { supported: [desktopFile('older.nii')] });
  await templateStarted;
  await dispatchDesktopOpen(page, { supported: [desktopFile('newer.nii')] });
  releaseTemplate();

  await expect(page.locator('#series-list li')).toHaveCount(1);
  await expect(page.locator('#series-name')).toHaveText('newer');
  await expect(page.locator('#confirm-modal')).toBeHidden();
  await expect(page.locator('#confirm-title')).not.toHaveText('Open microscopy image first');
});

test('newer desktop intake dismisses an already-visible sidecar-only warning', async ({ page }) => {
  await openDesktopViewer(page);

  await dispatchDesktopOpen(page, { supported: [desktopFile('workflow.json', 2)] });
  await expect(page.locator('#confirm-modal')).toBeVisible();
  await expect(page.locator('#confirm-title')).toHaveText('Open microscopy image first');
  await expect(page.locator('#confirm-modal').getByRole('button', { name: 'Choose other files' })).toBeVisible();

  await dispatchDesktopOpen(page, { supported: [desktopFile('newer.nii')] });

  await expect(page.locator('#series-list li')).toHaveCount(1);
  await expect(page.locator('#series-name')).toHaveText('newer');
  await expect(page.locator('#confirm-modal')).toBeHidden();
});

test('an active close-blocked cloud job refuses desktop intake and explains why', async ({ page }) => {
  await openDesktopViewer(page);

  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await page.locator('#upload-modal').evaluate((modal) => { modal.dataset.closeBlocked = 'true'; });

  await dispatchDesktopOpen(page, { supported: [desktopFile('blocked.nii')] });

  await expect(page.locator('[data-notify-id="desktop-cloud-job-block"]'))
    .toContainText('Stop the active cloud job before opening another study.');
  await expect(page.locator('#upload-status'))
    .toHaveText('Cloud job is running. Stop waiting before closing this modal.');
  await expect(page.locator('#upload-status')).toHaveClass(/is-warning/);
  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#confirm-modal')).toBeHidden();
  await expect(page.locator('#series-list li')).toHaveCount(0);

  await page.locator('#upload-modal').evaluate((modal) => { delete modal.dataset.closeBlocked; });
  await dispatchDesktopOpen(page, { supported: [desktopFile('unblocked.nii')] });
  await expect(page.locator('#series-list li')).toHaveCount(1);
  await expect(page.locator('#series-name')).toHaveText('unblocked');
});

test('a rejected native picker leaves exactly one File open failed dialog', async ({ page }) => {
  await openDesktopViewer(page, { openFilesError: 'native picker unavailable' });

  await dispatchDesktopOpen(page, { supported: [desktopFile('workflow.json', 2)] });
  await expect(page.locator('#confirm-modal')).toBeVisible();
  await expect(page.locator('#confirm-title')).toHaveText('Open microscopy image first');

  await page.locator('#desktop-intake-choose-files').click();
  await expect(page.locator('#confirm-title')).toHaveText('File open failed');
  await expect(page.locator('#confirm-body')).toContainText('native picker unavailable');
  expect(await desktopOpenFilesCalls(page)).toBe(1);
  await expect(page.locator('#confirm-modal')).toHaveCount(1);
  await expect(page.locator('#confirm-modal.visible')).toHaveCount(1);
  await expect(page.locator('#confirm-body #desktop-intake-choose-files')).toHaveCount(1);

  await page.locator('#desktop-intake-choose-files').click();
  await expect.poll(() => desktopOpenFilesCalls(page)).toBe(2);
  await expect(page.locator('#confirm-title')).toHaveText('File open failed');
  await expect(page.locator('#confirm-modal.visible')).toHaveCount(1);
  await expect(page.locator('#desktop-intake-choose-files')).toHaveCount(1);
});
