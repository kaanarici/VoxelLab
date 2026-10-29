import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';

import {
  openEmptyStudyUploadModal as openUploadModal,
  routeConfig,
  routeManifest,
  waitForControlsReady,
} from '../helpers/browser/app.mjs';
import { settleFrames, waitForCanvasPaint } from '../helpers/browser/canvas.mjs';
import { writeTinyNifti } from '../helpers/browser/fixtures/nifti.mjs';
import { expectUploadModalMatrixFits } from '../helpers/browser/layout.mjs';

async function routeDcmjsModule(page) {
  const dcmjsModule = await readFile('node_modules/dcmjs/build/dcmjs.es.js', 'utf8');
  await page.route('**/node_modules/dcmjs/build/dcmjs.es.js', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: dcmjsModule });
  });
}

async function dropSyntheticFolderEntries(page) {
  await page.locator('#upload-zone').evaluate((target) => {
    const readableFile = new File([new Uint8Array([1, 2, 3, 4])], 'scan.dcm', { type: 'application/dicom' });
    const noteFile = new File(['not image data'], 'notes.md', { type: 'text/markdown' });
    const fileEntry = (name, file) => ({
      name,
      isFile: true,
      isDirectory: false,
      file(resolve) {
        resolve(file);
      },
    });
    const unreadableFileEntry = (name) => ({
      name,
      isFile: true,
      isDirectory: false,
      file(_resolve, reject) {
        reject(new Error('not readable'));
      },
    });
    const unreadableDirectoryEntry = (name) => ({
      name,
      isFile: false,
      isDirectory: true,
      createReader() {
        return {
          readEntries(_resolve, reject) {
            reject(new Error('not readable'));
          },
        };
      },
    });
    const root = {
      name: 'study',
      fullPath: '/study',
      isFile: false,
      isDirectory: true,
      createReader() {
        let done = false;
        return {
          readEntries(resolve) {
            if (done) {
              resolve([]);
              return;
            }
            done = true;
            resolve([
              fileEntry('scan.dcm', readableFile),
              unreadableFileEntry('missing.ome.tif'),
              unreadableDirectoryEntry('private'),
              fileEntry('notes.md', noteFile),
            ]);
          },
        };
      },
    };
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { items: [{ webkitGetAsEntry: () => root }], files: [] },
    });
    target.dispatchEvent(event);
  });
}

test('upload modal advertises supported local image formats in the picker', async ({ page }) => {
  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const accept = await page.locator('#upload-file-input').getAttribute('accept');
  expect(accept || '').toContain('.dcm');
  expect(accept || '').toContain('.sr');
  expect(accept || '').toContain('.nii');
  expect(accept || '').toContain('.nii.gz');
  expect(accept || '').toContain('.tif');
  expect(accept || '').toContain('.ome.tiff');
  expect(accept || '').toContain('.czi');
  expect(accept || '').toContain('.nd2');
  expect(accept || '').toContain('.lif');
  expect(accept || '').toContain('.oib');
  expect(accept || '').toContain('.oif');
  expect(accept || '').toContain('.lsm');
  expect(accept || '').toContain('.roi');
  expect(accept || '').toContain('.zip');
  expect(accept || '').not.toContain('.csv');
  expect(accept || '').toContain('application/dicom');
  await expect(page.locator('#upload-files-btn')).toBeVisible();
  await expect(page.locator('#upload-folder-input')).toHaveAttribute('webkitdirectory', '');
  await expect(page.locator('.upload-zone-title')).toHaveText('Drop study files or folders here');
  await expect(page.locator('.upload-zone-subtitle')).toHaveText('or click to open a study folder');
});

test('empty-state drop opens the same local intake as the study dialog', async ({ page }, testInfo) => {
  const niftiPath = testInfo.outputPath('empty-drop.nii');
  await writeTinyNifti(niftiPath);
  const bytes = [...await readFile(niftiPath)];

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await routeManifest(page, { patient: 'anonymous', studyDate: '', series: [] });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForControlsReady(page);
  await expect(page.locator('#empty-state')).toBeVisible();

  await page.locator('#empty-state').evaluate((target, payload) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(payload)], 'empty-drop.nii', { type: 'application/octet-stream' }));
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    target.dispatchEvent(event);
  }, bytes);

  await expect(page.locator('#series-name')).toHaveText('empty-drop');
  await expect(page.locator('#empty-state')).toBeHidden();
  await waitForCanvasPaint(page, '#view');
});

