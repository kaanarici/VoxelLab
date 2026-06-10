/* global document, getComputedStyle, TextDecoder, window */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { encodeImageJRoi } from '../js/microscopy/imagej-roi.js';
import {
  CALIBRATED_OME_TIFF,
  writeCalibratedChannelTimeOmeTiff,
  writeCalibratedOmeTiff,
} from './fixtures/microscopy/calibrated-ome-tiff.mjs';
import {
  assertMacWindowControlsAvoidSidebar,
  assertShellFits,
  assertSmokeWindowVisibility,
  closeApp,
  launchVoxelLab,
  writeTinyDicom,
  writeTinyNifti,
  writeTinyOmeZarrFolder,
  writeTinySr,
} from './fixtures/electron-runtime-smoke-helpers.mjs';

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
    await assertSmokeWindowVisibility(app, false);

    const menu = await app.evaluate(({ BrowserWindow, Menu }) => {
      const file = Menu.getApplicationMenu()?.items.find(item => item.label === 'File');
      const upload = file?.submenu?.items.find(item => item.label === 'Upload Study Panel');
      upload?.click(undefined, BrowserWindow.getAllWindows()[0], undefined);
      return file?.submenu?.items.map(item => item.label || item.role || item.type) || [];
    });
    assert.ok(menu.includes('Open Files...'));
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
    assert.match(dialog.body || '', /Try DICOM, NIfTI, OME-TIFF\/ImageJ TIFF/);
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});

test('Electron runtime groups multiple queued launch files into one selection', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-multi-open-path-'));
  const notes = path.join(tempDir, 'notes.md');
  const results = path.join(tempDir, 'results.csv');
  await fs.writeFile(notes, 'notes');
  await fs.writeFile(results, 'results');

  const { app, page, pageErrors } = await launchVoxelLab([notes, results]);
  try {
    await page.waitForSelector('#confirm-modal.visible', { timeout: 10_000 });
    await page.waitForSelector('#upload-modal.visible', { timeout: 10_000 });
    const dialog = await page.evaluate(() => ({
      title: document.getElementById('confirm-title')?.textContent,
      body: document.getElementById('confirm-body')?.textContent,
    }));
    assert.equal(dialog.title, 'Unsupported desktop selection');
    assert.match(dialog.body || '', /notes\.md/);
    assert.match(dialog.body || '', /results\.csv/);
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});

test('Electron runtime bounds direct unsupported launch file samples', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-many-unsupported-open-path-'));
  const files = [];
  for (let index = 0; index < 7; index += 1) {
    const file = path.join(tempDir, `notes-${index}.md`);
    await fs.writeFile(file, 'notes');
    files.push(file);
  }

  const { app, page, pageErrors } = await launchVoxelLab(files);
  try {
    await page.waitForSelector('#confirm-modal.visible', { timeout: 10_000 });
    await page.waitForSelector('#upload-modal.visible', { timeout: 10_000 });
    const dialog = await page.evaluate(() => ({
      title: document.getElementById('confirm-title')?.textContent,
      body: document.getElementById('confirm-body')?.textContent,
    }));
    assert.equal(dialog.title, 'Unsupported desktop selection');
    assert.match(dialog.body || '', /notes-0\.md/);
    assert.match(dialog.body || '', /notes-4\.md/);
    assert.match(dialog.body || '', /plus 2 more files/);
    assert.doesNotMatch(dialog.body || '', /notes-5\.md/);
    assert.doesNotMatch(dialog.body || '', /notes-6\.md/);
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});

test('Electron runtime reports skipped files for unsupported folder launches', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-unsupported-folder-'));
  await fs.writeFile(path.join(tempDir, 'notes.md'), 'notes');
  await fs.writeFile(path.join(tempDir, 'results.csv'), 'results');

  const { app, page, pageErrors } = await launchVoxelLab([tempDir]);
  try {
    await page.waitForSelector('#confirm-modal.visible', { timeout: 10_000 });
    await page.waitForSelector('#upload-modal.visible', { timeout: 10_000 });
    const dialog = await page.evaluate(() => ({
      title: document.getElementById('confirm-title')?.textContent,
      body: document.getElementById('confirm-body')?.textContent,
    }));
    assert.equal(dialog.title, 'Unsupported desktop selection');
    assert.match(dialog.body || '', /No supported image, sidecar, or converter-backed files/);
    assert.match(dialog.body || '', /notes\.md/);
    assert.match(dialog.body || '', /results\.csv/);
    assert.match(dialog.body || '', /Folder warnings: No supported files found/);
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});

