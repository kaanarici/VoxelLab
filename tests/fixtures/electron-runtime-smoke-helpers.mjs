/* global document, getComputedStyle, window */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { _electron as electron } from 'playwright';
import dcmjs from 'dcmjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

export async function writeTinyOmeZarrFolder(rootDir) {
  const zarrRoot = path.join(rootDir, 'cells.zarr');
  const level = path.join(zarrRoot, '0');
  await fs.mkdir(level, { recursive: true });
  await fs.writeFile(path.join(zarrRoot, '.zattrs'), JSON.stringify({
    ome: {
      version: '0.4',
      multiscales: [{
        axes: [
          { name: 'c', type: 'channel' },
          { name: 'y', type: 'space', unit: 'micrometer' },
          { name: 'x', type: 'space', unit: 'micrometer' },
        ],
        datasets: [{
          path: '0',
          coordinateTransformations: [{ type: 'scale', scale: [1, 0.25, 0.5] }],
        }],
      }],
    },
  }));
  await fs.writeFile(path.join(level, '.zarray'), JSON.stringify({
    zarr_format: 2,
    shape: [1, 2, 2],
    chunks: [1, 2, 2],
    dtype: '|u1',
    compressor: null,
    order: 'C',
    filters: null,
    fill_value: 0,
  }));
  await fs.writeFile(path.join(level, '0.0.0'), new Uint8Array([0, 32, 128, 255]));
  return zarrRoot;
}

export async function writeTinyDicom(pathname) {
  const { DicomDict, DicomMetaDictionary } = dcmjs.data;
  const dataset = {
    _meta: {
      FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
      MediaStorageSOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
      MediaStorageSOPInstanceUID: '1.2.826.0.1.3680043.10.543.1',
      TransferSyntaxUID: '1.2.840.10008.1.2.1',
      ImplementationClassUID: '1.2.826.0.1.3680043.10.543',
    },
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
    SOPInstanceUID: '1.2.826.0.1.3680043.10.543.1',
    StudyInstanceUID: '1.2.826.0.1.3680043.10.543.10',
    SeriesInstanceUID: '1.2.826.0.1.3680043.10.543.20',
    FrameOfReferenceUID: '1.2.826.0.1.3680043.10.543.30',
    Modality: 'CT',
    SeriesDescription: 'Local DICOM CT',
    Rows: 2,
    Columns: 2,
    SamplesPerPixel: 1,
    PhotometricInterpretation: 'MONOCHROME2',
    BitsAllocated: 16,
    BitsStored: 16,
    HighBit: 15,
    PixelRepresentation: 0,
    PixelSpacing: [0.5, 0.5],
    SliceThickness: 1,
    ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
    ImagePositionPatient: [0, 0, 0],
    InstanceNumber: 1,
    PixelData: new Uint16Array([1, 2, 3, 4]).buffer,
  };
  const dict = new DicomDict(DicomMetaDictionary.denaturalizeDataset(dataset._meta));
  dict.dict = DicomMetaDictionary.denaturalizeDataset(dataset);
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  await fs.writeFile(pathname, Buffer.from(dict.write()));
}

export async function writeTinySr(pathname) {
  const { DicomDict, DicomMetaDictionary } = dcmjs.data;
  const dataset = {
    _meta: {
      FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
      MediaStorageSOPClassUID: '1.2.840.10008.5.1.4.1.1.88.11',
      MediaStorageSOPInstanceUID: '1.2.826.0.1.3680043.10.543.88.1',
      TransferSyntaxUID: '1.2.840.10008.1.2.1',
      ImplementationClassUID: '1.2.826.0.1.3680043.10.543',
    },
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.88.11',
    SOPInstanceUID: '1.2.826.0.1.3680043.10.543.88.1',
    StudyInstanceUID: '1.2.826.0.1.3680043.10.543.10',
    SeriesInstanceUID: '1.2.826.0.1.3680043.10.543.88',
    FrameOfReferenceUID: '1.2.826.0.1.3680043.10.543.30',
    Modality: 'SR',
    SeriesDescription: 'Unsupported SR note',
  };
  const dict = new DicomDict(DicomMetaDictionary.denaturalizeDataset(dataset._meta));
  dict.dict = DicomMetaDictionary.denaturalizeDataset(dataset);
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  await fs.writeFile(pathname, Buffer.from(dict.write()));
}