test('upload modal can browse a local folder into the same local import path', async ({ page }, testInfo) => {
  const folderPath = testInfo.outputPath('nifti-folder');
  const niftiPath = `${folderPath}/tiny-folder.nii`;
  await writeTinyNifti(niftiPath);
  await writeFile(`${folderPath}/.DS_Store`, 'junk');
  await writeFile(`${folderPath}/metadata.json`, JSON.stringify({ lab: 'example', note: 'ordinary acquisition metadata' }));
  await writeFile(`${folderPath}/notes.md`, 'not image data');
  await writeFile(`${folderPath}/results.csv`, 'not image data');

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#upload-folder-input').setInputFiles(folderPath);

  await expect(page.locator('#series-name')).toHaveText('tiny-folder');
  await expect(page.locator('#notify-container .notify-text')).toContainText('Local intake: 1 openable file (NIfTI) selected after checking 4 files; skipped 3 unsupported files');
  await expect(page.locator('#notify-container .notify-text')).toContainText('checking 4 files');
  await expect(page.locator('#slice-tot')).toHaveText('2');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await waitForCanvasPaint(page, '#view');
});

test('upload modal summarizes mixed folder triage before import action', async ({ page }, testInfo) => {
  const folderPath = testInfo.outputPath('mixed-folder');
  await writeTinyNifti(`${folderPath}/tiny-folder.nii`);
  await writeFile(`${folderPath}/cells.czi`, 'converter backed');
  await writeFile(`${folderPath}/workflow.json`, JSON.stringify({ schema: 'voxellab.microscopyWorkflowRecipe.v1' }));
  await writeFile(`${folderPath}/metadata.json`, JSON.stringify({ lab: 'example', note: 'ordinary acquisition metadata' }));
  await writeFile(`${folderPath}/broken.json`, '{not json');
  await writeFile(`${folderPath}/notes.md`, 'not image data');

  await routeConfig(page, {
    modalWebhookBase: 'https://voxellab.example.modal.run',
    r2PublicUrl: 'https://voxellab.example.r2.dev',
    trustedUploadOrigins: ['https://account.r2.cloudflarestorage.com'],
    features: { cloudProcessing: true },
  });
  await openUploadModal(page);

  await page.locator('#upload-folder-input').setInputFiles(folderPath);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/is-active/);

  await expect(status).toContainText('Opened (NIfTI)');
  await expect(status).toContainText('Converter-backed (CZI)');
  await expect(status).toContainText('Needs configured local readers or an OME-TIFF converter; open separately.');
  await expect(status).toContainText('Sidecars (Workflow recipe)');
  await expect(status).toContainText('Skipped (unsupported)');
  await expect(status).toContainText('notes.md');
  await expect(status).toContainText('cells.czi');
  await expect(status).toContainText('metadata.json (unrecognized JSON sidecar)');
  await expect(status).toContainText('broken.json (invalid JSON sidecar)');

  await expect(status).toHaveAttribute('aria-label', /after checking 6 files/);
  await expect(status).toHaveAttribute('aria-label', /1 openable file \(NIfTI\), 1 converter-backed file \(CZI\) and 1 sidecar \(Workflow recipe\) selected/);
  await expect(page.locator('#notify-container .notify-text')).toContainText('Local intake: 1 openable file (NIfTI), 1 converter-backed file (CZI) and 1 sidecar (Workflow recipe) selected');
  await expect(page.locator('#notify-container .notify-text')).toContainText('checking 6 files');
});