test('Electron runtime explains sidecar-only launches before a microscopy image is open', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-sidecar-only-open-'));
  const roiPath = path.join(tempDir, 'cell-body.roi');
  const recipePath = path.join(tempDir, 'workflow.json');
  await fs.writeFile(roiPath, encodeImageJRoi({
    kind: 'ellipse',
    label: 'cell-body',
    points: [[3, 4], [12, 13]],
  }));
  await fs.writeFile(recipePath, JSON.stringify({ schema: 'voxellab.microscopyWorkflowRecipe.v1' }));

  const { app, page, pageErrors } = await launchVoxelLab([roiPath, recipePath]);
  try {
    await page.waitForSelector('#confirm-modal.visible', { timeout: 10_000 });
    await page.waitForSelector('#upload-modal.visible', { timeout: 10_000 });
    const dialog = await page.evaluate(() => ({
      title: document.getElementById('confirm-title')?.textContent,
      body: document.getElementById('confirm-body')?.textContent,
    }));
    assert.equal(dialog.title, 'Open microscopy image first');
    assert.match(dialog.body || '', /Sidecar files are not standalone images/);
    assert.match(dialog.body || '', /cell-body\.roi/);
    assert.match(dialog.body || '', /workflow\.json/);
    await page.waitForFunction(() => (
      [...document.querySelectorAll('#notify-container .notify-text')]
        .some(item => /Desktop intake:/.test(item.textContent || '')
          && /2 sidecars/.test(item.textContent || '')
          && /ImageJ ROI/.test(item.textContent || '')
          && /Workflow recipe/.test(item.textContent || ''))
    ), null, { timeout: 10_000 });
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});

test('Electron runtime explains DICOM SR sidecar-only launches before a source series is open', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-sr-sidecar-only-open-'));
  const srPath = path.join(tempDir, 'measurements.sr');
  await fs.writeFile(srPath, 'not a standalone image');

  const { app, page, pageErrors } = await launchVoxelLab([srPath]);
  try {
    await page.waitForSelector('#confirm-modal.visible', { timeout: 10_000 });
    await page.waitForSelector('#upload-modal.visible', { timeout: 10_000 });
    const dialog = await page.evaluate(() => ({
      title: document.getElementById('confirm-title')?.textContent,
      body: document.getElementById('confirm-body')?.textContent,
    }));
    assert.equal(dialog.title, 'Open source series first');
    assert.match(dialog.body || '', /DICOM SR files are derived objects/);
    assert.match(dialog.body || '', /matching source DICOM series/);
    assert.match(dialog.body || '', /measurements\.sr/);
    await page.waitForFunction(() => (
      [...document.querySelectorAll('#notify-container .notify-text')]
        .some(item => /Desktop intake:/.test(item.textContent || '')
          && /1 sidecar \(DICOM SR\)/.test(item.textContent || ''))
    ), null, { timeout: 10_000 });
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});

test('Electron runtime reports skipped SR sidecars after loading a local DICOM source', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-dicom-with-sr-'));
  const dicomPath = path.join(tempDir, 'source.dcm');
  const srPath = path.join(tempDir, 'clinical-note.sr');
  await writeTinyDicom(dicomPath);
  await writeTinySr(srPath);

  const { app, page, pageErrors } = await launchVoxelLab([dicomPath, srPath]);
  try {
    await page.waitForFunction(() => document.getElementById('series-name')?.textContent === 'Local DICOM CT', null, { timeout: 20_000 });
    await page.waitForFunction(() => (
      [...document.querySelectorAll('#notify-container .notify-text')]
        .some(item => /Skipped 1 derived object/.test(item.textContent || '')
          && /SR: SR import contains no measurement groups/.test(item.textContent || ''))
    ), null, { timeout: 10_000 });
    await page.waitForFunction(() => (
      [...document.querySelectorAll('#notify-container .notify-text')]
        .some(item => /Desktop intake:/.test(item.textContent || '')
          && /1 openable file \(DICOM\)/.test(item.textContent || '')
          && /1 sidecar \(DICOM SR\)/.test(item.textContent || ''))
    ), null, { timeout: 10_000 });
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});