export async function writeTinyNifti(pathname, { xyztUnits = 2, pixdim = [1, 1, 1] } = {}) {
  const buffer = Buffer.alloc(352 + 8);
  buffer.writeInt32LE(348, 0);
  buffer.writeInt16LE(3, 40);
  buffer.writeInt16LE(2, 42);
  buffer.writeInt16LE(2, 44);
  buffer.writeInt16LE(2, 46);
  buffer.writeInt16LE(2, 70);
  buffer.writeFloatLE(pixdim[0], 76 + 4);
  buffer.writeFloatLE(pixdim[1], 76 + 8);
  buffer.writeFloatLE(pixdim[2], 76 + 12);
  buffer.writeFloatLE(352, 108);
  buffer.writeUInt8(xyztUnits, 123);
  for (let index = 0; index < 8; index += 1) buffer[352 + index] = index * 16;
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  await fs.writeFile(pathname, buffer);
}

export async function writeTinySequenceTiff(pathname, pixels, options = {}) {
  const width = options.width || pixels.length;
  const height = options.height || 1;
  assert.equal(pixels.length, width * height);
  const entries = 10;
  const ifdOffset = 8;
  const pixelOffset = ifdOffset + 2 + entries * 12 + 4;
  const buffer = Buffer.alloc(pixelOffset + pixels.length);
  buffer.write('II', 0, 'ascii');
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(ifdOffset, 4);
  buffer.writeUInt16LE(entries, ifdOffset);
  let cursor = ifdOffset + 2;
  const writeEntry = (tag, type, count, value) => {
    buffer.writeUInt16LE(tag, cursor);
    buffer.writeUInt16LE(type, cursor + 2);
    buffer.writeUInt32LE(count, cursor + 4);
    if (type === 3 && count === 1) buffer.writeUInt16LE(value, cursor + 8);
    else buffer.writeUInt32LE(value, cursor + 8);
    cursor += 12;
  };
  for (const entry of [
    [256, 4, 1, width],
    [257, 4, 1, height],
    [258, 3, 1, 8],
    [259, 3, 1, 1],
    [262, 3, 1, 1],
    [273, 4, 1, pixelOffset],
    [277, 3, 1, 1],
    [278, 4, 1, height],
    [279, 4, 1, pixels.length],
    [339, 3, 1, 1],
  ]) writeEntry(...entry);
  buffer.writeUInt32LE(0, cursor);
  Buffer.from(pixels).copy(buffer, pixelOffset);
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  await fs.writeFile(pathname, buffer);
}

export async function launchVoxelLab(extraArgs = [], opts = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxellab-electron-smoke-'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(tempDir, 'profile')}`, ...extraArgs],
    cwd: REPO_ROOT,
    env: { ...process.env, VOXELLAB_ELECTRON_SMOKE: '1', ...(opts.env || {}) },
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

export async function assertSmokeWindowVisibility(app, expectedVisible) {
  const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false);
  assert.equal(visible, expectedVisible);
}

export async function closeApp(app) {
  try {
    await app.close();
  } catch {
    // The Electron process may already be closing after a failed launch assertion.
  }
}

export async function assertShellFits(page) {
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

export async function assertMacWindowControlsAvoidSidebar(page, app) {
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

  if (process.env.VOXELLAB_ELECTRON_NATIVE_FULLSCREEN_SMOKE !== '1') {
    await page.click('#btn-show-left');
    await page.waitForFunction(() => !document.querySelector('.app')?.classList.contains('left-collapsed'), null, { timeout: 5_000 });
    return;
  }

  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
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
    if (process.platform === 'darwin') window.setSimpleFullScreen(false);
    else window.setFullScreen(false);
  });
  await page.waitForFunction(() => !document.documentElement.classList.contains('desktop-fullscreen'), null, { timeout: 10_000 });
  await page.click('#btn-show-left');
  await page.waitForFunction(() => !document.querySelector('.app')?.classList.contains('left-collapsed'), null, { timeout: 5_000 });
}