test('upload modal keeps the latest dropped selection when an earlier source manifest resolves late', async ({ page }) => {
  await routeDcmjsModule(page);
  await routeConfig(page, {
    modalWebhookBase: 'https://voxellab.example.modal.run',
    r2PublicUrl: 'https://voxellab.example.r2.dev',
    trustedUploadOrigins: ['https://account.r2.cloudflarestorage.com'],
    features: { cloudProcessing: true },
  });
  await openUploadModal(page);

  await page.locator('#upload-zone').evaluate((target) => {
    let resolveManifest;
    const manifestText = new Promise(resolve => { resolveManifest = resolve; });
    window.__resolveUploadRaceManifest = () => resolveManifest(JSON.stringify({ sourceKind: 'projection' }));
    window.__uploadRaceManifestStarted = false;
    const sourceManifest = new File(['{}'], 'voxellab.source.json', { type: 'application/json' });
    Object.defineProperty(sourceManifest, 'text', {
      value() {
        window.__uploadRaceManifestStarted = true;
        return manifestText.then((value) => {
          window.__uploadRaceManifestDelivered = true;
          return value;
        });
      },
    });
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([1, 2, 3, 4])], 'first.dcm', { type: 'application/dicom' }));
    transfer.items.add(sourceManifest);
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    target.dispatchEvent(event);
  });
  await expect.poll(async () => page.evaluate(() => window.__uploadRaceManifestStarted)).toBe(true);

  await page.locator('#upload-zone').evaluate((target) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(360)], 'second.nii', { type: 'application/octet-stream' }));
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    target.dispatchEvent(event);
  });

  const status = page.locator('#upload-status');
  await expect(status).toContainText('Opened (NIfTI)');
  await page.evaluate(() => window.__resolveUploadRaceManifest());
  await expect.poll(() => page.evaluate(() => window.__uploadRaceManifestDelivered === true)).toBe(true);
  await settleFrames(page);
  await expect.poll(async () => status.innerText()).toContain('Opened (NIfTI)');
  await expect(status).not.toContainText('DICOM');
  await expect(status).not.toContainText('VoxelLab source manifest');
});

test('upload modal separates browser drag folder read failures from unsupported skips', async ({ page }) => {
  await routeConfig(page, {
    modalWebhookBase: 'https://voxellab.example.modal.run',
    r2PublicUrl: 'https://voxellab.example.r2.dev',
    trustedUploadOrigins: ['https://account.r2.cloudflarestorage.com'],
    features: { cloudProcessing: true },
  });
  await openUploadModal(page);

  await dropSyntheticFolderEntries(page);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/is-active/);

  await expect(status).toContainText('Opened (DICOM)');
  await expect(status).toContainText('Skipped (unsupported)');
  await expect(status).toContainText('study/notes.md');
  await expect(status).toContainText('File read failed');
  await expect(status).toContainText('study/missing.ome.tif (not found or unreadable)');
  await expect(status).toContainText('Folder read failed');
  await expect(status).toContainText('Could not read folder: private');
  await expect(status).toHaveAttribute('aria-label', /after checking 4 files/);
  await expect(page.locator('#notify-container .notify-text', { hasText: 'openable file' })).toContainText('file read failed');
  await expect(page.locator('#notify-container .notify-text', { hasText: 'openable file' })).toContainText('folder read failed');
});

test('local-only mixed folders open supported files and defer converter-backed files', async ({ page }, testInfo) => {
  const folderPath = testInfo.outputPath('mixed-local-folder');
  await writeTinyNifti(`${folderPath}/tiny-folder.nii`);
  await writeFile(`${folderPath}/cells-a.czi`, 'converter backed');
  await writeFile(`${folderPath}/cells-b.nd2`, 'converter backed');
  await writeFile(`${folderPath}/cells-c.lif`, 'converter backed');
  await writeFile(`${folderPath}/cells-d.oib`, 'converter backed');
  await writeFile(`${folderPath}/notes.md`, 'not image data');

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();

  await page.locator('#upload-folder-input').setInputFiles(folderPath);

  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-name')).toHaveText('tiny-folder');
  await expect(page.locator('#slice-tot')).toHaveText('2');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Local intake:' }))
    .toContainText(/1 openable file \(NIfTI\) and 4 converter-backed files/);
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Skipped 4 converter-backed files' }))
    .toContainText('open them separately with configured local readers or an OME-TIFF converter after loading supported files');
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Skipped 4 converter-backed files' }))
    .toContainText('plus 1 more file');
  await waitForCanvasPaint(page, '#view');
});

test('upload modal names unsupported folder samples when nothing can open', async ({ page }, testInfo) => {
  const folderPath = testInfo.outputPath('unsupported-folder');
  await mkdir(folderPath, { recursive: true });
  await writeFile(`${folderPath}/notes.md`, 'not image data');
  await writeFile(`${folderPath}/results.csv`, 'not image data');
  await writeFile(`${folderPath}/summary.txt`, 'not image data');
  await writeFile(`${folderPath}/readme.log`, 'not image data');
  await writeFile(`${folderPath}/table.tsv`, 'not image data');
  await writeFile(`${folderPath}/analysis.out`, 'not image data');
  await writeFile(`${folderPath}/figure.svg`, 'not image data');

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  await page.locator('#upload-folder-input').setInputFiles(folderPath);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/is-error/);

  await expect(status).toContainText('Skipped (unsupported)');
  await expect(status).toContainText('unsupported-folder/');
  await expect(status).toContainText('+2 more files');
  await expect(status.locator('.upload-triage-advice')).toContainText('Try DICOM, NIfTI');

  await expect(status).toHaveAttribute('aria-label', /No supported image, sidecar, or converter-backed files selected/);
  await expect(status).toHaveAttribute('aria-label', /after checking 7 files/);
  await expect(page.locator('#upload-modal')).toBeVisible();
});