test('Electron runtime reports converter-backed files in mixed folder launches', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-convertible-folder-'));
  const omeTiffPath = path.join(tempDir, 'mixed-cells.ome.tiff');
  const roiPath = path.join(tempDir, 'cell-body.roi');
  const recipePath = path.join(tempDir, 'workflow.json');
  await writeCalibratedChannelTimeOmeTiff(omeTiffPath);
  await fs.writeFile(path.join(tempDir, 'cells.czi'), 'fake czi');
  await fs.writeFile(path.join(tempDir, 'notes.md'), 'notes');
  await fs.writeFile(roiPath, encodeImageJRoi({
    kind: 'ellipse',
    label: 'cell-body',
    slice: 1,
    channelIndex: 1,
    timeIndex: 1,
    points: [[3, 4], [12, 13]],
  }));
  await fs.writeFile(recipePath, JSON.stringify({
    schema: 'voxellab.microscopyWorkflowRecipe.v1',
    kind: 'microscopy-workflow-recipe',
    target: {
      imageDomain: 'microscopy',
      slug: 'mixed-cells',
      name: 'mixed-cells',
      sourceFormat: 'OME-TIFF',
      geometry: {
        width: CALIBRATED_OME_TIFF.width,
        height: CALIBRATED_OME_TIFF.height,
        slices: 1,
        sizeZ: 1,
        sizeC: 2,
        sizeT: 2,
      },
    },
    requirements: { calibrationRequired: true, measurementPrerequisite: 'none', analysisOpsPresent: false },
    analysisOps: null,
    calibration: {
      xyKnown: true,
      rowMm: CALIBRATED_OME_TIFF.pixelSpacingMm[0],
      colMm: CALIBRATED_OME_TIFF.pixelSpacingMm[1],
      zKnown: true,
      zMm: CALIBRATED_OME_TIFF.sliceThicknessMm,
      displayUnit: 'µm',
    },
    view: { window: 255, level: 127, invertDisplay: false, colormap: 'grayscale', sliceIndex: 0 },
    stack: { channelIndex: 1, timeIndex: 1, compositeEnabled: true, compositeChannels: [true, false] },
    channels: [
      { index: 0, name: 'DAPI', color: '#0000FF', displayRange: null, displayRangeSource: '' },
      { index: 1, name: 'GFP', color: '#AA00CC', displayRange: null, displayRangeSource: '' },
    ],
    roiResults: null,
    angleMeasurements: null,
    exportPreferences: { csv: true, jsonBundle: true, overlayPng: true, embeddedRoiResults: false },
  }));

  const { app, page, pageErrors } = await launchVoxelLab([tempDir]);
  try {
    await page.waitForSelector('#confirm-modal.visible', { timeout: 10_000 });
    await page.waitForFunction(() => document.getElementById('series-name')?.textContent === 'mixed-cells', null, { timeout: 20_000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-roi-result-row]').length === 1, null, { timeout: 10_000 });
    await page.waitForFunction(() => document.getElementById('microscopy-recipe-status')?.textContent === 'Workflow recipe replayed', null, { timeout: 10_000 });
    const dialog = await page.evaluate(() => ({
      title: document.getElementById('confirm-title')?.textContent,
      body: document.getElementById('confirm-body')?.textContent,
    }));
    assert.equal(dialog.title, 'Conversion required');
    assert.match(dialog.body || '', /cells\.czi/);
    assert.match(dialog.body || '', /OME-TIFF/);
    assert.match(dialog.body || '', /1 converter-backed file/);
    const imported = await page.evaluate(async () => {
      const { state } = await import('/js/core/state.js');
      const series = state.manifest.series[state.seriesIdx];
      return {
        sequence: series?.sequence,
        pixelSpacing: series?.pixelSpacing,
        roiResultCount: document.getElementById('roi-results-count')?.textContent || '',
        roiRows: [...document.querySelectorAll('[data-roi-result-row]')].map(row => row.textContent || '').join('\n'),
        channelIndex: series?.microscopy?.channelIndex,
        timeIndex: series?.microscopy?.timeIndex,
        compositeEnabled: series?.microscopy?.composite?.enabled,
        compositeChannels: series?.microscopy?.composite?.channels,
        channelColor: series?.microscopyDataset?.channels?.[1]?.displayColor,
      };
    });
    assert.equal(imported.sequence, 'OME-TIFF');
    assert.deepEqual(imported.pixelSpacing, [0.00025, 0.0005]);
    assert.equal(imported.roiResultCount, '1');
    assert.match(imported.roiRows, /cell-body/);
    assert.equal(imported.channelIndex, 1);
    assert.equal(imported.timeIndex, 1);
    assert.equal(imported.compositeEnabled, true);
    assert.deepEqual(imported.compositeChannels, [true, false]);
    assert.equal(imported.channelColor, '#AA00CC');
    await page.waitForFunction(() => (
      [...document.querySelectorAll('#notify-container .notify-text')]
        .some(item => {
          const text = item.textContent || '';
          return /Desktop intake:/.test(text)
            && /scanned 5 files/.test(text)
            && /1 openable file \(OME-TIFF\)/.test(text)
            && /2 sidecars/.test(text)
            && /Workflow recipe/.test(text)
            && /ImageJ ROI/.test(text)
            && /1 converter-backed file \(CZI\)/.test(text)
            && /1 unsupported file skipped/.test(text)
            && /notes\.md/.test(text);
        })
    ), null, { timeout: 10_000 });
    const recents = await page.evaluate(() => globalThis.voxellabDesktop.getRecentDocuments());
    assert.equal(recents[0]?.path, tempDir);
    assert.equal(recents.some(item => ['cell-body.roi', 'cells.czi', 'workflow.json'].includes(item.name)), false);
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});

test('Electron runtime explains mixed native medical and microscopy folder launches', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-mixed-native-folder-'));
  await writeTinyNifti(path.join(tempDir, 'brain.nii'));
  await fs.writeFile(path.join(tempDir, 'cells.ome.tiff'), 'not parsed because mixed native families fail before import');

  const { app, page, pageErrors } = await launchVoxelLab([tempDir]);
  try {
    await page.waitForSelector('#upload-modal.visible', { timeout: 10_000 });
    await page.waitForFunction(() => {
      const text = document.getElementById('upload-status')?.textContent || '';
      return /Mixed native image families need separate imports for now/.test(text)
        && /1 NIfTI file \(.*brain\.nii\)/.test(text)
        && /1 microscopy TIFF file \(.*cells\.ome\.tiff\)/.test(text)
        && /selected 2 openable files \(NIfTI, OME-TIFF\)/.test(text)
        && /calibration, sidecars, and geometry stay tied/.test(text);
    }, null, { timeout: 20_000 });
    const recents = await page.evaluate(() => globalThis.voxellabDesktop.getRecentDocuments());
    assert.equal(recents[0]?.path, tempDir);
    assert.equal(recents.some(item => ['brain.nii', 'cells.ome.tiff'].includes(item.name)), false);
    await page.evaluate(() => {
      document.getElementById('upload-status').textContent = 'Waiting for Open Recent replay';
    });
    await page.evaluate((folderPath) => globalThis.voxellabDesktop.openRecentPath(folderPath), recents[0].path);
    await page.waitForFunction(() => {
      const text = document.getElementById('upload-status')?.textContent || '';
      return /Mixed native image families need separate imports for now/.test(text)
        && /1 NIfTI file \(.*brain\.nii\)/.test(text)
        && /1 microscopy TIFF file \(.*cells\.ome\.tiff\)/.test(text);
    }, null, { timeout: 20_000 });
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});

test('Electron runtime keeps desktop folder triage when a supported file fails parsing', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-broken-desktop-folder-'));
  await fs.writeFile(path.join(tempDir, 'broken-supported.dcm'), 'not a valid dicom object');
  await fs.writeFile(path.join(tempDir, 'notes.md'), 'not image data');
  const unreadableDir = path.join(tempDir, 'private-folder');
  await fs.mkdir(unreadableDir);
  let expectsReadFailure = false;
  if (process.platform !== 'win32') {
    try {
      await fs.chmod(unreadableDir, 0o000);
      expectsReadFailure = true;
    } catch {
      expectsReadFailure = false;
    }
  }
  let deepDir = path.join(tempDir, 'scan-depth-warning');
  for (let i = 0; i < 14; i += 1) {
    deepDir = path.join(deepDir, `level-${i}`);
  }
  await fs.mkdir(deepDir, { recursive: true });

  const { app, page, pageErrors } = await launchVoxelLab([tempDir]);
  try {
    await page.waitForSelector('#upload-modal.visible', { timeout: 10_000 });
    await page.waitForFunction((expectReadFailure) => {
      const text = document.getElementById('upload-status')?.textContent || '';
      return /Could not parse selected files/.test(text)
        && /Failed 1 attempted file: .*broken-supported\.dcm/.test(text)
        && !/Selected files?: .*broken-supported\.dcm/.test(text)
        && /broken-supported\.dcm/.test(text)
        && /checked 2 files/.test(text)
        && /selected 1 openable file \(DICOM\)/.test(text)
        && /skipped 1 unsupported file/.test(text)
        && /notes\.md/.test(text)
        && (expectReadFailure ? /1 folder read failed/.test(text) : !/folder read failed/.test(text))
        && /1 folder warning/.test(text)
        && /Scan depth limit/.test(text);
    }, expectsReadFailure, { timeout: 20_000 });
    if (expectsReadFailure) {
      await page.waitForFunction(() => (
        [...document.querySelectorAll('#notify-container .notify-text')]
          .some(item => {
            const text = item.textContent || '';
            return /Desktop intake:/.test(text)
              && /1 folder read failed/.test(text)
              && /Could not read folder: private-folder/.test(text);
          })
      ), null, { timeout: 10_000 });
    }
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
    if (expectsReadFailure) {
      await fs.chmod(unreadableDir, 0o700).catch(() => {});
    }
  }
});

test('Electron runtime keeps converter-backed direct file selections in failed intake context', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-broken-direct-mixed-'));
  const broken = path.join(tempDir, 'broken-supported.dcm');
  const convertible = path.join(tempDir, 'cells.czi');
  await fs.writeFile(broken, 'not a valid dicom object');
  await fs.writeFile(convertible, 'fake czi');

  const { app, page, pageErrors } = await launchVoxelLab([broken, convertible]);
  try {
    await page.waitForSelector('#confirm-modal.visible', { timeout: 10_000 });
    const dialog = await page.evaluate(() => ({
      title: document.getElementById('confirm-title')?.textContent,
      body: document.getElementById('confirm-body')?.textContent,
    }));
    assert.equal(dialog.title, 'Conversion required');
    assert.match(dialog.body || '', /cells\.czi/);
    assert.match(dialog.body || '', /1 converter-backed file/);
    await page.waitForFunction(() => {
      const text = document.getElementById('upload-status')?.textContent || '';
      return /Could not parse selected files/.test(text)
        && /Failed 1 attempted file: .*broken-supported\.dcm/.test(text)
        && !/Selected files?: .*broken-supported\.dcm/.test(text)
        && /broken-supported\.dcm/.test(text)
        && /checked 2 files/.test(text)
        && /selected 1 openable file \(DICOM\) and 1 converter-backed file \(CZI\)/.test(text)
        && /converter-backed files need configured local readers or an OME-TIFF converter and should be opened separately: .*cells\.czi/.test(text);
    }, null, { timeout: 20_000 });
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});