test('upload modal rejects a malformed standalone DICOM SR without implying it was queued', async ({ page }, testInfo) => {
  const srPath = testInfo.outputPath('sr-only/measurements.sr');
  await mkdir(dirname(srPath), { recursive: true });
  await writeFile(srPath, 'not a standalone image');

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  await page.locator('#upload-file-input').setInputFiles(srPath);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/is-error/);
  await expect(status).toContainText('Could not parse selected files.');
  await expect(status).toContainText('Failed 1 attempted file: measurements.sr.');
  await expect(status).toContainText('checked 1 file');
  await expect(status).toContainText('selected 1 sidecar (DICOM SR)');
  await expect(status).toContainText('Check format or open the full source folder.');
  await expect(page.locator('#upload-modal')).toBeVisible();
});

test('upload modal explains standalone microscopy workflow recipes before image load', async ({ page }, testInfo) => {
  const recipePath = testInfo.outputPath('microscopy-sidecar-only/workflow.json');
  await mkdir(dirname(recipePath), { recursive: true });
  await writeFile(recipePath, JSON.stringify({ schema: 'voxellab.microscopyWorkflowRecipe.v1' }));

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  await page.locator('#upload-file-input').setInputFiles(recipePath);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/is-error/);
  await expect(status).toContainText('Sidecar files are not standalone images.');
  await expect(status).toContainText('Open the matching microscopy image first, then open the sidecar again.');
  await expect(status).toContainText('Selected sidecar: workflow.json.');
  await expect(status).toContainText('Selected file: workflow.json.');
  await expect(status).toContainText('checked 1 file');
  await expect(status).toContainText('selected 1 sidecar (Workflow recipe)');
  await expect(page.locator('#upload-modal')).toBeVisible();
});

test('upload modal bounds standalone microscopy sidecar names before image load', async ({ page }, testInfo) => {
  const folderPath = testInfo.outputPath('microscopy-many-sidecars');
  await mkdir(folderPath, { recursive: true });
  const sidecarPaths = [
    `${folderPath}/workflow.json`,
    `${folderPath}/results.json`,
    `${folderPath}/cells.roi`,
    `${folderPath}/angles.roi`,
    `${folderPath}/points.roi`,
    `${folderPath}/extra.roi`,
  ];
  await writeFile(sidecarPaths[0], JSON.stringify({ schema: 'voxellab.microscopyWorkflowRecipe.v1' }));
  await writeFile(sidecarPaths[1], JSON.stringify({ schema: 'voxellab.roiResults.v1' }));
  for (const path of sidecarPaths.slice(2)) {
    await writeFile(path, 'not a standalone image');
  }

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  await page.locator('#upload-file-input').setInputFiles(sidecarPaths);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/is-error/);
  await expect(status).toContainText('Sidecar files are not standalone images.');
  await expect(status).toContainText('Open the matching microscopy image first, then open the sidecar again.');
  await expect(status).toContainText('Selected sidecars: results.json, workflow.json, cells.roi, angles.roi, points.roi, plus 1 more file.');
  await expect(status).toContainText('checked 6 files');
  await expect(status).toContainText('selected 6 sidecars');
  await expect(page.locator('#upload-modal')).toBeVisible();
});

test('upload modal names supported-looking files that fail local parsing with folder triage context', async ({ page }, testInfo) => {
  const folderPath = testInfo.outputPath('broken-supported-folder');
  const dicomPath = `${folderPath}/broken-supported.dcm`;
  await mkdir(dirname(dicomPath), { recursive: true });
  await writeFile(dicomPath, 'not a valid dicom object');
  await writeFile(`${folderPath}/cells.czi`, 'converter backed');
  await writeFile(`${folderPath}/notes.md`, 'not image data');
  await writeFile(`${folderPath}/results.csv`, 'not image data');

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  await page.locator('#upload-folder-input').setInputFiles(folderPath);

  const status = page.locator('#upload-status');
  await expect(status).toHaveClass(/is-error/);
  await expect(status).toContainText('broken-supported.dcm');
  await expect(status).toContainText('Failed 1 attempted file: broken-supported-folder/broken-supported.dcm');
  await expect(status).not.toContainText('Selected files: broken-supported-folder/broken-supported.dcm');
  await expect(status).toContainText('checked 4 files');
  await expect(status).toContainText('selected 1 openable file (DICOM) and 1 converter-backed file (CZI)');
  await expect(status).toContainText('converter-backed files need configured local readers or an OME-TIFF converter and should be opened separately: broken-supported-folder/cells.czi');
  await expect(status).toContainText('skipped 2 unsupported files');
  await expect(status).toContainText('notes.md');
  await expect(status).toContainText('results.csv');
  await expect(page.locator('#upload-modal')).toBeVisible();
});

test('upload modal shows honest format support boundaries without layout overflow', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 720 });
  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const matrix = page.locator('.format-capability-matrix');
  await expect(matrix).toBeVisible();
  await expect(matrix.locator('.format-capability-row')).toHaveCount(11);
  await expect(matrix).toContainText('Native');
  await expect(matrix).toContainText('Converted');
  await expect(matrix).toContainText('Unsupported');
  await expect(matrix.locator('.format-capability-row', { hasText: 'OME-TIFF / ImageJ TIFF' }))
    .toContainText('MPR/3D');
  await expect(matrix.locator('.format-capability-row', { hasText: 'ImageJ ROI .roi' }))
    .toContainText('open PolyLine');
  await expect(matrix.locator('.format-capability-row', { hasText: 'SEG / RTSTRUCT / SR / RT Dose' }))
    .toContainText('session queue');
  await expect(page.locator('.upload-copy', {
    hasText: 'generic TIFF sequences stay uncalibrated',
  })).toBeVisible();
  await expect(matrix.locator('.format-capability-row', { hasText: 'OME-Zarr (limited)' }))
    .toContainText('Zarr v3');
  await expect(matrix.locator('.format-capability-row', { hasText: 'TIFF JPEG / BigTIFF / tiled pyramids' }))
    .toContainText('fails closed');
  await expect(matrix.locator('.format-capability-row', { hasText: 'CZI / ND2 / LIF / OIB / OIF / LSM bridge' }))
    .toContainText('scenes, ND2 positions, and LIF images/positions');
  await expectUploadModalMatrixFits(page);

  await page.setViewportSize({ width: 390, height: 720 });
  await expect(matrix).toBeVisible();
  await expect(matrix.locator('.format-capability-head')).toBeHidden();
  await expectUploadModalMatrixFits(page);
});

test('upload modal respects cloudProcessing=false even when endpoints are configured', async ({ page }) => {
  await routeConfig(page, {
    modalWebhookBase: '/api/cloud',
    r2PublicUrl: 'https://r2.example',
    trustedUploadOrigins: ['https://upload.example'],
    features: { cloudProcessing: false },
  });
  await openUploadModal(page);

  await expect(page.locator('#upload-cloud-btn')).toHaveCount(0);
  await expect(page.locator('#upload-body')).toContainText('Nothing is uploaded');
  await expect(page.locator('#upload-body')).toContainText('Cloud GPU processing is disabled.');
  await expect(page.locator('#upload-cloud-actions')).toContainText('Disabled');
  await expect(page.locator('#upload-cloud-actions')).toContainText('Cloud reconstruction');
  await expect(page.locator('#upload-cloud-actions')).toContainText('Next: resolve the Cloud GPU runtime blocker before selecting source files.');
});

test('static upload modal does not advertise writable Cloud settings', async ({ page }) => {
  await routeConfig(page, {
    modalWebhookBase: '',
    r2PublicUrl: '',
    features: { cloudProcessing: false },
  });

  await page.goto('/?localBackend=0', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#btn-upload')).toBeVisible();
  await waitForControlsReady(page);
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();

  await expect(page.locator('#upload-cloud-settings-btn')).toHaveCount(0);
  await expect(page.locator('#upload-body')).toContainText('Cloud GPU processing is disabled.');
  await expect(page.locator('#upload-body')).toContainText('Open the desktop app or run npm start to configure Modal GPU');
  await expect(page.locator('#upload-body')).not.toContainText('Use Cloud settings to enable Modal GPU');
});