test('Electron runtime opens local OME-Zarr folders through the desktop bridge', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-runtime-zarr-'));
  const zarrRoot = await writeTinyOmeZarrFolder(tempDir);
  await fs.writeFile(path.join(zarrRoot, 'notes.md'), 'not image data');

  const { app, page, pageErrors } = await launchVoxelLab([zarrRoot]);
  try {
    await page.waitForFunction(() => document.getElementById('series-name')?.textContent === 'cells', null, { timeout: 20_000 });
    await page.waitForFunction(() => (
      [...document.querySelectorAll('#notify-container .notify-text')]
        .some(item => /Desktop intake:/.test(item.textContent || '') && /1 unsupported file skipped/.test(item.textContent || '') && /notes\.md/.test(item.textContent || ''))
    ), null, { timeout: 10_000 });
    const imported = await page.evaluate(async () => {
      const { state } = await import('/js/core/state.js');
      const series = state.manifest.series[state.seriesIdx];
      return {
        name: document.getElementById('series-name')?.textContent || '',
        description: document.getElementById('series-desc')?.textContent || '',
        meta: document.getElementById('meta')?.textContent || '',
        imageDomain: series?.imageDomain,
        sequence: series?.sequence,
        pixelSpacing: series?.pixelSpacing,
        stackKeys: Object.keys(state._localMicroscopyStacks?.[series?.slug] || {}),
      };
    });
    assert.equal(imported.name, 'cells');
    assert.match(imported.description, /OME-Zarr/);
    assert.match(imported.meta, /0\.250 µm × 0\.500 µm/);
    assert.equal(imported.imageDomain, 'microscopy');
    assert.equal(imported.sequence, 'OME-Zarr');
    assert.deepEqual(imported.pixelSpacing, [0.00025, 0.0005]);
    assert.deepEqual(imported.stackKeys, ['0|0']);
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});

test('Electron runtime keeps OME-TIFF with unsupported physical units uncalibrated', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-runtime-bad-unit-'));
  const omeTiffPath = path.join(tempDir, 'bad-unit-cells.ome.tiff');
  await writeCalibratedOmeTiff(omeTiffPath, { physicalUnit: 'furlong' });

  const { app, page, pageErrors } = await launchVoxelLab([omeTiffPath]);
  try {
    await page.waitForFunction(() => document.getElementById('series-name')?.textContent === 'bad-unit-cells', null, { timeout: 20_000 });
    await page.waitForSelector('#microscopy-stack-panel', { timeout: 10_000 });
    const stackPanelCollapsed = await page.$eval('#microscopy-stack-panel', panel => panel.classList.contains('collapsed'));
    if (stackPanelCollapsed) await page.click('#microscopy-stack-panel .sec-title');
    await page.waitForFunction(() => (
      document.getElementById('microscopy-calibration')?.textContent === 'XY uncalibrated · 3 warnings'
    ), null, { timeout: 10_000 });
    const imported = await page.evaluate(async () => {
      const { state } = await import('/js/core/state.js');
      const series = state.manifest.series[state.seriesIdx];
      const scaleBar = document.getElementById('scale-bar');
      return {
        description: document.getElementById('series-desc')?.textContent || '',
        meta: document.getElementById('meta')?.textContent || '',
        calibration: document.getElementById('microscopy-calibration')?.textContent || '',
        scaleBarHidden: !scaleBar || scaleBar.classList.contains('hidden') || getComputedStyle(scaleBar).display === 'none',
        sequence: series?.sequence,
        pixelSpacing: series?.pixelSpacing,
        spacingKnown: series?._spacingKnown,
        sourceWarnings: series?.microscopyDataset?.source?.warnings || [],
      };
    });
    assert.match(imported.description, /OME-TIFF/);
    assert.match(imported.meta, /Pixel spacing—/);
    assert.match(imported.meta, /CalibrationUncalibrated/);
    assert.match(imported.meta, /Spacing trustUnknown · XY unit unsupported/);
    assert.match(imported.meta, /Source warnings.*Unsupported X unit.*Unsupported Y unit/);
    assert.equal(imported.calibration, 'XY uncalibrated · 3 warnings');
    assert.equal(imported.scaleBarHidden, true);
    assert.equal(imported.sequence, 'OME-TIFF');
    assert.deepEqual(imported.pixelSpacing, [0, 0]);
    assert.equal(imported.spacingKnown, false);
    assert.deepEqual(imported.sourceWarnings, [
      'missing_xy_physical_size',
      'unsupported_x_physical_unit',
      'unsupported_y_physical_unit',
    ]);
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});

test('Electron runtime names incompatible workflow recipe sidecars after opening local OME-TIFF', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-runtime-bad-recipe-'));
  const omeTiffPath = path.join(tempDir, 'recipe-target-cells.ome.tiff');
  const recipePath = path.join(tempDir, 'workflow.json');
  await writeCalibratedOmeTiff(omeTiffPath);
  await fs.writeFile(recipePath, JSON.stringify({
    schema: 'voxellab.microscopyWorkflowRecipe.v1',
    target: {
      imageDomain: 'microscopy',
      sourceFormat: 'OME-TIFF',
      geometry: {
        width: CALIBRATED_OME_TIFF.width,
        height: CALIBRATED_OME_TIFF.height,
        sizeZ: 1,
        sizeC: 3,
        sizeT: 1,
      },
    },
    requirements: { calibrationRequired: false, measurementPrerequisite: 'none' },
    view: { sliceIndex: 0 },
    stack: { channelIndex: 0, timeIndex: 0, compositeEnabled: false, compositeChannels: [true, true, true] },
    channels: [],
  }));

  const { app, page, pageErrors } = await launchVoxelLab([omeTiffPath, recipePath]);
  try {
    await page.waitForFunction(() => document.getElementById('series-name')?.textContent === 'recipe-target-cells', null, { timeout: 20_000 });
    await page.waitForFunction(() => (
      /Recipe geometry\/channel\/time dimensions do not match the active microscopy series/.test(
        document.getElementById('microscopy-recipe-status')?.textContent || '',
      )
    ), null, { timeout: 10_000 });
    await page.waitForFunction(() => (
      [...document.querySelectorAll('#notify-container .notify-text')]
        .some(item => /Skipped 1 microscopy workflow recipe/.test(item.textContent || '')
          && /workflow\.json/.test(item.textContent || '')
          && /Recipe geometry\/channel\/time dimensions do not match/.test(item.textContent || ''))
    ), null, { timeout: 10_000 });
    await page.waitForFunction(() => (
      [...document.querySelectorAll('#notify-container .notify-text')]
        .some(item => /Desktop intake:/.test(item.textContent || '')
          && /1 openable file \(OME-TIFF\)/.test(item.textContent || '')
          && /1 sidecar \(Workflow recipe\)/.test(item.textContent || ''))
    ), null, { timeout: 10_000 });
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});

test('Electron runtime skips ordinary JSON sidecars during local OME-TIFF launches', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-runtime-json-sidecar-'));
  const omeTiffPath = path.join(tempDir, 'metadata-sidecar-cells.ome.tiff');
  const metadataPath = path.join(tempDir, 'metadata.json');
  const invalidJsonPath = path.join(tempDir, 'broken.json');
  await writeCalibratedOmeTiff(omeTiffPath);
  await fs.writeFile(metadataPath, JSON.stringify({ lab: 'example', note: 'ordinary acquisition metadata' }));
  await fs.writeFile(invalidJsonPath, '{not json');

  const { app, page, pageErrors } = await launchVoxelLab([omeTiffPath, metadataPath, invalidJsonPath]);
  try {
    await page.waitForFunction(() => document.getElementById('series-name')?.textContent === 'metadata-sidecar-cells', null, { timeout: 20_000 });
    await page.waitForFunction(() => (
      [...document.querySelectorAll('#notify-container .notify-text')]
        .some(item => /Desktop intake:/.test(item.textContent || '')
          && /1 openable file \(OME-TIFF\)/.test(item.textContent || '')
          && /2 unsupported files skipped/.test(item.textContent || '')
          && /metadata\.json \(unrecognized JSON sidecar\)/.test(item.textContent || '')
          && /broken\.json \(invalid JSON sidecar\)/.test(item.textContent || ''))
    ), null, { timeout: 10_000 });
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});

test('Electron runtime guards schema-bearing unknown JSON sidecars during local OME-TIFF launches', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-runtime-unknown-json-sidecar-'));
  const omeTiffPath = path.join(tempDir, 'unknown-sidecar-cells.ome.tiff');
  const unknownJsonPath = path.join(tempDir, 'unknown-sidecar.json');
  await writeCalibratedOmeTiff(omeTiffPath);
  await fs.writeFile(unknownJsonPath, JSON.stringify({ schema: 'example.not-roi-results.v1' }));

  const { app, page, pageErrors } = await launchVoxelLab([omeTiffPath, unknownJsonPath]);
  try {
    await page.waitForFunction(() => (
      /Remove unsupported JSON sidecar before importing microscopy TIFF/.test(
        document.getElementById('upload-status')?.textContent || '',
      )
      && /unknown-sidecar\.json \(unrecognized JSON sidecar schema: example\.not-roi-results\.v1\)/.test(
        document.getElementById('upload-status')?.textContent || '',
      )
      && /recognized ROI-results or workflow-recipe JSON sidecars/.test(
        document.getElementById('upload-status')?.textContent || '',
      )
    ), null, { timeout: 20_000 });
    await page.waitForFunction(() => (
      [...document.querySelectorAll('#notify-container .notify-text')]
        .some(item => /Desktop intake:/.test(item.textContent || '')
          && /1 openable file \(OME-TIFF\)/.test(item.textContent || '')
          && /unknown-sidecar\.json \(unrecognized JSON sidecar schema: example\.not-roi-results\.v1\)/.test(item.textContent || ''))
    ), null, { timeout: 10_000 });
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});

test('Electron runtime imports ROI sidecars with local OME-TIFF launches', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-runtime-roi-'));
  const omeTiffPath = path.join(tempDir, 'roi-sidecar-cells.ome.tiff');
  const roiPath = path.join(tempDir, 'cell-body.roi');
  const jsonPath = path.join(tempDir, 'voxel-roi-results.json');
  await writeCalibratedOmeTiff(omeTiffPath);
  await fs.writeFile(roiPath, encodeImageJRoi({
    kind: 'ellipse',
    label: 'cell-body',
    slice: 1,
    channelIndex: 1,
    timeIndex: 1,
    points: [[3, 4], [12, 13]],
  }));
  await fs.writeFile(jsonPath, JSON.stringify({
    schema: 'voxellab.roiResults.v1',
    series: {
      slug: 'roi-sidecar-cells',
      name: 'roi-sidecar-cells',
      width: CALIBRATED_OME_TIFF.width,
      height: CALIBRATED_OME_TIFF.height,
      slices: 1,
    },
    source: { imageDomain: 'microscopy' },
    calibration: {
      xyKnown: true,
      rowMm: CALIBRATED_OME_TIFF.pixelSpacingMm[0],
      colMm: CALIBRATED_OME_TIFF.pixelSpacingMm[1],
    },
    rows: [{
      roiObjectId: 'roi:roi-sidecar-cells|0:json-cell',
      slice: 1,
      sliceIndex: 0,
      kind: 'ellipse',
      label: 'json-cell',
      points: [[1, 1], [5, 5]],
      channelIndex: 0,
      timeIndex: 0,
      areaMm2: CALIBRATED_OME_TIFF.pixelAreaUm2 * 16 / 1_000_000,
      pixels: 16,
    }],
  }));

  const { app, page, pageErrors } = await launchVoxelLab([omeTiffPath, roiPath, jsonPath]);
  try {
    await page.waitForFunction(() => document.getElementById('series-name')?.textContent === 'roi-sidecar-cells', null, { timeout: 20_000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-roi-result-row]').length === 2, null, { timeout: 10_000 });
    const imported = await page.evaluate(async () => {
      const { state } = await import('/js/core/state.js');
      const series = state.manifest.series[state.seriesIdx];
      const rowText = [...document.querySelectorAll('[data-roi-result-row]')]
        .map(row => row.textContent || '')
        .join('\n');
      return {
        description: document.getElementById('series-desc')?.textContent || '',
        meta: document.getElementById('meta')?.textContent || '',
        roiCount: document.querySelectorAll('#overlay-svg .roi-group').length,
        pointCount: document.querySelectorAll('#overlay-svg .roi-point').length,
        roiResultCount: document.getElementById('roi-results-count')?.textContent || '',
        rowText,
        sequence: series?.sequence,
        pixelSpacing: series?.pixelSpacing,
      };
    });
    assert.match(imported.description, /OME-TIFF/);
    assert.match(imported.meta, /0\.250 µm × 0\.500 µm/);
    assert.equal(imported.sequence, 'OME-TIFF');
    assert.deepEqual(imported.pixelSpacing, [0.00025, 0.0005]);
    assert.equal(imported.roiCount, 2);
    assert.equal(imported.pointCount, 0);
    assert.equal(imported.roiResultCount, '2');
    assert.match(imported.rowText, /cell-body/);
    assert.match(imported.rowText, /json-cell/);
    assert.match(imported.rowText, /ellipse/);
    assert.match(imported.rowText, /µm²/);
    await page.waitForFunction(() => (
      [...document.querySelectorAll('#notify-container .notify-text')]
        .some(item => /Desktop intake:/.test(item.textContent || '')
          && /1 openable file/.test(item.textContent || '')
          && /2 sidecars/.test(item.textContent || '')
          && /ROI results/.test(item.textContent || ''))
    ), null, { timeout: 10_000 });
    const recents = await page.evaluate(() => globalThis.voxellabDesktop.getRecentDocuments());
    assert.deepEqual(recents.map(item => item.name), ['roi-sidecar-cells.ome.tiff']);
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});

test('Electron runtime names incompatible ROI-results sidecars after opening local OME-TIFF', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-runtime-bad-roi-results-'));
  const omeTiffPath = path.join(tempDir, 'roi-results-target-cells.ome.tiff');
  const jsonPath = path.join(tempDir, 'voxel-roi-results.json');
  await writeCalibratedOmeTiff(omeTiffPath);
  await fs.writeFile(jsonPath, JSON.stringify({
    schema: 'voxellab.roiResults.v1',
    series: {
      slug: 'roi-results-target-cells',
      name: 'roi-results-target-cells',
      width: CALIBRATED_OME_TIFF.width,
      height: CALIBRATED_OME_TIFF.height,
      slices: 1,
    },
    source: { imageDomain: 'microscopy' },
    calibration: {
      xyKnown: true,
      rowMm: CALIBRATED_OME_TIFF.pixelSpacingMm[0],
      colMm: CALIBRATED_OME_TIFF.pixelSpacingMm[1],
    },
    rows: [{
      roiObjectId: 'roi:roi-results-target-cells|0:stale-cell',
      slice: 1,
      sliceIndex: 0,
      kind: 'ellipse',
      label: 'stale-cell',
      points: [[1, 1], [CALIBRATED_OME_TIFF.width + 4, CALIBRATED_OME_TIFF.height + 4]],
      channelIndex: 0,
      timeIndex: 0,
      areaMm2: CALIBRATED_OME_TIFF.pixelAreaUm2 * 16 / 1_000_000,
      pixels: 16,
    }],
  }));

  const { app, page, pageErrors } = await launchVoxelLab([omeTiffPath, jsonPath]);
  try {
    await page.waitForFunction(() => document.getElementById('series-name')?.textContent === 'roi-results-target-cells', null, { timeout: 20_000 });
    await page.waitForFunction(() => (
      [...document.querySelectorAll('#notify-container .notify-text')]
        .some(item => /Skipped 1 ROI sidecar/.test(item.textContent || '')
          && /voxel-roi-results\.json/.test(item.textContent || '')
          && /ROI bundle rows are incompatible with this microscopy stack/.test(item.textContent || ''))
    ), null, { timeout: 10_000 });
    await page.waitForFunction(() => (
      [...document.querySelectorAll('#notify-container .notify-text')]
        .some(item => /Desktop intake:/.test(item.textContent || '')
          && /1 openable file \(OME-TIFF\)/.test(item.textContent || '')
          && /1 sidecar \(ROI results\)/.test(item.textContent || ''))
    ), null, { timeout: 10_000 });
    const roiResultCount = await page.$eval('#roi-results-count', item => item.textContent || '');
    assert.equal(roiResultCount, '0');
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});

test('Electron runtime reports convertible launch paths instead of dropping them', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-convertible-open-path-'));
  const convertible = path.join(tempDir, 'cells.czi');
  await fs.writeFile(convertible, 'fake czi');

  const { app, page, pageErrors } = await launchVoxelLab([convertible]);
  try {
    await page.waitForSelector('#confirm-modal.visible', { timeout: 10_000 });
    await page.waitForSelector('#upload-modal.visible', { timeout: 10_000 });
    const dialog = await page.evaluate(() => ({
      title: document.getElementById('confirm-title')?.textContent,
      body: document.getElementById('confirm-body')?.textContent,
    }));
    assert.equal(dialog.title, 'Conversion required');
    assert.match(dialog.body || '', /cells\.czi/);
    assert.match(dialog.body || '', /OME-TIFF/);
    await assertShellFits(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});

test('Electron runtime starts configured desktop conversion and reopens the OME-TIFF output', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-configured-converter-'));
  const convertible = path.join(tempDir, 'cells.czi');
  const converter = path.join(tempDir, 'fake-bfconvert.mjs');
  await fs.writeFile(convertible, 'fake czi');
  await fs.writeFile(converter, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs/promises';",
    'const [, , input, output] = process.argv;',
    "await fs.writeFile(output, `fake ome tiff from ${input}`);",
    '',
  ].join('\n'));
  await fs.chmod(converter, 0o755);

  const { app, page, pageErrors } = await launchVoxelLab([convertible], {
    env: { VOXELLAB_BFCONVERT: converter },
  });
  try {
    await page.waitForSelector('#confirm-modal.visible', { timeout: 10_000 });
    const dialog = await page.evaluate(() => ({
      title: document.getElementById('confirm-title')?.textContent,
      body: document.getElementById('confirm-body')?.textContent,
    }));
    assert.equal(dialog.title, 'Converting desktop files');
    assert.match(dialog.body || '', /cells\.czi/);
    assert.match(dialog.body || '', /OME-TIFF/);
    assert.match(dialog.body || '', /Converting 1 desktop file/);
    assert.match(dialog.body || '', /Converted outputs reopen automatically/);
    await page.waitForFunction(() => (
      /Not a TIFF file/.test(document.getElementById('upload-status')?.textContent || '')
    ), null, { timeout: 15_000 });
    const recents = await page.evaluate(() => globalThis.voxellabDesktop.getRecentDocuments());
    assert.equal(recents[0]?.name, 'cells.czi');
    assert.equal(recents.some(item => /\.ome\.tiff$/i.test(item.name)), false, 'app-managed converted outputs should not appear in Open Recent');
    await page.evaluate(() => {
      globalThis.__voxellabConversionEvents = [];
      globalThis.__voxellabOffConversionEvents?.();
      globalThis.__voxellabOffConversionEvents = globalThis.voxellabDesktop.onConversionJobChanged((job) => {
        globalThis.__voxellabConversionEvents.push({ id: job.id, status: job.status, outputPath: job.outputPath });
      });
    });
    await page.evaluate((filePath) => globalThis.voxellabDesktop.openRecentPath(filePath), recents[0].path);
    await page.waitForFunction(() => {
      const statuses = (globalThis.__voxellabConversionEvents || []).map(job => job.status);
      return statuses.includes('running') && statuses.includes('completed');
    }, null, { timeout: 15_000 });
    const recentsAfterReopen = await page.evaluate(() => globalThis.voxellabDesktop.getRecentDocuments());
    assert.equal(recentsAfterReopen[0]?.name, 'cells.czi');
    assert.equal(recentsAfterReopen.some(item => /\.ome\.tiff$/i.test(item.name)), false, 'recent reopen should not remember converted temp outputs');
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
    await assert.rejects(
      page.evaluate((filePath) => globalThis.voxellabDesktop.readFileRange(filePath, {
        start: 0,
        end: 4,
        maxBytes: 2,
      }), opened),
      /too large/i,
    );

    const menuRecents = await app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()?.items.find(item => item.label === 'File');
      const recent = file?.submenu?.items.find(item => item.label === 'Open Recent');
      return recent?.submenu?.items.map(item => item.label) || [];
    });
    assert.ok(menuRecents.includes('recent-study.dcm'));

    await fs.unlink(opened);
    await assert.rejects(
      page.evaluate((filePath) => globalThis.voxellabDesktop.openRecentPath(filePath), opened),
      /no longer available/i,
    );
    assert.deepEqual(await page.evaluate(() => globalThis.voxellabDesktop.getRecentDocuments()), []);
    const prunedMenuRecents = await app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()?.items.find(item => item.label === 'File');
      const recent = file?.submenu?.items.find(item => item.label === 'Open Recent');
      return recent?.submenu?.items.map(item => item.label) || [];
    });
    assert.equal(prunedMenuRecents.includes('recent-study.dcm'), false);

    const cleared = await page.evaluate(() => globalThis.voxellabDesktop.clearRecentDocuments());
    assert.deepEqual(cleared, []);
    assert.deepEqual(await page.evaluate(() => globalThis.voxellabDesktop.getRecentDocuments()), []);
    assert.deepEqual(pageErrors, []);
  } finally {
    await closeApp(app);
  }
});
