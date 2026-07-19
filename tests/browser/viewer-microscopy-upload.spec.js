/* global Buffer, Event, File, Image, document, innerHeight, innerWidth, requestAnimationFrame, window */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { TextDecoder } from 'node:util';
import { deflateRawSync } from 'node:zlib';
import { expect, test } from '@playwright/test';

import {
  CALIBRATED_OME_TIFF,
  writeCalibratedChannelTimeOmeTiff,
  writeCalibratedOmeTiff,
} from '../fixtures/microscopy/calibrated-ome-tiff.mjs';
import { parseImageJRoiZip } from '../../js/microscopy/imagej-roi.js';
import {
  drawEllipseRoi,
  dropFiles,
  expectScaleBarFits,
  openUploadModal,
  parseCsvRows,
  routeConfig,
  waitForCanvasPaint,
} from './microscopy-upload-helpers.mjs';

async function ensurePanelOpen(page, panelSelector, visibleSelector) {
  const panel = page.locator(panelSelector);
  const target = page.locator(visibleSelector);
  if (await panel.evaluate(el => el.classList.contains('collapsed')).catch(() => false)) {
    await panel.locator('.sec-title').click();
  }
  await expect(panel).not.toHaveClass(/collapsed/);
  await expect(target.first()).toBeVisible();
}

async function drawAngleMeasurement(page) {
  if (!await page.locator('#btn-angle').isVisible()) {
    await page.locator('#toolbox-measure .toolbox-trigger').click();
  }
  if (!await page.locator('#btn-angle').evaluate(button => button.classList.contains('active'))) {
    await page.locator('#btn-angle').click();
  }
  const box = await page.locator('#view').boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.42);
  await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.42);
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.62);
}

async function writeTinySequenceTiff(path, pixels, options = {}) {
  const width = options.width || pixels.length;
  const height = options.height || 1;
  expect(pixels.length).toBe(width * height);
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
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
}

function sequencePlane(width, height, base) {
  return Array.from({ length: width * height }, (_, index) => (base + index) % 256);
}

async function writeImageJOvalRoi(path, { left, top, right, bottom }) {
  const buffer = Buffer.alloc(64);
  buffer.write('Iout', 0, 'ascii');
  buffer.writeUInt16BE(227, 4);
  buffer.writeUInt8(2, 6);
  buffer.writeInt16BE(top, 8);
  buffer.writeInt16BE(left, 10);
  buffer.writeInt16BE(bottom, 12);
  buffer.writeInt16BE(right, 14);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
}

async function writeImageJRectRoi(path, { left, top, right, bottom }) {
  const buffer = Buffer.alloc(64);
  buffer.write('Iout', 0, 'ascii');
  buffer.writeUInt16BE(227, 4);
  buffer.writeUInt8(1, 6);
  buffer.writeInt16BE(top, 8);
  buffer.writeInt16BE(left, 10);
  buffer.writeInt16BE(bottom, 12);
  buffer.writeInt16BE(right, 14);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
}

async function writeImageJPolygonRoi(path, { type = 0, points, position = null }) {
  const left = Math.min(...points.map(([x]) => x));
  const top = Math.min(...points.map(([, y]) => y));
  const right = Math.max(...points.map(([x]) => x));
  const bottom = Math.max(...points.map(([, y]) => y));
  const coordinatesBytes = points.length * 4;
  const header2Offset = 64 + coordinatesBytes;
  const buffer = Buffer.alloc(header2Offset + (position ? 32 : 0));
  buffer.write('Iout', 0, 'ascii');
  buffer.writeUInt16BE(227, 4);
  buffer.writeUInt8(type, 6);
  buffer.writeInt16BE(top, 8);
  buffer.writeInt16BE(left, 10);
  buffer.writeInt16BE(bottom, 12);
  buffer.writeInt16BE(right, 14);
  buffer.writeUInt16BE(points.length, 16);
  points.forEach(([x], index) => buffer.writeInt16BE(x - left, 64 + index * 2));
  points.forEach(([, y], index) => buffer.writeInt16BE(y - top, 64 + points.length * 2 + index * 2));
  if (position) {
    buffer.writeInt32BE(Math.floor(Number(position.z || 0)) || 0, 56);
    buffer.writeInt32BE(header2Offset, 60);
    buffer.writeInt32BE(Math.floor(Number(position.c || 0)) || 0, header2Offset + 4);
    buffer.writeInt32BE(Math.floor(Number(position.z || 0)) || 0, header2Offset + 8);
    buffer.writeInt32BE(Math.floor(Number(position.t || 0)) || 0, header2Offset + 12);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
}

async function writeImageJPointRoi(path, { points, position = null }) {
  await writeImageJPolygonRoi(path, { type: 10, points, position });
}

async function writeImageJLineRoi(path, { x1, y1, x2, y2, position = null }) {
  const header2Offset = 64;
  const buffer = Buffer.alloc(header2Offset + (position ? 32 : 0));
  buffer.write('Iout', 0, 'ascii');
  buffer.writeUInt16BE(227, 4);
  buffer.writeUInt8(3, 6);
  buffer.writeInt16BE(Math.min(y1, y2), 8);
  buffer.writeInt16BE(Math.min(x1, x2), 10);
  buffer.writeInt16BE(Math.max(y1, y2), 12);
  buffer.writeInt16BE(Math.max(x1, x2), 14);
  buffer.writeFloatBE(x1, 18);
  buffer.writeFloatBE(y1, 22);
  buffer.writeFloatBE(x2, 26);
  buffer.writeFloatBE(y2, 30);
  if (position) {
    buffer.writeInt32BE(Math.floor(Number(position.z || 0)) || 0, 56);
    buffer.writeInt32BE(header2Offset, 60);
    buffer.writeInt32BE(Math.floor(Number(position.c || 0)) || 0, header2Offset + 4);
    buffer.writeInt32BE(Math.floor(Number(position.z || 0)) || 0, header2Offset + 8);
    buffer.writeInt32BE(Math.floor(Number(position.t || 0)) || 0, header2Offset + 12);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
}

async function writeImageJAngleRoi(path, { points, position = null }) {
  await writeImageJPolygonRoi(path, { type: 9, points, position });
}

async function writeUnsupportedImageJRoi(path) {
  const buffer = Buffer.alloc(64);
  buffer.write('Iout', 0, 'ascii');
  buffer.writeUInt16BE(227, 4);
  buffer.writeUInt8(6, 6);
  buffer.writeInt16BE(4, 8);
  buffer.writeInt16BE(3, 10);
  buffer.writeInt16BE(14, 12);
  buffer.writeInt16BE(12, 14);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function writeCompressedImageJRoiZip(path, entries) {
  const parts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const payload = await readFile(entry.path);
    const method = Number.isFinite(entry.method) ? entry.method : 8;
    const compressed = method === 8 ? deflateRawSync(payload) : payload;
    const name = Buffer.from(entry.name);
    const descriptor = entry.dataDescriptor ? Buffer.alloc(16) : null;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    if (entry.dataDescriptor) local.writeUInt16LE(0x08, 6);
    local.writeUInt16LE(method, 8);
    if (!entry.dataDescriptor) {
      local.writeUInt32LE(crc32(payload), 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(payload.length, 22);
    }
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    if (descriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc32(payload), 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(payload.length, 12);
    }
    parts.push(local, compressed, ...(descriptor ? [descriptor] : []));
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    if (entry.dataDescriptor) central.writeUInt16LE(0x08, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(payload), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(payload.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + compressed.length + (descriptor?.length || 0);
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.concat([...parts, central, eocd]));
}

async function renderedTiffMetrics(tiffPath) {
  const bytes = await readFile(tiffPath);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entryCount = view.getUint16(8, true);
  const tags = new Map();
  for (let i = 0; i < entryCount; i += 1) {
    const offset = 10 + i * 12;
    tags.set(view.getUint16(offset, true), {
      count: view.getUint32(offset + 4, true),
      value: view.getUint32(offset + 8, true),
    });
  }
  const rational = (tag) => {
    const offset = tags.get(tag).value;
    return view.getUint32(offset, true) / view.getUint32(offset + 4, true);
  };
  const pixelOffset = tags.get(273).value;
  const pixelBytes = bytes.subarray(pixelOffset, pixelOffset + tags.get(279).value);
  const descriptionTag = tags.get(270);
  const description = new TextDecoder().decode(bytes.subarray(descriptionTag.value, descriptionTag.value + descriptionTag.count)).replace(/\0$/u, '');
  const width = tags.get(256).value;
  const height = tags.get(257).value;
  let roiBluePixels = 0;
  let scaleBarBrightPixels = 0;
  for (let i = 0; i < pixelBytes.length; i += 3) {
    if (pixelBytes[i] < 180 && pixelBytes[i + 1] > 130 && pixelBytes[i + 2] > 180) roiBluePixels += 1;
  }
  for (let y = Math.max(0, height - 18); y < height - 4; y += 1) {
    for (let x = Math.max(0, width - 84); x < width - 6; x += 1) {
      const offset = (y * width + x) * 3;
      if (pixelBytes[offset] > 230 && pixelBytes[offset + 1] > 230 && pixelBytes[offset + 2] > 230) scaleBarBrightPixels += 1;
    }
  }
  return {
    magic: [bytes[0], bytes[1], view.getUint16(2, true)],
    width,
    height,
    compression: tags.get(259).value,
    photometric: tags.get(262).value,
    samplesPerPixel: tags.get(277).value,
    xResolution: rational(282),
    yResolution: rational(283),
    resolutionUnit: tags.get(296).value,
    pixelByteCount: tags.get(279).value,
    description,
    roiBluePixels,
    scaleBarBrightPixels,
  };
}

async function renderedPngMetrics(page, pngPath) {
  const dataUrl = `data:image/png;base64,${(await readFile(pngPath)).toString('base64')}`;
  return page.evaluate(async (src) => {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = src;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let roiBluePixels = 0;
    let angleWhitePixels = 0;
    let scaleBarBrightPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] < 180 && pixels[i + 1] > 130 && pixels[i + 2] > 180) roiBluePixels += 1;
    }
    for (let y = 2; y <= 10; y += 1) {
      for (let x = 1; x <= 8; x += 1) {
        const offset = (y * canvas.width + x) * 4;
        if (pixels[offset] > 225 && pixels[offset + 1] > 225 && pixels[offset + 2] > 225) angleWhitePixels += 1;
      }
    }
    for (let y = Math.max(0, canvas.height - 18); y < canvas.height - 4; y += 1) {
      for (let x = Math.max(0, canvas.width - 84); x < canvas.width - 6; x += 1) {
        const offset = (y * canvas.width + x) * 4;
        if (pixels[offset] > 230 && pixels[offset + 1] > 230 && pixels[offset + 2] > 230) scaleBarBrightPixels += 1;
      }
    }
    return {
      width: canvas.width,
      height: canvas.height,
      roiBluePixels,
      angleWhitePixels,
      scaleBarBrightPixels,
    };
  }, dataUrl);
}

function uint16LeChunk(values) {
  const buffer = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => buffer.writeUInt16LE(value, index * 2));
  return buffer;
}

async function writeFourPageHyperstackTiff(path, description) {
  const width = 4;
  const height = 3;
  const pageCount = 4;
  const descriptionBytes = Buffer.from(`${description}\0`, 'utf8');
  const ifdEntryCounts = [11, 10, 10, 10];
  const ifdOffsets = [];
  let cursor = 8;
  for (const entryCount of ifdEntryCounts) {
    ifdOffsets.push(cursor);
    cursor += 2 + entryCount * 12 + 4;
  }
  const descriptionOffset = cursor;
  cursor += descriptionBytes.length;
  const pixelOffsets = [];
  const pixelsByPage = Array.from({ length: pageCount }, (_, pageIndex) => {
    const pixels = Buffer.alloc(width * height);
    for (let i = 0; i < pixels.length; i += 1) {
      pixels[i] = pageIndex < 2
        ? 20 + pageIndex * 55 + i
        : 230 - (pageIndex - 2) * 35 - i * 2;
    }
    pixelOffsets.push(cursor);
    cursor += pixels.length;
    return pixels;
  });
  const buffer = Buffer.alloc(cursor);
  buffer.write('II', 0, 'ascii');
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(ifdOffsets[0], 4);

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    let ifdCursor = ifdOffsets[pageIndex];
    const entries = [
      [256, 4, 1, width],
      [257, 4, 1, height],
      [258, 3, 1, 8],
      [259, 3, 1, 1],
      [262, 3, 1, 1],
      [273, 4, 1, pixelOffsets[pageIndex]],
      [277, 3, 1, 1],
      [278, 4, 1, height],
      [279, 4, 1, width * height],
      [339, 3, 1, 1],
    ];
    if (pageIndex === 0) entries.splice(5, 0, [270, 2, descriptionBytes.length, descriptionOffset]);
    buffer.writeUInt16LE(entries.length, ifdCursor);
    ifdCursor += 2;
    const writeEntry = (tag, type, count, value) => {
      buffer.writeUInt16LE(tag, ifdCursor);
      buffer.writeUInt16LE(type, ifdCursor + 2);
      buffer.writeUInt32LE(count, ifdCursor + 4);
      if (type === 3 && count === 1) buffer.writeUInt16LE(value, ifdCursor + 8);
      else buffer.writeUInt32LE(value, ifdCursor + 8);
      ifdCursor += 12;
    };
    for (const entry of entries) writeEntry(...entry);
    buffer.writeUInt32LE(ifdOffsets[pageIndex + 1] || 0, ifdCursor);
    pixelsByPage[pageIndex].copy(buffer, pixelOffsets[pageIndex]);
  }
  descriptionBytes.copy(buffer, descriptionOffset);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
}

async function writeHyperstackOmeTiff(path) {
  const description = '<OME><Image ID="Image:0"><Pixels DimensionOrder="XYZCT" SizeX="4" SizeY="3" SizeZ="2" SizeC="2" SizeT="1" PhysicalSizeX="0.5" PhysicalSizeY="0.25" PhysicalSizeZ="1.5" PhysicalSizeXUnit="µm"><Channel ID="Channel:0:0" Name="DAPI" Color="65535" EmissionWavelength="460" EmissionWavelengthUnit="nm"/><Channel ID="Channel:0:1" Name="GFP" Color="16711935" EmissionWavelength="510" EmissionWavelengthUnit="nm"/></Pixels></Image></OME>';
  await writeFourPageHyperstackTiff(path, description);
}

async function writeHyperstackImageJTiff(path) {
  const description = [
    'ImageJ=1.54',
    'images=4',
    'channels=2',
    'slices=2',
    'frames=1',
    'hyperstack=true',
    'mode=grayscale',
    'unit=um',
    'pixel_width=0.5',
    'pixel_height=0.25',
    'spacing=1.5',
  ].join('\n');
  await writeFourPageHyperstackTiff(path, description);
}

async function dropDirectory(page, selector, rootName, files) {
  const payload = await Promise.all(files.map(async ({ path, mimeType = 'application/octet-stream', relativePath }) => ({
    bytes: Array.from(await readFile(path)),
    name: path.split('/').pop(),
    mimeType,
    relativePath,
  })));
  const dataTransfer = await page.evaluateHandle(({ rootName: directoryName, items }) => {
    const directory = (name) => ({
      name,
      isFile: false,
      isDirectory: true,
      children: [],
      createReader() {
        const children = this.children;
        let sent = false;
        return {
          readEntries(resolve) {
            const batch = sent ? [] : children;
            sent = true;
            resolve(batch);
          },
        };
      },
    });
    const fileEntry = (item) => ({
      name: item.name,
      isFile: true,
      isDirectory: false,
      file(resolve) {
        resolve(new File([new Uint8Array(item.bytes)], item.name, { type: item.mimeType }));
      },
    });
    const root = directory(directoryName);
    for (const item of items) {
      const parts = item.relativePath.split('/').filter(Boolean);
      let cursor = root;
      for (const part of parts.slice(0, -1)) {
        let child = cursor.children.find(entry => entry.isDirectory && entry.name === part);
        if (!child) {
          child = directory(part);
          cursor.children.push(child);
        }
        cursor = child;
      }
      cursor.children.push(fileEntry({ ...item, name: parts.at(-1) || item.name }));
    }
    return { files: [], items: [{ webkitGetAsEntry: () => root }] };
  }, { rootName, items: payload });
  await page.locator(selector).evaluate((target, transfer) => {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    target.dispatchEvent(event);
  }, dataTransfer);
}

async function assertNoViewportOverflow(page) {
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

async function openDetailsPanelForViewport(page, viewport) {
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

test('upload modal can drag-and-drop a local OME-TIFF microscopy image with micron metadata', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('cells.ome.tiff');
  await writeCalibratedOmeTiff(omeTiffPath);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('cells');
  await expect(page.locator('#series-desc')).toContainText('OME-TIFF');
  await expect(page.locator('#slice-tot')).toHaveText('1');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#btn-mpr')).toBeHidden();
  await expect(page.locator('#btn-3d')).toBeHidden();
  await expect(page.locator('#meta')).toContainText('0.250 µm × 0.500 µm');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Slice thickness' })).toContainText('1.50 µm');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Calibration' })).toContainText('OME-TIFF metadata');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Spacing trust' })).toContainText('Trusted metadata');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source files' })).toContainText('cells.ome.tiff');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source warnings' })).toContainText('None');
  await waitForCanvasPaint(page, '#view');
  await expectScaleBarFits(page);

  const stateSnapshot = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const series = state.manifest.series[state.seriesIdx];
    return {
      imageDomain: series.imageDomain,
      physicalUnit: series.microscopy?.physicalUnit,
      pixelSpacing: series.pixelSpacing,
      sliceThickness: series.sliceThickness,
      spacingKnown: series._spacingKnown,
      sliceSpacingKnown: series._sliceSpacingKnown,
      hasRaw: series.hasRaw,
      rawCached: !!state._localRawVolumes?.[series.slug],
      capability: series.reconstructionCapability,
    };
  });
  expect(stateSnapshot).toEqual({
    imageDomain: 'microscopy',
    physicalUnit: 'µm',
    pixelSpacing: CALIBRATED_OME_TIFF.pixelSpacingMm,
    sliceThickness: CALIBRATED_OME_TIFF.sliceThicknessMm,
    spacingKnown: true,
    sliceSpacingKnown: true,
    hasRaw: false,
    rawCached: false,
    capability: '2d-only',
  });
});

test('upload modal keeps OME-TIFF with unsupported physical units uncalibrated', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('bad-unit-cells.ome.tiff');
  await writeCalibratedOmeTiff(omeTiffPath, { physicalUnit: 'furlong' });

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('bad-unit-cells');
  await expect(page.locator('#series-desc')).toContainText('OME-TIFF');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#btn-mpr')).toBeHidden();
  await expect(page.locator('#btn-3d')).toBeHidden();
  await expect(page.locator('#meta .meta-row').filter({ has: page.locator('.mk', { hasText: 'Pixel spacing' }) })).toContainText('—');
  await expect(page.locator('#meta .meta-row').filter({ has: page.locator('.mk', { hasText: 'Calibration' }) })).toContainText('Uncalibrated');
  await expect(page.locator('#meta .meta-row').filter({ has: page.locator('.mk', { hasText: 'Spacing trust' }) })).toContainText('Unknown · XY unit unsupported');
  await expect(page.locator('#meta .meta-row').filter({ has: page.locator('.mk', { hasText: 'Source warnings' }) })).toContainText('Unsupported X unit');
  await expect(page.locator('#meta .meta-row').filter({ has: page.locator('.mk', { hasText: 'Source warnings' }) })).toContainText('Unsupported Y unit');
  await waitForCanvasPaint(page, '#view');
  await expect(page.locator('#scale-bar')).toBeHidden();
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await expect(page.locator('#microscopy-calibration')).toHaveText('XY uncalibrated · 3 warnings');

  const stateSnapshot = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const series = state.manifest.series[state.seriesIdx];
    return {
      spacingKnown: series._spacingKnown,
      pixelSpacing: series.pixelSpacing,
      sourceWarnings: series.microscopyDataset?.source.warnings,
    };
  });
  expect(stateSnapshot).toMatchObject({
    spacingKnown: false,
    pixelSpacing: [0, 0],
    sourceWarnings: [
      'missing_xy_physical_size',
      'unsupported_x_physical_unit',
      'unsupported_y_physical_unit',
    ],
  });
});

test('upload modal opens OME-TIFF microscopy folders with ordinary lab metadata JSON skipped', async ({ page }, testInfo) => {
  const folderPath = testInfo.outputPath('ome-tiff-folder-with-json');
  const omeTiffPath = `${folderPath}/cells.ome.tiff`;
  await writeCalibratedOmeTiff(omeTiffPath);
  await writeFile(`${folderPath}/metadata.json`, JSON.stringify({ lab: 'example', note: 'ordinary acquisition metadata' }));
  await writeFile(`${folderPath}/broken.json`, '{not json');

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await page.locator('#upload-folder-input').setInputFiles(folderPath);

  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-name')).toHaveText('cells');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Calibration' })).toContainText('OME-TIFF metadata');
  await expect(page.locator('#notify-container .notify-text')).toContainText('Local intake: 1 openable file (OME-TIFF) selected after checking 3 files; skipped 2 unsupported files');
  await expect(page.locator('#notify-container .notify-text')).toContainText('metadata.json (unrecognized JSON sidecar)');
  await expect(page.locator('#notify-container .notify-text')).toContainText('broken.json (invalid JSON sidecar)');
  await waitForCanvasPaint(page, '#view');
});

test('local microscopy upload clears the public empty-state viewer chrome', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('public-empty-cells.ome.tiff');
  await writeCalibratedOmeTiff(omeTiffPath);

  await page.route('**/data/manifest.json', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ patient: 'anonymous', studyDate: '', series: [] }),
    });
  });
  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await expect(page.locator('#canvas-wrap')).toHaveClass(/no-series/);

  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('public-empty-cells');
  await expect(page.locator('#series-list li')).toHaveCount(1);
  await expect(page.locator('#canvas-wrap')).not.toHaveClass(/no-series/);
  await expect(page.locator('#empty-state')).toBeHidden();
  await waitForCanvasPaint(page, '#view');
  await expect(page.locator('#view')).toBeVisible();
  await expectScaleBarFits(page);
});

test('upload modal can open signed grayscale OME-TIFF microscopy planes', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('signed-cells.ome.tiff');
  await writeCalibratedOmeTiff(omeTiffPath, { width: 2, height: 1, pixels: [-128, 127], sampleFormat: 2 });

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('signed-cells');
  await expect(page.locator('#series-desc')).toContainText('OME-TIFF');
  await expect(page.locator('#meta')).toContainText('0.250 µm × 0.500 µm');
  await waitForCanvasPaint(page, '#view');
});

test('upload modal opens a local uncompressed chunked OME-Zarr microscopy array', async ({ page }, testInfo) => {
  const rootAttrsPath = testInfo.outputPath('zattrs.json');
  const levelArrayPath = testInfo.outputPath('zarray.json');
  const chunks = [];
  for (let c = 0; c < 2; c += 1) {
    for (let cy = 0; cy < 2; cy += 1) {
      for (let cx = 0; cx < 2; cx += 1) {
        const yStart = cy * 2;
        const xStart = cx * 5;
        const values = [];
        for (let y = 0; y < 2; y += 1) {
          for (let x = 0; x < 5; x += 1) {
            values.push(yStart + y < 4 && xStart + x < 8
              ? (c * 1000) + ((yStart + y) * 100) + ((xStart + x) * 10)
              : 0);
          }
        }
        const chunkPath = testInfo.outputPath(`zarr-chunk-${c}-${cy}-${cx}.bin`);
        await writeFile(chunkPath, uint16LeChunk(values));
        chunks.push({ path: chunkPath, relativePath: `0/${c}.${cy}.${cx}`, mimeType: 'application/octet-stream' });
      }
    }
  }
  await writeFile(rootAttrsPath, JSON.stringify({
    ome: {
      multiscales: [{
        version: '0.4',
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
      omero: {
        channels: [{
          label: 'DAPI',
          color: '0000FF',
          family: 'linear',
          window: { min: 0, max: 4095, start: 100, end: 220 },
        }, {
          label: 'GFP',
          color: '00FF00',
          family: 'linear',
          window: { min: 0, max: 4095, start: 10, end: 1800 },
        }],
      },
    },
  }));
  await writeFile(levelArrayPath, JSON.stringify({
    zarr_format: 2,
    shape: [2, 4, 8],
    chunks: [1, 2, 5],
    dtype: '<u2',
    compressor: null,
    order: 'C',
    filters: null,
    fill_value: 0,
  }));

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  const initialCount = await page.locator('#series-list li').count();
  await dropDirectory(page, '#upload-zone', 'cells.zarr', [
    { path: rootAttrsPath, relativePath: '.zattrs', mimeType: 'application/json' },
    { path: levelArrayPath, relativePath: '0/.zarray', mimeType: 'application/json' },
    ...chunks,
  ]);

  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#series-name')).toHaveText('cells');
  await expect(page.locator('#series-desc')).toContainText('OME-Zarr');
  await expect(page.locator('#meta')).toContainText('0.250 µm × 0.500 µm');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Calibration' })).toContainText('OME-Zarr metadata');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Spacing trust' })).toContainText('Trusted metadata');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source warnings' })).toContainText('OMERO transitional metadata');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source warnings' })).not.toContainText('Z spacing missing');
  await waitForCanvasPaint(page, '#view');
  await expectScaleBarFits(page);
  await expect(page.locator('#microscopy-stack-panel')).toBeVisible();
  await page.locator('#microscopy-stack-panel .sec-title').click();
  await expect(page.locator('.hyperstack-channel-meta')).toContainText('DAPI · LUT linear · range 100-220');
  await expect(page.locator('#microscopy-display-range-min')).toHaveValue('100');
  await expect(page.locator('#microscopy-display-range-max')).toHaveValue('220');
  const rangeMetaUi = await page.locator('.hyperstack-channel-meta').evaluate((row) => {
    const text = row.querySelector('.hyperstack-channel-text');
    return {
      textOverflow: text.scrollWidth > text.clientWidth + 1,
      rowWidth: Math.round(row.getBoundingClientRect().width),
      textWidth: Math.round(text.getBoundingClientRect().width),
    };
  });
  expect(rangeMetaUi.textOverflow).toBe(false);
  expect(rangeMetaUi.textWidth).toBeLessThanOrEqual(rangeMetaUi.rowWidth);
  const beforeRangePixel = await page.locator('#view').evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return Array.from(ctx.getImageData(3, 1, 1, 1).data);
  });
  await page.locator('#microscopy-display-range-min').evaluate((input) => {
    input.value = '0';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('#microscopy-display-range-max').evaluate((input) => {
    input.value = '370';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('#microscopy-display-range-min')).toHaveValue('0');
  await expect(page.locator('#microscopy-display-range-max')).toHaveValue('370');
  const afterRangePixel = await page.locator('#view').evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return Array.from(ctx.getImageData(3, 1, 1, 1).data);
  });
  expect(afterRangePixel).not.toEqual(beforeRangePixel);
  const rangeControlUi = await page.locator('.hyperstack-range-group').evaluate((group) => ({
    scrollWidth: group.scrollWidth,
    clientWidth: group.clientWidth,
    minOverflow: group.querySelector('#microscopy-display-range-min').scrollWidth > group.querySelector('#microscopy-display-range-min').clientWidth + 1,
    maxOverflow: group.querySelector('#microscopy-display-range-max').scrollWidth > group.querySelector('#microscopy-display-range-max').clientWidth + 1,
  }));
  expect(rangeControlUi.scrollWidth).toBeLessThanOrEqual(rangeControlUi.clientWidth + 1);
  expect(rangeControlUi.minOverflow).toBe(false);
  expect(rangeControlUi.maxOverflow).toBe(false);

  const stateSnapshot = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const series = state.manifest.series[state.seriesIdx];
    return {
      imageDomain: series.imageDomain,
      physicalUnit: series.microscopy?.physicalUnit,
      pixelSpacing: series.pixelSpacing,
      sizeC: series.microscopy?.sizeC,
      sourceFormat: series.microscopyDataset?.source.originalFormat,
      localStackKeys: Object.keys(state._localMicroscopyStacks?.[series.slug] || {}).sort(),
      displayRangeSource: series.microscopyDataset?.channels?.[0]?.displayRangeSource,
      displayRange: series.microscopyDataset?.channels?.[0]?.displayRange,
      rawRange: state._localMicroscopyStacks?.[series.slug]?.['0|0']?.[0]?._microscopyRawRange,
      displayByteRange: state._localMicroscopyStacks?.[series.slug]?.['0|0']?.[0]?._microscopyDisplayByteRange,
    };
  });
  expect(stateSnapshot).toMatchObject({
    imageDomain: 'microscopy',
    physicalUnit: 'µm',
    pixelSpacing: [0.00025, 0.0005],
    sizeC: 2,
    sourceFormat: 'OME-Zarr',
    localStackKeys: ['0|0', '1|0'],
    displayRangeSource: 'user',
    displayRange: [0, 370],
    rawRange: [0, 370],
  });
  expect(stateSnapshot.displayByteRange).toEqual([0, 255]);
});

test('upload modal rejects mixed microscopy TIFF and DICOM selections', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('mixed-cells.ome.tiff');
  const dicomPath = testInfo.outputPath('mixed-source.dcm');
  await writeCalibratedOmeTiff(omeTiffPath);
  await mkdir(dirname(dicomPath), { recursive: true });
  await writeFile(dicomPath, Buffer.from([0, 1, 2, 3]));

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropFiles(page, '#upload-zone', [
    { path: omeTiffPath, mimeType: 'image/tiff' },
    { path: dicomPath, mimeType: 'application/dicom' },
  ]);

  const status = page.locator('#upload-status');
  await expect(status).toContainText('Mixed native image families need separate imports for now');
  await expect(status).toContainText('1 microscopy TIFF file (mixed-cells.ome.tiff)');
  await expect(status).toContainText('1 DICOM or derived-object file (mixed-source.dcm)');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount);
});

test('co-dropped unsupported ImageJ ROI sidecar opens the image and reports a skipped sidecar', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('unsupported-roi-cells.ome.tiff');
  const roiPath = testInfo.outputPath('unsupported-cell.roi');
  await writeCalibratedOmeTiff(omeTiffPath);
  await writeUnsupportedImageJRoi(roiPath);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropFiles(page, '#upload-zone', [
    { path: omeTiffPath, mimeType: 'image/tiff' },
    { path: roiPath, mimeType: 'application/octet-stream' },
  ]);

  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-name')).toHaveText('unsupported-roi-cells');
  await waitForCanvasPaint(page, '#view');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#notify-container .notify-text')).toContainText(
    'Skipped 1 ImageJ ROI entry: unsupported-cell.roi (Unsupported ImageJ ROI type).',
  );
});

test('co-dropped ImageJ ROI sidecars keep C/T provenance and skip out-of-range positions', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('positioned-roi-cells.ome.tiff');
  const validRoiPath = testInfo.outputPath('gfp-timepoint-spots.roi');
  const outOfRangeRoiPath = testInfo.outputPath('missing-channel-spots.roi');
  const outOfBoundsRoiPath = testInfo.outputPath('clipped-spots.roi');
  await writeCalibratedChannelTimeOmeTiff(omeTiffPath);
  await writeImageJPointRoi(validRoiPath, { points: [[4, 5], [10, 8]], position: { c: 2, z: 1, t: 2 } });
  await writeImageJPointRoi(outOfRangeRoiPath, { points: [[6, 6]], position: { c: 3, z: 1, t: 1 } });
  await writeImageJPointRoi(outOfBoundsRoiPath, { points: [[4, 5], [99, 8]], position: { c: 2, z: 1, t: 2 } });

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [
    { path: omeTiffPath, mimeType: 'image/tiff' },
    { path: validRoiPath, mimeType: 'application/octet-stream' },
    { path: outOfRangeRoiPath, mimeType: 'application/octet-stream' },
    { path: outOfBoundsRoiPath, mimeType: 'application/octet-stream' },
  ]);

  await expect(page.locator('#series-name')).toHaveText('positioned-roi-cells');
  await waitForCanvasPaint(page, '#view');
  await ensurePanelOpen(page, '#roi-results-panel', '#roi-results-count');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  const row = page.locator('[data-roi-result-row]');
  await expect(row).toContainText('gfp-timepoint-spots');
  await expect(row).toContainText('GFP');
  await expect(row).toContainText('T2');
  await expect(row).not.toContainText('missing-channel-spots');
  await expect(row).not.toContainText('clipped-spots');
  await expect(page.locator('#notify-container .notify-text')).toContainText([
    'Imported 1 ImageJ ROI onto the active microscopy series.',
    'Skipped 2 ImageJ ROI entries: missing-channel-spots (did not fit active series), clipped-spots (did not fit active series).',
  ]);
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await page.locator('#microscopy-channel-select').selectOption('1');
  await page.locator('#microscopy-time-select').selectOption('1');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .roi-point')).toHaveCount(2);
});

test('co-dropped ImageJ ROI sidecar imports onto calibrated microscopy TIFF results', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('roi-sidecar-cells.ome.tiff');
  const roiPath = testInfo.outputPath('cell-body.roi');
  const rectRoiPath = testInfo.outputPath('cell-box.roi');
  const freehandRoiPath = testInfo.outputPath('cell-freehand.roi');
  const freehandPoints = [[2, 3], [11, 3], [9, 10], [3, 9]];
  const pointRoiPath = testInfo.outputPath('cell-spots.roi');
  const pointPoints = [[4, 5], [10, 8]];
  await writeCalibratedOmeTiff(omeTiffPath);
  await writeImageJOvalRoi(roiPath, { left: 3, top: 4, right: 12, bottom: 13 });
  await writeImageJRectRoi(rectRoiPath, { left: 1, top: 2, right: 8, bottom: 9 });
  await writeImageJPolygonRoi(freehandRoiPath, { type: 7, points: freehandPoints });
  await writeImageJPointRoi(pointRoiPath, { points: pointPoints });

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [
    { path: omeTiffPath, mimeType: 'image/tiff' },
    { path: roiPath, mimeType: 'application/octet-stream' },
    { path: rectRoiPath, mimeType: 'application/octet-stream' },
    { path: freehandRoiPath, mimeType: 'application/octet-stream' },
    { path: pointRoiPath, mimeType: 'application/octet-stream' },
  ]);

  await expect(page.locator('#series-desc')).toContainText('OME-TIFF');
  await waitForCanvasPaint(page, '#view');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(4);
  await expect(page.locator('#overlay-svg .roi-point')).toHaveCount(2);
  if (await page.locator('#roi-results-panel').evaluate(panel => panel.classList.contains('collapsed'))) {
    await page.locator('#roi-results-panel .sec-title').click();
  }
  await expect(page.locator('#roi-results-count')).toHaveText('4');
  const rows = page.locator('[data-roi-result-row]');
  await expect(rows.filter({ hasText: 'cell-body' })).toContainText('ellipse');
  await expect(rows.filter({ hasText: 'cell-body' })).toContainText('µm²');
  await expect(rows.filter({ hasText: 'cell-box' })).toContainText('polygon');
  await expect(rows.filter({ hasText: 'cell-box' })).toContainText('µm²');
  await expect(rows.filter({ hasText: 'cell-freehand' })).toContainText('polygon');
  await expect(rows.filter({ hasText: 'cell-freehand' })).toContainText('µm²');
  const pointRow = rows.filter({ hasText: 'cell-spots' });
  await expect(pointRow).toContainText('point');
  const pointMetrics = await pointRow.locator('.roi-result-metrics div').evaluateAll(items => Object.fromEntries(items.map((item) => {
    const label = item.querySelector('span')?.textContent || '';
    const value = item.querySelector('b')?.textContent || '';
    return [label, value];
  })));
  expect(pointMetrics.Count).toBe('2');
  expect(pointMetrics.Pixels).toBe('2');

  const csvDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const csvDownload = await csvDownloadPromise;
  const csv = await readFile(await csvDownload.path(), 'utf8');
  const csvRows = parseCsvRows(csv);
  expect(csvRows.map(row => row.label).sort()).toEqual(['cell-body', 'cell-box', 'cell-freehand', 'cell-spots']);
  for (const row of csvRows) {
    expect(row.source_format).toBe('OME-TIFF');
    expect(row.xy_spacing_row_mm).toBe('0.00025');
    expect(row.xy_spacing_col_mm).toBe('0.0005');
    expect(row.calibration_unit).toBe('µm');
    expect(row.calibration_source).toBe('metadata');
    if (row.kind !== 'point') {
      expect(Number(row.area_um2)).toBeGreaterThan(0);
      expect(Number(row.area_mm2)).toBeGreaterThan(0);
    }
    expect(Number(row.pixels)).toBeGreaterThan(0);
  }
  expect(csvRows.find(row => row.label === 'cell-body')?.kind).toBe('ellipse');
  expect(csvRows.find(row => row.label === 'cell-box')?.kind).toBe('polygon');
  expect(csvRows.find(row => row.label === 'cell-freehand')?.kind).toBe('polygon');
  expect(csvRows.find(row => row.label === 'cell-spots')).toMatchObject({ kind: 'point', count: '2', pixels: '2' });

  await ensurePanelOpen(page, '#roi-results-panel', '#roi-results-imagej-export');
  await expect(page.locator('#roi-results-imagej-export')).toBeEnabled();
  const imagejDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-imagej-export').click();
  const imagejDownload = await imagejDownloadPromise;
  expect(imagejDownload.suggestedFilename()).toMatch(/^voxellab-imagej-rois-.*\.zip$/);
  const imagejZipPath = testInfo.outputPath('exported-imagej-rois.zip');
  await imagejDownload.saveAs(imagejZipPath);
  const exportedRois = await parseImageJRoiZip(await readFile(imagejZipPath));
  expect(exportedRois).toHaveLength(4);
  const exportedByName = new Map(exportedRois.map(roi => [roi.name, roi]));
  expect(exportedByName.get('cell-body_z1_c1_t1')?.label).toBe('cell-body');
  expect(exportedByName.get('cell-body_z1_c1_t1')?.shape).toBe('ellipse');
  expect(exportedByName.get('cell-body_z1_c1_t1')?.points).toEqual([[3, 4], [12, 13]]);
  expect(exportedByName.get('cell-box_z1_c1_t1')?.label).toBe('cell-box');
  expect(exportedByName.get('cell-box_z1_c1_t1')?.shape).toBe('polygon');
  expect(exportedByName.get('cell-box_z1_c1_t1')?.points).toEqual([[1, 2], [8, 2], [8, 9], [1, 9]]);
  expect(exportedByName.get('cell-freehand_z1_c1_t1')?.label).toBe('cell-freehand');
  expect(exportedByName.get('cell-freehand_z1_c1_t1')?.shape).toBe('polygon');
  expect(exportedByName.get('cell-freehand_z1_c1_t1')?.points).toEqual(freehandPoints);
  expect(exportedByName.get('cell-spots_z1_c1_t1')?.label).toBe('cell-spots');
  expect(exportedByName.get('cell-spots_z1_c1_t1')?.shape).toBe('point');
  expect(exportedByName.get('cell-spots_z1_c1_t1')?.points).toEqual(pointPoints);

  const replayOmeTiffPath = testInfo.outputPath('roi-zip-replay-cells.ome.tiff');
  await writeCalibratedOmeTiff(replayOmeTiffPath);
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await dropFiles(page, '#upload-zone', [
    { path: replayOmeTiffPath, mimeType: 'image/tiff' },
    { path: imagejZipPath, mimeType: 'application/zip' },
  ]);
  await expect(page.locator('#series-name')).toHaveText('roi-zip-replay-cells');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(4);
  await expect(page.locator('#overlay-svg .roi-point')).toHaveCount(2);
  await expect(page.locator('#roi-results-count')).toHaveText('4');
  await expect(page.locator('[data-roi-result-row]').filter({ hasText: 'cell-body' })).toContainText('ellipse');
  await expect(page.locator('[data-roi-result-row]').filter({ hasText: 'cell-box' })).toContainText('polygon');
  await expect(page.locator('[data-roi-result-row]').filter({ hasText: 'cell-freehand' })).toContainText('polygon');
  await expect(page.locator('[data-roi-result-row]').filter({ hasText: 'cell-spots' })).toContainText('point');
});

test('ImageJ ROI sidecar imports onto the active microscopy series', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('active-sidecar-cells.ome.tiff');
  const roiPath = testInfo.outputPath('active-sidecar-cell.roi');
  await writeCalibratedOmeTiff(omeTiffPath);
  await writeImageJOvalRoi(roiPath, { left: 3, top: 4, right: 12, bottom: 13 });

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('active-sidecar-cells');
  await waitForCanvasPaint(page, '#view');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);

  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await dropFiles(page, '#upload-zone', [{ path: roiPath, mimeType: 'application/octet-stream' }]);

  await expect(page.locator('#upload-modal')).toBeHidden();
  await ensurePanelOpen(page, '#roi-results-panel', '#roi-results-count');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  await expect(page.locator('[data-roi-result-row]').filter({ hasText: 'active-sidecar-cell' })).toContainText('µm²');
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Imported 1 ImageJ ROI' }))
    .toContainText('Imported 1 ImageJ ROI onto the active microscopy series.');
});

test('ImageJ ROI ZIP sidecar imports onto the active microscopy series', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('active-sidecar-zip-cells.ome.tiff');
  const roiPath = testInfo.outputPath('active-sidecar-zip-cell.roi');
  const linePath = testInfo.outputPath('active-sidecar-zip-line.roi');
  const zipPath = testInfo.outputPath('active-sidecar-rois.zip');
  await writeCalibratedOmeTiff(omeTiffPath);
  await writeImageJOvalRoi(roiPath, { left: 4, top: 5, right: 13, bottom: 15 });
  await writeImageJLineRoi(linePath, { x1: 2, y1: 4, x2: 10, y2: 4 });
  await writeCompressedImageJRoiZip(zipPath, [
    { name: 'session/active-sidecar-zip-cell.roi', path: roiPath },
    { name: 'session/measurements/active-sidecar-zip-line.roi', path: linePath, dataDescriptor: true },
  ]);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('active-sidecar-zip-cells');
  await waitForCanvasPaint(page, '#view');
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await dropFiles(page, '#upload-zone', [{ path: zipPath, mimeType: 'application/zip' }]);

  await expect(page.locator('#upload-modal')).toBeHidden();
  await ensurePanelOpen(page, '#roi-results-panel', '#roi-results-count');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await expect(page.locator('#roi-results-count')).toHaveText('2');
  await expect(page.getByRole('button', { name: /^Show active-sidecar-zip-cell / })).toContainText('ellipse');
  await expect(page.getByRole('button', { name: /^Show active-sidecar-zip-line / })).toContainText('Calibrated length');
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Imported 2 ImageJ ROIs' }))
    .toContainText('Imported 2 ImageJ ROIs onto the active microscopy series.');
});

test('ImageJ ROI ZIP sidecar names unsupported ZIP compression in skipped entries', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('active-sidecar-zip-compression-cells.ome.tiff');
  const roiPath = testInfo.outputPath('active-sidecar-zip-compression-cell.roi');
  const unsupportedPath = testInfo.outputPath('active-sidecar-zip-unsupported-compression.roi');
  const zipPath = testInfo.outputPath('active-sidecar-rois-unsupported-compression.zip');
  await writeCalibratedOmeTiff(omeTiffPath);
  await writeImageJOvalRoi(roiPath, { left: 4, top: 5, right: 13, bottom: 15 });
  await writeUnsupportedImageJRoi(unsupportedPath);
  await writeCompressedImageJRoiZip(zipPath, [
    { name: 'session/unsupported-compressed.roi', path: unsupportedPath, method: 12, dataDescriptor: true },
    { name: 'session/active-sidecar-zip-compression-cell.roi', path: roiPath },
  ]);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('active-sidecar-zip-compression-cells');
  await waitForCanvasPaint(page, '#view');
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await dropFiles(page, '#upload-zone', [{ path: zipPath, mimeType: 'application/zip' }]);

  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  const skippedNotice = page.locator('#notify-container .notify-text', { hasText: 'Skipped 1 ImageJ ROI entry' });
  await expect(skippedNotice).toContainText('unsupported-compressed.roi (Unsupported ZIP compression; only stored or deflated ImageJ ROI entries are supported)');
  await expect(skippedNotice).not.toContainText('unsupported_compression');
});

test('active microscopy sidecar-only import stays open when nothing matches', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('active-sidecar-mismatch-cells.ome.tiff');
  const recipePaths = Array.from({ length: 4 }, (_, index) =>
    testInfo.outputPath(`active-sidecar-mismatch-recipe-${index + 1}.json`)
  );
  await writeCalibratedOmeTiff(omeTiffPath);
  for (const [index, recipePath] of recipePaths.entries()) {
    await writeFile(recipePath, JSON.stringify({
      schema: 'voxellab.microscopyWorkflowRecipe.v1',
      kind: 'microscopy-workflow-recipe',
      target: {
        imageDomain: 'microscopy',
        sourceFormat: 'OME-TIFF',
        geometry: { width: 99 + index, height: 16, slices: 1, sizeZ: 1, sizeC: 1, sizeT: 1 },
      },
      requirements: { calibrationRequired: false, measurementPrerequisite: 'none' },
      view: { sliceIndex: 0 },
      stack: { channelIndex: 0, timeIndex: 0, compositeEnabled: false, compositeChannels: [true] },
      channels: [],
      exportPreferences: {},
    }));
  }

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('active-sidecar-mismatch-cells');
  await waitForCanvasPaint(page, '#view');
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await dropFiles(page, '#upload-zone', recipePaths.map(path => ({ path, mimeType: 'application/json' })));

  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toContainText('No sidecars matched the active microscopy series');
  await expect(page.locator('#upload-status')).toContainText('active-sidecar-mismatch-recipe-1.json (Recipe geometry/channel/time dimensions do not match the active microscopy series)');
  await expect(page.locator('#upload-status')).toContainText('plus 1 more file');
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Skipped 4 microscopy workflow recipes' }))
    .toContainText('plus 1 more file');
  await expect(page.locator('#microscopy-recipe-status'))
    .toContainText('Recipe geometry/channel/time dimensions do not match the active microscopy series.');
});

test('active microscopy unsupported ImageJ ROI sidecar names the rejected ROI reason', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('active-unsupported-roi-cells.ome.tiff');
  const roiPath = testInfo.outputPath('active-unsupported-cell.roi');
  await writeCalibratedOmeTiff(omeTiffPath);
  await writeUnsupportedImageJRoi(roiPath);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('active-unsupported-roi-cells');
  await waitForCanvasPaint(page, '#view');
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await dropFiles(page, '#upload-zone', [{ path: roiPath, mimeType: 'application/octet-stream' }]);

  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toContainText(
    'Unsupported ImageJ ROI sidecar: active-unsupported-cell.roi (Unsupported ImageJ ROI type).',
  );
  await expect(page.locator('#upload-status')).toContainText('rect, oval, straight-line, open PolyLine, angle, polygon/freehand, traced, and point');
});

test('active microscopy unsupported ImageJ ROI sidecar error list is bounded', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('active-bounded-unsupported-roi-cells.ome.tiff');
  const roiPaths = Array.from({ length: 5 }, (_, index) => (
    testInfo.outputPath(`active-unsupported-cell-${index + 1}.roi`)
  ));
  await writeCalibratedOmeTiff(omeTiffPath);
  await Promise.all(roiPaths.map(writeUnsupportedImageJRoi));

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('active-bounded-unsupported-roi-cells');
  await waitForCanvasPaint(page, '#view');
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await dropFiles(page, '#upload-zone', roiPaths.map(path => ({ path, mimeType: 'application/octet-stream' })));

  const status = page.locator('#upload-status');
  await expect(status).toContainText('Unsupported ImageJ ROI sidecars');
  await expect(status).toContainText('active-unsupported-cell-1.roi (Unsupported ImageJ ROI type)');
  await expect(status).toContainText('active-unsupported-cell-3.roi (Unsupported ImageJ ROI type)');
  await expect(status).toContainText('plus 2 more files');
  await expect(status).not.toContainText('active-unsupported-cell-4.roi');
  await expect(status).not.toContainText('active-unsupported-cell-5.roi');
});

test('active microscopy ROI results sidecar-only import explains calibration mismatch', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('active-sidecar-roi-mismatch-cells.ome.tiff');
  const roiResultsPath = testInfo.outputPath('active-sidecar-roi-mismatch-results.json');
  await writeCalibratedOmeTiff(omeTiffPath);
  await writeFile(roiResultsPath, JSON.stringify({
    schema: 'voxellab.roiResults.v1',
    series: { slug: 'active-sidecar-roi-mismatch-cells', name: 'active-sidecar-roi-mismatch-cells', width: 16, height: 16, slices: 1 },
    source: { imageDomain: 'microscopy' },
    calibration: { xyKnown: true, rowMm: 0.001, colMm: 0.001, displayUnit: 'µm' },
    rows: [{
      roiObjectId: 'roi:active-sidecar-roi-mismatch-cells|0:1',
      sliceIndex: 0,
      kind: 'polygon',
      points: [[1, 1], [8, 1], [8, 7], [1, 7]],
      areaMm2: 0.000021,
    }],
  }));

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);

  await expect(page.locator('#series-name')).toHaveText('active-sidecar-roi-mismatch-cells');
  await waitForCanvasPaint(page, '#view');
  const persistenceKey = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const { seriesPersistenceKey } = await import('/js/series/series-identity.js');
    return seriesPersistenceKey(state.manifest.series[state.seriesIdx], state.manifest);
  });
  const mismatchBundle = JSON.parse(await readFile(roiResultsPath, 'utf8'));
  mismatchBundle.series.persistenceKey = persistenceKey;
  await writeFile(roiResultsPath, `${JSON.stringify(mismatchBundle, null, 2)}\n`);
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await dropFiles(page, '#upload-zone', [{ path: roiResultsPath, mimeType: 'application/json' }]);

  await expect(page.locator('#upload-modal')).toBeVisible();
  await expect(page.locator('#upload-status')).toContainText('No sidecars matched the active microscopy series: active-sidecar-roi-mismatch-results.json (ROI bundle calibration does not match this microscopy stack)');
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Skipped 1 ROI sidecar' }))
    .toContainText('active-sidecar-roi-mismatch-results.json (ROI bundle calibration does not match this microscopy stack)');
});

test('co-dropped compressed ImageJ ROI Manager ZIP imports supported ROI sidecars', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('compressed-roi-cells.ome.tiff');
  const roiPath = testInfo.outputPath('compressed-cell.roi');
  const linePath = testInfo.outputPath('compressed-line.roi');
  const anglePath = testInfo.outputPath('compressed-angle.roi');
  const unsupportedRoiPath = testInfo.outputPath('compressed-unsupported.roi');
  const zipPath = testInfo.outputPath('compressed-rois.zip');
  const anglePoints = [[6, 4], [2, 4], [6, 8]];
  await writeCalibratedOmeTiff(omeTiffPath);
  await writeImageJOvalRoi(roiPath, { left: 4, top: 5, right: 13, bottom: 15 });
  await writeImageJLineRoi(linePath, { x1: 2, y1: 4, x2: 10, y2: 4 });
  await writeImageJAngleRoi(anglePath, { points: anglePoints });
  await writeUnsupportedImageJRoi(unsupportedRoiPath);
  await writeCompressedImageJRoiZip(zipPath, [
    { name: 'roi-set/session-a/compressed-cell.roi', path: roiPath },
    { name: 'roi-set\\session-a\\measurements\\compressed-line.roi', path: linePath, dataDescriptor: true },
    { name: 'roi-set/session-a/angles/compressed-angle.roi', path: anglePath },
    { name: 'roi-set/session-a/unsupported-cell.roi', path: unsupportedRoiPath },
  ]);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [
    { path: omeTiffPath, mimeType: 'image/tiff' },
    { path: zipPath, mimeType: 'application/zip' },
  ]);

  await expect(page.locator('#series-name')).toHaveText('compressed-roi-cells');
  await waitForCanvasPaint(page, '#view');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group .m-label')).toHaveText('26.6°');
  if (await page.locator('#roi-results-panel').evaluate(panel => panel.classList.contains('collapsed'))) {
    await page.locator('#roi-results-panel .sec-title').click();
  }
  await expect(page.locator('#roi-results-count')).toHaveText('3');
  const rows = page.locator('[data-roi-result-row]');
  await expect(rows.filter({ hasText: 'compressed-cell' })).toContainText('ellipse');
  await expect(rows.filter({ hasText: 'compressed-line' })).toContainText('Calibrated length');
  await expect(rows.filter({ hasText: 'compressed-angle' })).toContainText('Calibrated angle');
  await expect.poll(async () => (await rows.allTextContents()).join('\n')).not.toContain('unsupported-cell');
  await expect(page.locator('#notify-container .notify-text')).toContainText([
    'Imported 3 ImageJ ROIs onto the active microscopy series.',
    'Skipped 1 ImageJ ROI entry: unsupported-cell.roi (Unsupported ImageJ ROI type).',
  ]);

  const csvDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const csvDownload = await csvDownloadPromise;
  const csv = await readFile(await csvDownload.path(), 'utf8');
  const csvRows = parseCsvRows(csv);
  expect(csvRows.map(row => row.label).sort()).toEqual(['compressed-angle', 'compressed-cell', 'compressed-line']);
  expect(csv).not.toContain('roi-set/');
  expect(csv).not.toContain('roi-set\\');
  for (const row of csvRows) {
    expect(row.source_format).toBe('OME-TIFF');
    expect(row.source_files).toBe('compressed-roi-cells.ome.tiff');
    expect(row.xy_spacing_row_mm).toBe('0.00025');
    expect(row.xy_spacing_col_mm).toBe('0.0005');
    expect(row.calibration_unit).toBe('µm');
    expect(row.calibration_source).toBe('metadata');
  }
  const lineRow = csvRows.find(row => row.label === 'compressed-line');
  expect(lineRow).toMatchObject({ kind: 'line', value_source: 'linear_measurement' });
  expect(Number(lineRow.length_um)).toBeCloseTo(4, 3);
  const angleRow = csvRows.find(row => row.label === 'compressed-angle');
  expect(angleRow).toMatchObject({ kind: 'angle', value_source: 'angular_measurement' });
  expect(Number(angleRow.angle_deg)).toBeCloseTo(26.565, 3);

  await expect(page.locator('#roi-results-imagej-export')).toBeEnabled();
  const imagejDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-imagej-export').click();
  const imagejDownload = await imagejDownloadPromise;
  expect(imagejDownload.suggestedFilename()).toMatch(/^voxellab-imagej-rois-.*\.zip$/);
  const imagejZipPath = testInfo.outputPath('compressed-roundtrip-imagej-rois.zip');
  await imagejDownload.saveAs(imagejZipPath);
  const exportedRois = await parseImageJRoiZip(await readFile(imagejZipPath));
  expect(exportedRois).toHaveLength(3);
  const exportedNames = exportedRois.map(roi => roi.name).join('\n');
  expect(exportedNames).not.toContain('roi-set/');
  expect(exportedNames).not.toContain('roi-set\\');
  expect(exportedNames).not.toContain('unsupported-cell');
  const exportedByName = new Map(exportedRois.map(roi => [roi.name, roi]));
  expect(exportedByName.get('compressed-cell_z1_c1_t1')?.label).toBe('compressed-cell');
  expect(exportedByName.get('compressed-cell_z1_c1_t1')?.shape).toBe('ellipse');
  expect(exportedByName.get('compressed-cell_z1_c1_t1')?.points).toEqual([[4, 5], [13, 15]]);
  expect(exportedByName.get('compressed-line_z1_c1_t1')?.label).toBe('compressed-line');
  expect(exportedByName.get('compressed-line_z1_c1_t1')?.shape).toBe('line');
  expect(exportedByName.get('compressed-line_z1_c1_t1')?.points).toEqual([[2, 4], [10, 4]]);
  expect(exportedByName.get('compressed-angle_z1_c1_t1')?.label).toBe('compressed-angle');
  expect(exportedByName.get('compressed-angle_z1_c1_t1')?.shape).toBe('angle');
  expect(exportedByName.get('compressed-angle_z1_c1_t1')?.points).toEqual(anglePoints);

  const jsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-json-export').click();
  const jsonDownload = await jsonDownloadPromise;
  const jsonBundlePath = testInfo.outputPath('compressed-roi-results.json');
  await jsonDownload.saveAs(jsonBundlePath);
  const bundle = JSON.parse(await readFile(jsonBundlePath, 'utf8'));
  expect(bundle.source).toMatchObject({
    imageDomain: 'microscopy',
    format: 'OME-TIFF',
    sourceFiles: ['compressed-roi-cells.ome.tiff'],
  });
  expect(bundle.calibration).toMatchObject({ xyKnown: true, rowMm: 0.00025, colMm: 0.0005, displayUnit: 'µm' });
  expect(bundle.rows.map(row => [row.label, row.kind, row.valueSource || '']).sort()).toEqual([
    ['compressed-angle', 'angle', 'angular_measurement'],
    ['compressed-cell', 'ellipse', 'raw_16bit'],
    ['compressed-line', 'line', 'linear_measurement'],
  ]);
  expect(JSON.stringify(bundle)).not.toContain('roi-set/');
  expect(JSON.stringify(bundle)).not.toContain('roi-set\\');

  await page.evaluate(async () => {
    const { clearCurrentSliceDrawings } = await import('/js/clear-slice-drawings.js');
    clearCurrentSliceDrawings();
  });
  await page.locator('#clear-confirm').click();
  await expect(page.locator('#roi-results-count')).toHaveText('0');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(0);
  await page.locator('#roi-results-json-import-input').setInputFiles(jsonBundlePath);
  await expect(page.locator('#roi-results-status')).toHaveText('Imported 3 result rows');
  await expect(page.locator('#roi-results-count')).toHaveText('3');
  await expect(rows.filter({ hasText: 'compressed-cell' })).toContainText('ellipse');
  await expect(rows.filter({ hasText: 'compressed-line' })).toContainText('Calibrated length');
  await expect(rows.filter({ hasText: 'compressed-angle' })).toContainText('Calibrated angle');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);
});

test('co-dropped compressed ImageJ ROI Manager ZIP preserves C/T measurement provenance', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('compressed-positioned-roi-cells.ome.tiff');
  const pointPath = testInfo.outputPath('positioned-spots.roi');
  const linePath = testInfo.outputPath('positioned-line.roi');
  const anglePath = testInfo.outputPath('positioned-angle.roi');
  const outOfRangePath = testInfo.outputPath('positioned-missing-channel.roi');
  const outOfBoundsPath = testInfo.outputPath('positioned-clipped.roi');
  const zipPath = testInfo.outputPath('positioned-compressed-rois.zip');
  const position = { c: 2, z: 1, t: 2 };
  const pointPoints = [[4, 5], [10, 8]];
  const anglePoints = [[6, 4], [2, 4], [6, 8]];
  await writeCalibratedChannelTimeOmeTiff(omeTiffPath);
  await writeImageJPointRoi(pointPath, { points: pointPoints, position });
  await writeImageJLineRoi(linePath, { x1: 2, y1: 4, x2: 10, y2: 4, position });
  await writeImageJAngleRoi(anglePath, { points: anglePoints, position });
  await writeImageJPointRoi(outOfRangePath, { points: [[6, 6]], position: { c: 3, z: 1, t: 1 } });
  await writeImageJPointRoi(outOfBoundsPath, { points: [[4, 5], [99, 8]], position });
  await writeCompressedImageJRoiZip(zipPath, [
    { name: 'positioned-spots.roi', path: pointPath },
    { name: 'positioned-line.roi', path: linePath },
    { name: 'positioned-angle.roi', path: anglePath },
    { name: 'positioned-missing-channel.roi', path: outOfRangePath },
    { name: 'positioned-clipped.roi', path: outOfBoundsPath },
  ]);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [
    { path: omeTiffPath, mimeType: 'image/tiff' },
    { path: zipPath, mimeType: 'application/zip' },
  ]);

  await expect(page.locator('#series-name')).toHaveText('compressed-positioned-roi-cells');
  await waitForCanvasPaint(page, '#view');
  await ensurePanelOpen(page, '#roi-results-panel', '#roi-results-count');
  await expect(page.locator('#roi-results-count')).toHaveText('3');
  const rows = page.locator('[data-roi-result-row]');
  await expect(rows.filter({ hasText: 'positioned-spots' })).toContainText('C2 GFP');
  await expect(rows.filter({ hasText: 'positioned-spots' })).toContainText('T2');
  await expect(rows.filter({ hasText: 'positioned-line' })).toContainText('Calibrated length');
  await expect(rows.filter({ hasText: 'positioned-angle' })).toContainText('Calibrated angle');
  await expect.poll(async () => (await rows.allTextContents()).join('\n')).not.toContain('positioned-missing-channel');
  await expect.poll(async () => (await rows.allTextContents()).join('\n')).not.toContain('positioned-clipped');
  await expect(page.locator('#notify-container .notify-text')).toContainText([
    'Imported 3 ImageJ ROIs onto the active microscopy series.',
    'Skipped 2 ImageJ ROI entries: positioned-missing-channel (did not fit active series), positioned-clipped (did not fit active series).',
  ]);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(0);

  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await page.locator('#microscopy-channel-select').selectOption('1');
  await page.locator('#microscopy-time-select').selectOption('1');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .roi-point')).toHaveCount(2);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);

  const csvDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const csvDownload = await csvDownloadPromise;
  const csv = await readFile(await csvDownload.path(), 'utf8');
  const csvRows = parseCsvRows(csv);
  expect(csvRows.map(row => [row.label, row.kind, row.channel, row.channel_index0, row.time, row.time_index0]).sort()).toEqual([
    ['positioned-angle', 'angle', 'GFP', '1', '2', '1'],
    ['positioned-line', 'line', 'GFP', '1', '2', '1'],
    ['positioned-spots', 'point', 'GFP', '1', '2', '1'],
  ]);
  expect(csv).not.toContain('positioned-missing-channel');
  expect(csv).not.toContain('positioned-clipped');

  const imagejDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-imagej-export').click();
  const imagejDownload = await imagejDownloadPromise;
  const imagejZipPath = testInfo.outputPath('positioned-roundtrip-imagej-rois.zip');
  await imagejDownload.saveAs(imagejZipPath);
  const exportedRois = await parseImageJRoiZip(await readFile(imagejZipPath));
  expect(exportedRois).toHaveLength(3);
  expect(exportedRois.map(roi => roi.name).join('\n')).not.toContain('positioned-missing-channel');
  expect(exportedRois.map(roi => roi.name).join('\n')).not.toContain('positioned-clipped');
  for (const roi of exportedRois) {
    expect(roi.zPosition).toBe(1);
    expect(roi.channelPosition).toBe(2);
    expect(roi.timePosition).toBe(2);
  }
  const exportedByName = new Map(exportedRois.map(roi => [roi.name, roi]));
  expect(exportedByName.get('positioned-spots_z1_c2_t2')?.label).toBe('positioned-spots');
  expect(exportedByName.get('positioned-spots_z1_c2_t2')?.points).toEqual(pointPoints);
  expect(exportedByName.get('positioned-line_z1_c2_t2')?.label).toBe('positioned-line');
  expect(exportedByName.get('positioned-line_z1_c2_t2')?.points).toEqual([[2, 4], [10, 4]]);
  expect(exportedByName.get('positioned-angle_z1_c2_t2')?.label).toBe('positioned-angle');
  expect(exportedByName.get('positioned-angle_z1_c2_t2')?.points).toEqual(anglePoints);

  const jsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-json-export').click();
  const jsonDownload = await jsonDownloadPromise;
  const jsonBundlePath = testInfo.outputPath('positioned-roi-results.json');
  await jsonDownload.saveAs(jsonBundlePath);
  const bundle = JSON.parse(await readFile(jsonBundlePath, 'utf8'));
  expect(bundle).toMatchObject({
    schema: 'voxellab.roiResults.v1',
    series: { name: 'compressed-positioned-roi-cells', width: 16, height: 16, slices: 1 },
    source: {
      imageDomain: 'microscopy',
      format: 'OME-TIFF',
      sourceFiles: ['compressed-positioned-roi-cells.ome.tiff'],
    },
    calibration: { xyKnown: true, rowMm: 0.00025, colMm: 0.0005, zKnown: true, zMm: 0.0015, displayUnit: 'µm' },
  });
  expect(bundle.source.dataset.axes.map(axis => [axis.name, axis.type, axis.size, axis.unit, axis.scale, axis.known])).toEqual([
    ['x', 'space', 16, 'µm', 0.5, true],
    ['y', 'space', 16, 'µm', 0.25, true],
    ['z', 'space', 1, 'µm', 1.5, true],
    ['c', 'channel', 2, '', 0, false],
    ['t', 'time', 2, 'index', 1, false],
  ]);
  expect(bundle.rows.map(row => [row.label, row.kind, row.channel, row.channelIndex, row.time, row.timeIndex, row.valueSource || '']).sort()).toEqual([
    ['positioned-angle', 'angle', 'GFP', 1, 2, 1, 'angular_measurement'],
    ['positioned-line', 'line', 'GFP', 1, 2, 1, 'linear_measurement'],
    ['positioned-spots', 'point', 'GFP', 1, 2, 1, 'raw_16bit'],
  ]);
  expect(JSON.stringify(bundle)).not.toContain('positioned-missing-channel');
  expect(JSON.stringify(bundle)).not.toContain('positioned-clipped');
  expect(bundle.rows.find(row => row.label === 'positioned-spots')).toMatchObject({
    slice: 1,
    sliceIndex: 0,
    count: 2,
    points: pointPoints,
  });
  expect(Number(bundle.rows.find(row => row.label === 'positioned-line')?.lengthMm)).toBeGreaterThan(0);
  expect(Number(bundle.rows.find(row => row.label === 'positioned-angle')?.angleDeg)).toBeCloseTo(26.565, 3);

  await page.evaluate(async () => {
    const { clearCurrentSliceDrawings } = await import('/js/clear-slice-drawings.js');
    clearCurrentSliceDrawings();
  });
  await page.locator('#clear-confirm').click();
  await expect(page.locator('#roi-results-count')).toHaveText('0');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(0);
  await page.locator('#roi-results-json-import-input').setInputFiles(jsonBundlePath);
  await expect(page.locator('#roi-results-status')).toHaveText('Imported 3 result rows');
  await expect(page.locator('#roi-results-count')).toHaveText('3');
  await expect(rows.filter({ hasText: 'positioned-spots' })).toContainText('C2 GFP');
  await expect(rows.filter({ hasText: 'positioned-line' })).toContainText('Calibrated length');
  await expect(rows.filter({ hasText: 'positioned-angle' })).toContainText('Calibrated angle');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .roi-point')).toHaveCount(2);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);
  await page.locator('#microscopy-channel-select').selectOption('0');
  await page.locator('#microscopy-time-select').selectOption('0');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(0);
  await rows.filter({ hasText: 'positioned-line' }).click();
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('#microscopy-time-select')).toHaveValue('1');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);

  const recipeDownloadPromise = page.waitForEvent('download');
  await page.locator('#microscopy-recipe-export').click();
  const recipeDownload = await recipeDownloadPromise;
  const recipePath = testInfo.outputPath('positioned-workflow-recipe.json');
  await recipeDownload.saveAs(recipePath);
  const recipe = JSON.parse(await readFile(recipePath, 'utf8'));
  expect(recipe).toMatchObject({
    schema: 'voxellab.microscopyWorkflowRecipe.v1',
    target: {
      imageDomain: 'microscopy',
      sourceFormat: 'OME-TIFF',
      geometry: { width: 16, height: 16, slices: 1, sizeZ: 1, sizeC: 2, sizeT: 2 },
    },
    requirements: { measurementPrerequisite: 'results-present' },
    stack: { channelIndex: 1, timeIndex: 1 },
    exportPreferences: { embeddedRoiResults: true },
  });
  expect(recipe.roiResults.rows.map(row => [row.label, row.kind, row.channel, row.channelIndex, row.time, row.timeIndex, row.valueSource || '']).sort()).toEqual([
    ['positioned-line', 'line', 'GFP', 1, 2, 1, 'linear_measurement'],
    ['positioned-spots', 'point', 'GFP', 1, 2, 1, 'display_8bit'],
  ]);
  expect(recipe.angleMeasurements.rows.map(row => [row.label, row.channelName, row.channelIndex, row.timeIndex, Number(row.angleDeg.toFixed(3))])).toEqual([
    ['positioned-angle', 'GFP', 1, 1, 26.565],
  ]);
  expect(JSON.stringify(recipe)).not.toContain('positioned-missing-channel');
  expect(JSON.stringify(recipe)).not.toContain('positioned-clipped');

  const mismatchedRecipeOmeTiffPath = testInfo.outputPath('recipe-mismatch/positioned-recipe-mismatch-cells.ome.tiff');
  await writeCalibratedChannelTimeOmeTiff(mismatchedRecipeOmeTiffPath);
  const countBeforeMismatchedRecipeDrop = await page.locator('#series-list li').count();
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await dropFiles(page, '#upload-zone', [
    { path: mismatchedRecipeOmeTiffPath, mimeType: 'image/tiff' },
    { path: recipePath, mimeType: 'application/json' },
  ]);
  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-list li')).toHaveCount(countBeforeMismatchedRecipeDrop + 1);
  await expect(page.locator('#series-name')).toHaveText('positioned-recipe-mismatch-cells');
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('0');
  await expect(page.locator('#microscopy-time-select')).toHaveValue('0');
  await expect(page.locator('#roi-results-count')).toHaveText('0');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(0);
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Skipped 1 microscopy workflow recipe' }))
    .toContainText('positioned-workflow-recipe.json (Recipe ROI results do not match the active microscopy series)');

  const recipeReplayOmeTiffPath = testInfo.outputPath('recipe-replay/compressed-positioned-roi-cells.ome.tiff');
  await writeCalibratedChannelTimeOmeTiff(recipeReplayOmeTiffPath);
  const countBeforeRecipeDrop = await page.locator('#series-list li').count();
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await dropFiles(page, '#upload-zone', [
    { path: recipeReplayOmeTiffPath, mimeType: 'image/tiff' },
    { path: recipePath, mimeType: 'application/json' },
  ]);
  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-list li')).toHaveCount(countBeforeRecipeDrop + 1);
  await expect(page.locator('#series-name')).toHaveText('compressed-positioned-roi-cells');
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('#microscopy-time-select')).toHaveValue('1');
  await expect(page.locator('#roi-results-count')).toHaveText('3');
  await expect(rows.filter({ hasText: 'positioned-spots' })).toContainText('C2 GFP');
  await expect(rows.filter({ hasText: 'positioned-line' })).toContainText('Calibrated length');
  await expect(rows.filter({ hasText: 'positioned-angle' })).toContainText('Calibrated angle');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .roi-point')).toHaveCount(2);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);
  await page.locator('#microscopy-channel-select').selectOption('0');
  await page.locator('#microscopy-time-select').selectOption('0');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(0);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(0);
  await rows.filter({ hasText: 'positioned-angle' }).click();
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('#microscopy-time-select')).toHaveValue('1');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);

  const pngDownloadPromise = page.waitForEvent('download');
  await page.locator('#btn-shot').click();
  const pngDownload = await pngDownloadPromise;
  expect(pngDownload.suggestedFilename()).toMatch(/_z1_c2_t2\.png$/);
  const pngMetrics = await renderedPngMetrics(page, await pngDownload.path());
  expect(pngMetrics).toMatchObject({
    width: CALIBRATED_OME_TIFF.width,
    height: CALIBRATED_OME_TIFF.height,
  });
  expect(pngMetrics.roiBluePixels, JSON.stringify(pngMetrics)).toBeGreaterThan(8);
  expect(pngMetrics.angleWhitePixels, JSON.stringify(pngMetrics)).toBeGreaterThan(6);
  expect(pngMetrics.scaleBarBrightPixels, JSON.stringify(pngMetrics)).toBeGreaterThan(10);
  const tiffDownloadPromise = page.waitForEvent('download');
  await page.locator('#btn-cmdk-open').click();
  await page.locator('#cmdk-input').fill('tiff snapshot');
  await page.getByRole('button', { name: /Rendered TIFF snapshot/ }).click();
  const tiffDownload = await tiffDownloadPromise;
  expect(tiffDownload.suggestedFilename()).toMatch(/_z1_c2_t2\.tif$/);
  const tiffMetrics = await renderedTiffMetrics(await tiffDownload.path());
  expect(tiffMetrics).toMatchObject({
    magic: [0x49, 0x49, 42],
    width: CALIBRATED_OME_TIFF.width,
    height: CALIBRATED_OME_TIFF.height,
    compression: 1,
    photometric: 2,
    samplesPerPixel: 3,
    pixelByteCount: CALIBRATED_OME_TIFF.width * CALIBRATED_OME_TIFF.height * 3,
  });
  expect(tiffMetrics.description).toContain('ImageJ=1.54');
  expect(tiffMetrics.description).toContain('pixel_width=0.5');
  expect(tiffMetrics.description).toContain('pixel_height=0.25');
  expect(tiffMetrics.description).toContain('spacing=1.5');
  expect(tiffMetrics.description).toContain('label=Z 1 · C2 GFP · T2');
  expect(tiffMetrics.roiBluePixels, JSON.stringify(tiffMetrics)).toBeGreaterThan(8);
  expect(tiffMetrics.scaleBarBrightPixels, JSON.stringify(tiffMetrics)).toBeGreaterThan(10);
});

test('co-dropped ImageJ straight-line ROI sidecar imports as calibrated measurement row', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('line-roi-cells.ome.tiff');
  const linePath = testInfo.outputPath('axon-length.roi');
  await writeCalibratedOmeTiff(omeTiffPath);
  await writeImageJLineRoi(linePath, { x1: 2, y1: 4, x2: 10, y2: 4 });

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [
    { path: omeTiffPath, mimeType: 'image/tiff' },
    { path: linePath, mimeType: 'application/octet-stream' },
  ]);

  await expect(page.locator('#series-name')).toHaveText('line-roi-cells');
  await waitForCanvasPaint(page, '#view');
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(1);
  if (await page.locator('#roi-results-panel').evaluate(panel => panel.classList.contains('collapsed'))) {
    await page.locator('#roi-results-panel .sec-title').click();
  }
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  const row = page.locator('[data-roi-result-row]');
  await expect(row).toContainText('line');
  await expect(row).toContainText('axon-length');
  await expect(row).toContainText('4.00 µm');

  const imagejDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-imagej-export').click();
  const imagejDownload = await imagejDownloadPromise;
  const imagejZipPath = testInfo.outputPath('exported-line-imagej-rois.zip');
  await imagejDownload.saveAs(imagejZipPath);
  const exportedRois = await parseImageJRoiZip(await readFile(imagejZipPath));
  expect(exportedRois).toHaveLength(1);
  expect(exportedRois[0].shape).toBe('line');
  expect(exportedRois[0].label).toBe('axon-length');
  expect(exportedRois[0].points).toEqual([[2, 4], [10, 4]]);
});

test('co-dropped ImageJ angle ROI sidecar imports as calibrated angle measurement overlay', async ({ page }, testInfo) => {
  const omeTiffPath = testInfo.outputPath('angle-roi-cells.ome.tiff');
  const anglePath = testInfo.outputPath('branch-angle.roi');
  const points = [[6, 4], [2, 4], [6, 8]];
  await writeCalibratedChannelTimeOmeTiff(omeTiffPath);
  await writeImageJAngleRoi(anglePath, { points, position: { c: 2, z: 1, t: 2 } });

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [
    { path: omeTiffPath, mimeType: 'image/tiff' },
    { path: anglePath, mimeType: 'application/octet-stream' },
  ]);

  await expect(page.locator('#series-name')).toHaveText('angle-roi-cells');
  await waitForCanvasPaint(page, '#view');
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(0);
  await page.locator('#microscopy-channel-select').selectOption('1');
  await page.locator('#microscopy-time-select').selectOption('1');
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group .m-label')).toHaveText('26.6°');
  await expect(page.locator('#notify-container .notify-text')).toContainText('Imported 1 ImageJ ROI onto the active microscopy series.');

  const snapshot = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const { collectMeasurements } = await import('/js/dicom/dicom-sr-collect.js');
    const { angleEntriesForSlice } = await import('/js/overlay/annotation-graph.js');
    const series = state.manifest.series[state.seriesIdx];
    const angles = angleEntriesForSlice(state, series, state.sliceIdx);
    return {
      angleCount: angles.length,
      stored: angles.map(angle => ({
        label: angle.label,
        deg: Number(angle.deg.toFixed(3)),
        microscopy: angle.microscopy,
        handles: [angle.p1, angle.vertex, angle.p3],
      })),
      collected: collectMeasurements(state).measurements.filter(item => item.kind === 'angle'),
    };
  });
  expect(snapshot.angleCount).toBe(1);
  expect(snapshot.stored[0]).toMatchObject({
    label: 'branch-angle',
    deg: 26.565,
    microscopy: { channelIndex: 1, channelName: 'GFP', timeIndex: 1 },
    handles: [{ x: 6, y: 4 }, { x: 2, y: 4 }, { x: 6, y: 8 }],
  });
  expect(snapshot.collected).toEqual([{
    kind: 'angle',
    slice: 0,
    angle_deg: expect.closeTo(26.565, 0.001),
    handles: [[6, 4], [2, 4], [6, 8]],
  }]);

  const recipeDownloadPromise = page.waitForEvent('download');
  await page.locator('#microscopy-recipe-export').click();
  const recipeDownload = await recipeDownloadPromise;
  const recipePath = testInfo.outputPath('angle-workflow-recipe.json');
  await recipeDownload.saveAs(recipePath);
  const recipe = JSON.parse(await readFile(recipePath, 'utf8'));
  expect(recipe.angleMeasurements.rows).toHaveLength(1);
  expect(recipe.angleMeasurements.rows[0]).toMatchObject({
    label: 'branch-angle',
    sliceIndex: 0,
    angleDeg: expect.closeTo(26.565, 0.001),
    channelIndex: 1,
    channelName: 'GFP',
    timeIndex: 1,
    points: {
      p1: { x: 6, y: 4 },
      vertex: { x: 2, y: 4 },
      p3: { x: 6, y: 8 },
    },
  });

  await page.evaluate(async () => {
    const { clearCurrentSliceDrawings } = await import('/js/clear-slice-drawings.js');
    clearCurrentSliceDrawings();
  });
  await page.locator('#clear-confirm').click();
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(0);
  await page.locator('#microscopy-recipe-import-input').setInputFiles(recipePath);
  await expect(page.locator('#microscopy-recipe-status')).toHaveText('Workflow recipe replayed');
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group .m-label')).toHaveText('26.6°');

  await ensurePanelOpen(page, '#roi-results-panel', '#roi-results-imagej-export');
  await expect(page.locator('#roi-results-imagej-export')).toBeEnabled();
  const imagejDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-imagej-export').click();
  const imagejDownload = await imagejDownloadPromise;
  const imagejZipPath = testInfo.outputPath('exported-angle-imagej-rois.zip');
  await imagejDownload.saveAs(imagejZipPath);
  const exportedRois = await parseImageJRoiZip(await readFile(imagejZipPath));
  expect(exportedRois).toHaveLength(1);
  expect(exportedRois[0].shape).toBe('angle');
  expect(exportedRois[0].name).toBe('branch-angle_z1_c2_t2');
  expect(exportedRois[0].label).toBe('branch-angle');
  expect(exportedRois[0].channelPosition).toBe(2);
  expect(exportedRois[0].timePosition).toBe(2);
  expect(exportedRois[0].points).toEqual(points);

  const zipReplayOmeTiffPath = testInfo.outputPath('angle-zip-replay-cells.ome.tiff');
  await writeCalibratedChannelTimeOmeTiff(zipReplayOmeTiffPath);
  const countBeforeZipDrop = await page.locator('#series-list li').count();
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await dropFiles(page, '#upload-zone', [
    { path: zipReplayOmeTiffPath, mimeType: 'image/tiff' },
    { path: imagejZipPath, mimeType: 'application/zip' },
  ]);
  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-list li')).toHaveCount(countBeforeZipDrop + 1);
  await expect(page.locator('#series-name')).toHaveText('angle-zip-replay-cells');
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(0);
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  await page.locator('#microscopy-channel-select').selectOption('1');
  await page.locator('#microscopy-time-select').selectOption('1');
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group .m-label')).toHaveText('26.6°');
  await expect(page.locator('[data-roi-result-row]').filter({ hasText: 'branch-angle' }))
    .toContainText('Calibrated angle');
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Imported 1 ImageJ ROI' }))
    .toContainText('Imported 1 ImageJ ROI onto the active microscopy series.');
  const zipReplayCsvDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const zipReplayCsvDownload = await zipReplayCsvDownloadPromise;
  const zipReplayCsv = await readFile(await zipReplayCsvDownload.path(), 'utf8');
  const [zipReplayRow] = parseCsvRows(zipReplayCsv);
  expect(zipReplayRow).toMatchObject({
    kind: 'angle',
    label: 'branch-angle',
    slice: '1',
    z_index0: '0',
    channel: 'GFP',
    channel_index0: '1',
    time: '2',
    time_index0: '1',
    value_source: 'angular_measurement',
    source_format: 'OME-TIFF',
    source_files: 'angle-zip-replay-cells.ome.tiff',
    xy_spacing_row_mm: '0.00025',
    xy_spacing_col_mm: '0.0005',
    z_spacing_mm: '0.0015',
    calibration_unit: 'µm',
  });
  expect(Number(zipReplayRow.angle_deg)).toBeCloseTo(26.565, 3);
  const zipReplayJsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-json-export').click();
  const zipReplayJsonDownload = await zipReplayJsonDownloadPromise;
  const zipReplayBundle = JSON.parse(await readFile(await zipReplayJsonDownload.path(), 'utf8'));
  expect(zipReplayBundle).toMatchObject({
    schema: 'voxellab.roiResults.v1',
    source: {
      imageDomain: 'microscopy',
      format: 'OME-TIFF',
      sourceFiles: ['angle-zip-replay-cells.ome.tiff'],
      warnings: [],
    },
    calibration: {
      xyKnown: true,
      rowMm: 0.00025,
      colMm: 0.0005,
      zKnown: true,
      zMm: 0.0015,
      displayUnit: 'µm',
    },
    rows: [{
      kind: 'angle',
      label: 'branch-angle',
      slice: 1,
      sliceIndex: 0,
      angleDeg: expect.closeTo(26.565, 0.001),
      channel: 'GFP',
      channelIndex: 1,
      time: 2,
      timeIndex: 1,
      valueSource: 'angular_measurement',
      points,
    }],
  });
  const zipReplayPngDownloadPromise = page.waitForEvent('download');
  await page.locator('#btn-shot').click();
  const zipReplayPngDownload = await zipReplayPngDownloadPromise;
  expect(zipReplayPngDownload.suggestedFilename()).toMatch(/_z1_c2_t2\.png$/);
  const zipReplayPngMetrics = await renderedPngMetrics(page, await zipReplayPngDownload.path());
  expect(zipReplayPngMetrics).toMatchObject({
    width: CALIBRATED_OME_TIFF.width,
    height: CALIBRATED_OME_TIFF.height,
  });
  expect(zipReplayPngMetrics.roiBluePixels, JSON.stringify(zipReplayPngMetrics)).toBe(0);
  expect(zipReplayPngMetrics.angleWhitePixels, JSON.stringify(zipReplayPngMetrics)).toBeGreaterThan(6);
  expect(zipReplayPngMetrics.scaleBarBrightPixels, JSON.stringify(zipReplayPngMetrics)).toBeGreaterThan(10);
  const zipReplayTiffDownloadPromise = page.waitForEvent('download');
  await page.locator('#btn-cmdk-open').click();
  await page.locator('#cmdk-input').fill('tiff snapshot');
  await page.getByRole('button', { name: /Rendered TIFF snapshot/ }).click();
  const zipReplayTiffDownload = await zipReplayTiffDownloadPromise;
  expect(zipReplayTiffDownload.suggestedFilename()).toMatch(/_z1_c2_t2\.tif$/);
  const zipReplayTiffMetrics = await renderedTiffMetrics(await zipReplayTiffDownload.path());
  expect(zipReplayTiffMetrics).toMatchObject({
    magic: [0x49, 0x49, 42],
    width: CALIBRATED_OME_TIFF.width,
    height: CALIBRATED_OME_TIFF.height,
    compression: 1,
    photometric: 2,
    samplesPerPixel: 3,
    pixelByteCount: CALIBRATED_OME_TIFF.width * CALIBRATED_OME_TIFF.height * 3,
  });
  expect(zipReplayTiffMetrics.description).toContain('ImageJ=1.54');
  expect(zipReplayTiffMetrics.description).toContain('pixel_width=0.5');
  expect(zipReplayTiffMetrics.description).toContain('pixel_height=0.25');
  expect(zipReplayTiffMetrics.description).toContain('spacing=1.5');
  expect(zipReplayTiffMetrics.description).toContain('label=Z 1 · C2 GFP · T2');

  const recipeReplayOmeTiffPath = testInfo.outputPath('angle-recipe-replay-cells.ome.tiff');
  await writeCalibratedChannelTimeOmeTiff(recipeReplayOmeTiffPath);
  const countBeforeRecipeDrop = await page.locator('#series-list li').count();
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await dropFiles(page, '#upload-zone', [
    { path: recipeReplayOmeTiffPath, mimeType: 'image/tiff' },
    { path: recipePath, mimeType: 'application/json' },
  ]);
  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-list li')).toHaveCount(countBeforeRecipeDrop + 1);
  await expect(page.locator('#series-name')).toHaveText('angle-recipe-replay-cells');
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-channel-select');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('#microscopy-time-select')).toHaveValue('1');
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .angle-group .m-label')).toHaveText('26.6°');
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Replayed 1 microscopy workflow recipe' }))
    .toContainText('Replayed 1 microscopy workflow recipe from VoxelLab sidecar.');
});

test('upload modal groups a local TIFF image sequence into one microscopy Z stack', async ({ page }, testInfo) => {
  const sequencePaths = [
    testInfo.outputPath('seq_z003.tif'),
    testInfo.outputPath('seq_z001.tif'),
    testInfo.outputPath('seq_z002.tif'),
  ];
  await writeTinySequenceTiff(sequencePaths[0], [240, 250, 255]);
  await writeTinySequenceTiff(sequencePaths[1], [20, 30, 40]);
  await writeTinySequenceTiff(sequencePaths[2], [120, 130, 140]);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropFiles(page, '#upload-zone', sequencePaths.map(path => ({ path, mimeType: 'image/tiff' })));
  await expect(page.locator('#series-name')).toHaveText('seq_z');
  await expect(page.locator('#series-desc')).toContainText('TIFF sequence');
  await expect(page.locator('#slice-tot')).toHaveText('3');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#btn-mpr')).toBeHidden();
  await expect(page.locator('#btn-3d')).toBeHidden();
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Calibration' })).toContainText('Uncalibrated');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Spacing trust' })).toContainText('Unknown · XY spacing missing');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source files' })).toContainText('3 files');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source files' })).toContainText('seq_z001.tif, seq_z002.tif, plus 1 more');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Sequence order' })).toContainText('Numeric filename suffix');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source warnings' })).toContainText('XY spacing missing');
  await waitForCanvasPaint(page, '#view');
  await expect(page.locator('#scale-bar')).toBeHidden();
  await expect(page.locator('#microscopy-stack-panel')).toBeVisible();
  if (await page.locator('#microscopy-stack-panel').evaluate(panel => panel.classList.contains('collapsed'))) {
    await page.locator('#microscopy-stack-panel .sec-title').click();
  }
  await expect(page.locator('#microscopy-calibration')).toHaveText('XY uncalibrated · 2 warnings');
  await page.locator('#microscopy-calibration-x').fill('0.5');
  await page.locator('#microscopy-calibration-y').fill('0.25');
  await page.locator('#microscopy-calibration-z').fill('1.5');
  await page.locator('#microscopy-calibration-apply').click();
  await expect(page.locator('#microscopy-calibration')).toHaveText('X 0.500 µm/px · Y 0.250 µm/px · Z 1.50 µm');
  await expect(page.locator('#meta .meta-row').filter({ has: page.locator('.mk', { hasText: 'Calibration' }) })).toContainText('Manual calibration');
  await expect(page.locator('#meta .meta-row').filter({ has: page.locator('.mk', { hasText: 'Spacing trust' }) })).toContainText('Manual calibration');
  await expect(page.locator('#meta .meta-row').filter({ has: page.locator('.mk', { hasText: 'Pixel spacing' }) })).toContainText('0.250 µm × 0.500 µm');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Sequence order' })).toContainText('Numeric filename suffix');
  await expect(page.locator('#meta .meta-row').filter({ hasText: 'Source warnings' })).toContainText('None');
  await expect(page.locator('#microscopy-recipe-export')).toBeVisible();
  await expect(page.locator('#microscopy-recipe-import')).toBeVisible();

  await page.locator('#scrub').evaluate((input) => {
    input.value = '2';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#slice-cur')).toHaveText('3');
  await waitForCanvasPaint(page, '#view');

  const snapshot = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const series = state.manifest.series[state.seriesIdx];
    return {
      imageDomain: series.imageDomain,
      sourceFiles: series.microscopy?.sourceFiles,
      axes: series.microscopyDataset?.axes.map(axis => [axis.name, axis.size]),
      sourceFormat: series.microscopyDataset?.source.originalFormat,
      orderStrategy: series.microscopy?.sequenceProvenance?.orderStrategy,
      provenanceNames: series.microscopyDataset?.source.provenance?.planes.map(plane => plane.name),
      sourceWarnings: series.microscopyDataset?.source.warnings,
      pixelSpacing: series.pixelSpacing,
      sliceSpacing: series.sliceSpacing,
      axesCalibration: series.microscopyDataset?.axes
        .filter(axis => ['x', 'y', 'z'].includes(axis.name))
        .map(axis => [axis.name, axis.scale, axis.unit, axis.known]),
      localStackCount: Object.keys(state._localMicroscopyStacks[series.slug]).length,
      rootScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(snapshot).toEqual({
    imageDomain: 'microscopy',
    sourceFiles: ['seq_z001.tif', 'seq_z002.tif', 'seq_z003.tif'],
    axes: [['x', 3], ['y', 1], ['z', 3], ['c', 1], ['t', 1]],
    sourceFormat: 'TIFF sequence',
    orderStrategy: 'numeric-suffix',
    provenanceNames: ['seq_z001.tif', 'seq_z002.tif', 'seq_z003.tif'],
    sourceWarnings: [],
    pixelSpacing: [0.00025, 0.0005],
    sliceSpacing: 0.0015,
    axesCalibration: [['x', 0.5, 'µm', true], ['y', 0.25, 'µm', true], ['z', 1.5, 'µm', true]],
    localStackCount: 1,
    rootScrollWidth: expect.any(Number),
    viewportWidth: expect.any(Number),
  });
  expect(snapshot.rootScrollWidth).toBeLessThanOrEqual(snapshot.viewportWidth + 1);
});

test('uncalibrated microscopy ROI sidecar imports geometry without trusting physical metrics', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  const width = 32;
  const height = 24;
  const sequencePaths = [
    testInfo.outputPath('untrusted_roi_z001.tif'),
    testInfo.outputPath('untrusted_roi_z002.tif'),
  ];
  await writeTinySequenceTiff(sequencePaths[0], sequencePlane(width, height, 20), { width, height });
  await writeTinySequenceTiff(sequencePaths[1], sequencePlane(width, height, 80), { width, height });

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', sequencePaths.map(path => ({ path, mimeType: 'image/tiff' })));
  await expect(page.locator('#series-name')).toHaveText('untrusted_roi_z');
  await waitForCanvasPaint(page, '#view');
  await ensurePanelOpen(page, '#microscopy-stack-panel', '#microscopy-calibration');
  await expect(page.locator('#microscopy-calibration')).toHaveText('XY uncalibrated · 2 warnings');
  await ensurePanelOpen(page, '#roi-results-panel', '#roi-results-json-import');

  const target = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const { seriesPersistenceKey } = await import('/js/series/series-identity.js');
    const series = state.manifest.series[state.seriesIdx];
    return {
      slug: series.slug,
      name: series.name,
      width: series.width,
      height: series.height,
      slices: series.slices,
      persistenceKey: seriesPersistenceKey(series, state.manifest),
    };
  });
  const bundlePath = testInfo.outputPath('untrusted-roi-results.json');
  await writeFile(bundlePath, `${JSON.stringify({
    schema: 'voxellab.roiResults.v1',
    series: target,
    calibration: { xyKnown: false, displayUnit: 'µm' },
    rows: [{
      roiObjectId: `roi:${target.slug}|0:5`,
      sliceIndex: 0,
      kind: 'polygon',
      label: 'Imported geometry only',
      points: [[2, 2], [14, 2], [14, 10], [2, 10]],
      pixels: 96,
      mean: 34.5,
      rawIntDen: 3312,
      intDen: 888,
      intDenMm2: 0.000888,
      areaMm2: 0.000024,
      perimeterMm: 0.024,
    }, {
      roiObjectId: `measure:${target.slug}|0:6`,
      sliceIndex: 0,
      kind: 'line',
      label: 'Untrusted calibrated length',
      points: [[2, 12], [18, 12]],
      lengthMm: 0.008,
    }],
  }, null, 2)}\n`);

  await page.locator('#roi-results-json-import-input').setInputFiles(bundlePath);
  await expect(page.locator('#roi-results-status')).toHaveText('Imported 1 result row; skipped incompatible rows');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#overlay-svg .m-group')).toHaveCount(0);
  const rowSnapshot = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const { roiResultRows } = await import('/js/roi/roi-results.js');
    const row = roiResultRows(state)[0];
    return {
      label: row.label,
      areaMm2: row.areaMm2,
      perimeterMm: row.perimeterMm,
      intDen: row.intDen,
      intDenMm2: row.intDenMm2,
      rawIntDen: row.rawIntDen,
      lengthMm: row.lengthMm,
    };
  });
  expect(rowSnapshot).toEqual({
    label: 'Imported geometry only',
    areaMm2: null,
    perimeterMm: null,
    intDen: null,
    intDenMm2: null,
    rawIntDen: 3312,
    lengthMm: null,
  });
  await expect(page.locator('[data-roi-result-row]')).toContainText('Imported geometry only');
  await expect(page.locator('[data-roi-result-row]')).not.toContainText('Untrusted calibrated length');
  const csvDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const csvDownload = await csvDownloadPromise;
  const csvRows = parseCsvRows(await readFile(await csvDownload.path(), 'utf8'));
  expect(csvRows).toHaveLength(1);
  expect(csvRows[0]).toMatchObject({
    label: 'Imported geometry only',
    pixels: '96',
    raw_int_den: '3312',
    area_mm2: '',
    perimeter_mm: '',
    int_den: '',
    int_den_mm2: '',
  });
  const jsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-json-export').click();
  const jsonDownload = await jsonDownloadPromise;
  const bundle = JSON.parse(await readFile(await jsonDownload.path(), 'utf8'));
  expect(bundle.calibration.xyKnown).toBe(false);
  expect(bundle.rows[0]).toMatchObject({
    label: 'Imported geometry only',
    pixels: 96,
    rawIntDen: 3312,
    areaMm2: null,
    perimeterMm: null,
    intDen: null,
    intDenMm2: null,
  });
});

test('manual calibrated TIFF sequence supports trusted ROI export, rendered TIFF, recipe replay, and re-import', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  const width = 96;
  const height = 64;
  const sequencePaths = [
    testInfo.outputPath('seq_workflow_z003.tif'),
    testInfo.outputPath('seq_workflow_z001.tif'),
    testInfo.outputPath('seq_workflow_z002.tif'),
  ];
  await writeTinySequenceTiff(sequencePaths[0], sequencePlane(width, height, 180), { width, height });
  await writeTinySequenceTiff(sequencePaths[1], sequencePlane(width, height, 20), { width, height });
  await writeTinySequenceTiff(sequencePaths[2], sequencePlane(width, height, 90), { width, height });

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', sequencePaths.map(path => ({ path, mimeType: 'image/tiff' })));
  await expect(page.locator('#series-desc')).toContainText('TIFF sequence');
  await waitForCanvasPaint(page, '#view');
  await expect(page.locator('#scale-bar')).toBeHidden();

  if (await page.locator('#microscopy-stack-panel').evaluate(panel => panel.classList.contains('collapsed'))) {
    await page.locator('#microscopy-stack-panel .sec-title').click();
  }
  await page.locator('#microscopy-calibration-x').fill('0.5');
  await page.locator('#microscopy-calibration-y').fill('0.25');
  await page.locator('#microscopy-calibration-z').fill('2');
  await page.locator('#microscopy-calibration-apply').click();
  await expect(page.locator('#microscopy-calibration')).toHaveText('X 0.500 µm/px · Y 0.250 µm/px · Z 2.00 µm');
  await expectScaleBarFits(page);

  await page.locator('#scrub').evaluate((input) => {
    input.value = '1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await waitForCanvasPaint(page, '#view');

  const recipeDownloadPromise = page.waitForEvent('download');
  await page.locator('#microscopy-recipe-export').click();
  const recipeDownload = await recipeDownloadPromise;
  const recipePath = await recipeDownload.path();
  const recipe = JSON.parse(await readFile(recipePath, 'utf8'));
  const calibrationRecipePath = testInfo.outputPath('calibration-recipe.json');
  await writeFile(calibrationRecipePath, `${JSON.stringify(recipe, null, 2)}\n`);
  expect(recipe.target.sourceFormat).toBe('TIFF sequence');
  expect(recipe.requirements).toMatchObject({ calibrationRequired: true, measurementPrerequisite: 'none' });
  expect(recipe.calibration).toMatchObject({
    xyKnown: true,
    rowMm: 0.00025,
    colMm: 0.0005,
    zKnown: true,
    zMm: 0.002,
    displayUnit: 'µm',
    trust: 'Manual calibration',
  });
  expect(recipe.view.sliceIndex).toBe(1);

  const replaySequencePaths = [
    testInfo.outputPath('seq_replay_z003.tif'),
    testInfo.outputPath('seq_replay_z001.tif'),
    testInfo.outputPath('seq_replay_z002.tif'),
  ];
  await writeTinySequenceTiff(replaySequencePaths[0], sequencePlane(width, height, 210), { width, height });
  await writeTinySequenceTiff(replaySequencePaths[1], sequencePlane(width, height, 40), { width, height });
  await writeTinySequenceTiff(replaySequencePaths[2], sequencePlane(width, height, 120), { width, height });
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await dropFiles(page, '#upload-zone', replaySequencePaths.map(path => ({ path, mimeType: 'image/tiff' })));
  await expect(page.locator('#series-name')).toHaveText('seq_replay_z');
  await expect(page.locator('#scale-bar')).toBeHidden();
  if (await page.locator('#microscopy-stack-panel').evaluate(panel => panel.classList.contains('collapsed'))) {
    await page.locator('#microscopy-stack-panel .sec-title').click();
  }
  await page.locator('#microscopy-recipe-import-input').setInputFiles(recipePath);
  await expect(page.locator('#microscopy-recipe-status')).toHaveText('Workflow recipe replayed');
  await expect(page.locator('#microscopy-calibration')).toHaveText('X 0.500 µm/px · Y 0.250 µm/px · Z 2.00 µm');
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await expectScaleBarFits(page);

  await drawEllipseRoi(page);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  if (await page.locator('#roi-results-panel').evaluate(panel => panel.classList.contains('collapsed'))) {
    await page.locator('#roi-results-panel .sec-title').click();
  }
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  const row = page.locator('[data-roi-result-row]');
  await expect(row).toContainText('Z 2');
  await expect(row).toContainText('µm²');

  const csvDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const csvDownload = await csvDownloadPromise;
  const csv = await readFile(await csvDownload.path(), 'utf8');
  const [header, line] = csv.trim().split('\n');
  expect(header).toBe('roi,roi_object_id,series,series_slug,slice,z_index0,kind,label,x_px,y_px,count,length_um,length_mm,length_px,angle_deg,channel,channel_index0,time,time_index0,area_um2,area_mm2,pixels,mean,std,min,max,value_unit,value_source,created_at,source_format,source_files,source_warnings,xy_spacing_row_mm,xy_spacing_col_mm,z_spacing_mm,calibration_unit,calibration_source,spacing_trust,raw_int_den,perimeter_um,perimeter_mm,perimeter_px,circularity,x_um,y_um,x_mm,y_mm,int_den,int_den_mm2');
  const cells = line.split(',');
  expect(cells[4]).toBe('2');
  expect(cells[5]).toBe('1');
  expect(cells[6]).toBe('ellipse');
  expect(Number(cells[19])).toBeGreaterThan(0);
  expect(Number(cells[20])).toBeGreaterThan(0);
  expect(Number(cells[21])).toBeGreaterThan(0);
  expect(cells[29]).toBe('TIFF sequence');
  expect(cells[30]).toContain('seq_replay_z001.tif');
  expect(cells[31]).toBe('');
  expect(cells[32]).toBe('0.00025');
  expect(cells[33]).toBe('0.0005');
  expect(cells[34]).toBe('0.002');
  expect(cells[35]).toBe('µm');
  expect(cells[36]).toBe('manual');
  expect(cells[37]).toBe('Manual calibration');

  const jsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-json-export').click();
  const jsonDownload = await jsonDownloadPromise;
  const jsonBundlePath = await jsonDownload.path();
  const bundle = JSON.parse(await readFile(jsonBundlePath, 'utf8'));
  expect(bundle.source.format).toBe('TIFF sequence');
  expect(bundle.calibration).toMatchObject({ xyKnown: true, rowMm: 0.00025, colMm: 0.0005, zKnown: true, zMm: 0.002, trust: 'Manual calibration' });
  expect(bundle.rows[0]).toMatchObject({ slice: 2, sliceIndex: 1, kind: 'ellipse', areaUnit: 'µm²' });
  expect(bundle.source.dataset.axes.filter(axis => ['x', 'y', 'z'].includes(axis.name)).map(axis => [axis.name, axis.scale, axis.unit, axis.known])).toEqual([
    ['x', 0.5, 'µm', true],
    ['y', 0.25, 'µm', true],
    ['z', 2, 'µm', true],
  ]);

  const mismatchedBundlePath = testInfo.outputPath('mismatched-roi-results.json');
  await writeFile(mismatchedBundlePath, `${JSON.stringify({
    ...bundle,
    calibration: { ...bundle.calibration, rowMm: 0.001 },
  }, null, 2)}\n`);
  await page.locator('#roi-results-json-import-input').setInputFiles(mismatchedBundlePath);
  await expect(page.locator('#roi-results-status')).toHaveText('ROI bundle calibration does not match this microscopy stack');
  await expect(page.locator('#roi-results-count')).toHaveText('1');

  const pngDownloadPromise = page.waitForEvent('download');
  await page.locator('#btn-shot').click();
  const pngDownload = await pngDownloadPromise;
  const pngBytes = await readFile(await pngDownload.path());
  expect(pngDownload.suggestedFilename()).toMatch(/_z2_c1_t1\.png$/);
  expect(pngBytes.length).toBeGreaterThan(50);

  const tiffDownloadPromise = page.waitForEvent('download');
  await page.locator('#btn-cmdk-open').click();
  await page.locator('#cmdk-input').fill('tiff snapshot');
  await page.getByRole('button', { name: /Rendered TIFF snapshot/ }).click();
  const tiffDownload = await tiffDownloadPromise;
  expect(tiffDownload.suggestedFilename()).toMatch(/_z2_c1_t1\.tif$/);
  const tiffMetrics = await renderedTiffMetrics(await tiffDownload.path());
  expect(tiffMetrics).toMatchObject({
    magic: [0x49, 0x49, 42],
    width,
    height,
    compression: 1,
    photometric: 2,
    samplesPerPixel: 3,
    xResolution: 2,
    yResolution: 4,
    resolutionUnit: 1,
    pixelByteCount: width * height * 3,
  });
  expect(tiffMetrics.description).toContain('ImageJ=1.54');
  expect(tiffMetrics.description).toContain('unit=um');
  expect(tiffMetrics.description).toContain('pixel_width=0.5');
  expect(tiffMetrics.description).toContain('pixel_height=0.25');
  expect(tiffMetrics.description).toContain('spacing=2');
  expect(tiffMetrics.description).toContain('label=Z 2 · C1 Channel 1 · T1');
  expect(tiffMetrics.roiBluePixels, JSON.stringify(tiffMetrics)).toBeGreaterThan(8);
  expect(tiffMetrics.scaleBarBrightPixels, JSON.stringify(tiffMetrics)).toBeGreaterThan(35);

  const measuredRecipeDownloadPromise = page.waitForEvent('download');
  await page.locator('#microscopy-recipe-export').click();
  const measuredRecipeDownload = await measuredRecipeDownloadPromise;
  const measuredRecipePath = await measuredRecipeDownload.path();
  const measuredRecipe = JSON.parse(await readFile(measuredRecipePath, 'utf8'));
  expect(measuredRecipe.target.sourceFormat).toBe('TIFF sequence');
  expect(measuredRecipe.requirements).toMatchObject({ calibrationRequired: true, measurementPrerequisite: 'results-present' });
  expect(measuredRecipe.exportPreferences).toMatchObject({ embeddedRoiResults: true });
  expect(measuredRecipe.view.sliceIndex).toBe(1);
  expect(measuredRecipe.roiResults.rows).toHaveLength(1);
  expect(measuredRecipe.roiResults.rows[0]).toMatchObject({
    roiObjectId: bundle.rows[0].roiObjectId,
    slice: 2,
    sliceIndex: 1,
    kind: 'ellipse',
    areaUnit: 'µm²',
  });

  await page.evaluate(async () => {
    const { clearCurrentSliceDrawings } = await import('/js/clear-slice-drawings.js');
    clearCurrentSliceDrawings();
  });
  await page.locator('#clear-confirm').click();
  await expect(page.locator('#roi-results-count')).toHaveText('0');
  const clippedRecipePath = testInfo.outputPath('clipped-embedded-roi-recipe.json');
  await writeFile(clippedRecipePath, `${JSON.stringify({
    ...measuredRecipe,
    view: { ...measuredRecipe.view, sliceIndex: 0 },
    roiResults: {
      ...measuredRecipe.roiResults,
      rows: [{
        ...measuredRecipe.roiResults.rows[0],
      }, {
        ...measuredRecipe.roiResults.rows[0],
        roiObjectId: `${measuredRecipe.roiResults.rows[0].roiObjectId}:clipped`,
        label: 'Clipped embedded ROI',
        points: [[1, 1], [width + 10, 1], [1, 4]],
      }],
    },
  }, null, 2)}\n`);
  await page.locator('#microscopy-recipe-import-input').setInputFiles(clippedRecipePath);
  await expect(page.locator('#microscopy-recipe-status')).toHaveText('Recipe ROI results include rows that do not fit this microscopy stack.');
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await expect(page.locator('#roi-results-count')).toHaveText('0');

  const countBeforeClippedRecipeDrop = await page.locator('#series-list li').count();
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await dropFiles(page, '#upload-zone', [
    ...replaySequencePaths.map(path => ({ path, mimeType: 'image/tiff' })),
    { path: clippedRecipePath, mimeType: 'application/json' },
  ]);
  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-list li')).toHaveCount(countBeforeClippedRecipeDrop + 1);
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Skipped 1 microscopy workflow recipe' }))
    .toContainText('clipped-embedded-roi-recipe.json (Recipe ROI results include rows that do not fit this microscopy stack)');
  await expect(page.locator('#roi-results-count')).toHaveText('0');

  await page.locator('#microscopy-recipe-import-input').setInputFiles(measuredRecipePath);
  await expect(page.locator('#microscopy-recipe-status')).toHaveText('Workflow recipe replayed');
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  const recipeRow = page.locator('[data-roi-result-row]');
  await expect(recipeRow).toHaveAttribute('data-roi-object-id', bundle.rows[0].roiObjectId);
  await expect(recipeRow).toContainText('Z 2');
  await expect(recipeRow).toContainText('µm²');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);

  await page.evaluate(async () => {
    const { clearCurrentSliceDrawings } = await import('/js/clear-slice-drawings.js');
    clearCurrentSliceDrawings();
  });
  await page.locator('#clear-confirm').click();
  await expect(page.locator('#roi-results-count')).toHaveText('0');
  await page.locator('#roi-results-json-import-input').setInputFiles(jsonBundlePath);
  await expect(page.locator('#roi-results-status')).toHaveText('Imported 1 result row');
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  const importedRow = page.locator('[data-roi-result-row]');
  await expect(importedRow).toHaveAttribute('data-roi-object-id', bundle.rows[0].roiObjectId);
  await expect(importedRow).toContainText('Z 2');
  await expect(importedRow).toContainText('µm²');
  await expect(importedRow).toContainText('Display-domain 8-bit intensity');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);

  await page.evaluate(async () => {
    const { clearCurrentSliceDrawings } = await import('/js/clear-slice-drawings.js');
    clearCurrentSliceDrawings();
  });
  await page.locator('#clear-confirm').click();
  await expect(page.locator('#roi-results-count')).toHaveText('0');
  const clippedBundlePath = testInfo.outputPath('clipped-roi-results.json');
  await writeFile(clippedBundlePath, `${JSON.stringify({
    ...bundle,
    rows: [{
      ...bundle.rows[0],
      roiObjectId: `${bundle.rows[0].roiObjectId}:bounded`,
      label: 'Accepted bounded ROI',
    }, {
      ...bundle.rows[0],
      roiObjectId: `${bundle.rows[0].roiObjectId}:clipped-polygon`,
      label: 'Clipped polygon',
      points: [[1, 1], [width + 10, 1], [1, 4]],
    }, {
      roiObjectId: `measure:${bundle.series.slug}|${bundle.rows[0].sliceIndex}:clipped-line`,
      sliceIndex: bundle.rows[0].sliceIndex,
      kind: 'line',
      label: 'Clipped line',
      points: [[2, 2], [-1, 2]],
      lengthMm: 0.001,
    }, {
      roiObjectId: `angle:${bundle.series.slug}|${bundle.rows[0].sliceIndex}:clipped-angle`,
      sliceIndex: bundle.rows[0].sliceIndex,
      kind: 'angle',
      label: 'Clipped angle',
      points: [[2, 2], [4, 4], [4, height + 5]],
      angleDeg: 45,
    }],
  }, null, 2)}\n`);
  await page.locator('#roi-results-json-import-input').setInputFiles(clippedBundlePath);
  await expect(page.locator('#roi-results-status')).toHaveText('Imported 1 result row; skipped incompatible rows');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  await expect(page.locator('[data-roi-result-row]')).toContainText('Accepted bounded ROI');
  await expect(page.locator('[data-roi-result-row]')).not.toContainText('Clipped');
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);

  await page.evaluate(async () => {
    const { clearCurrentSliceDrawings } = await import('/js/clear-slice-drawings.js');
    clearCurrentSliceDrawings();
  });
  await page.locator('#clear-confirm').click();
  await expect(page.locator('#roi-results-count')).toHaveText('0');
  const countBeforeClippedBundleDrop = await page.locator('#series-list li').count();
  await page.locator('#btn-upload').click();
  await expect(page.locator('#upload-modal')).toBeVisible();
  await dropFiles(page, '#upload-zone', [
    ...replaySequencePaths.map(path => ({ path, mimeType: 'image/tiff' })),
    { path: calibrationRecipePath, mimeType: 'application/json' },
    { path: clippedBundlePath, mimeType: 'application/json' },
  ]);
  await expect(page.locator('#upload-modal')).toBeHidden();
  await expect(page.locator('#series-list li')).toHaveCount(countBeforeClippedBundleDrop + 1);
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Replayed 1 microscopy workflow recipe' }))
    .toContainText('from VoxelLab sidecar');
  await expect(page.locator('#notify-container .notify-text', { hasText: 'Imported 1 ROI result row' }))
    .toContainText('skipped incompatible rows from VoxelLab sidecar.');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  await expect(page.locator('[data-roi-result-row]')).toContainText('Accepted bounded ROI');

  await page.evaluate(async () => {
    const { clearCurrentSliceDrawings } = await import('/js/clear-slice-drawings.js');
    clearCurrentSliceDrawings();
  });
  await page.locator('#clear-confirm').click();
  await expect(page.locator('#roi-results-count')).toHaveText('0');
  const sparseBundlePath = testInfo.outputPath('sparse-density-roi-results.json');
  await writeFile(sparseBundlePath, `${JSON.stringify({
    ...bundle,
    rows: [{
      roiObjectId: bundle.rows[0].roiObjectId,
      sliceIndex: bundle.rows[0].sliceIndex,
      kind: bundle.rows[0].kind,
      label: 'Sparse density',
      points: bundle.rows[0].points,
      rawIntDen: 1234,
      intDen: 56.75,
      intDenMm2: 0.00005675,
    }],
  }, null, 2)}\n`);
  await page.locator('#roi-results-json-import-input').setInputFiles(sparseBundlePath);
  await expect(page.locator('#roi-results-status')).toHaveText('Imported 1 result row');
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  const sparseCsvDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const sparseCsv = await readFile(await (await sparseCsvDownloadPromise).path(), 'utf8');
  const [sparseHeader, sparseLine] = sparseCsv.trim().split('\n');
  const sparseHeaders = sparseHeader.split(',');
  const sparseCells = sparseLine.split(',');
  expect(sparseCells[sparseHeaders.indexOf('raw_int_den')]).toBe('1234');
  expect(sparseCells[sparseHeaders.indexOf('int_den')]).toBe('56.75');
  expect(sparseCells[sparseHeaders.indexOf('int_den_mm2')]).toBe('0.00005675');
});

test('microscopy ROI results render calibrated rows and export CSV without layout overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const omeTiffPath = testInfo.outputPath('cells-roi.ome.tiff');
  await writeCalibratedOmeTiff(omeTiffPath);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);
  await waitForCanvasPaint(page, '#view');

  await page.locator('#roi-results-panel .sec-title').click();
  await expect(page.locator('#roi-results')).toContainText('No ROI results');
  await expect(page.locator('#roi-results-export')).toBeDisabled();
  await expect(page.locator('#roi-results-json-export')).toBeDisabled();

  await drawEllipseRoi(page);
  await expect(page.locator('#overlay-svg .roi-group')).toHaveCount(1);
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  await expect(page.locator('[data-roi-result-row]')).toContainText('ROI 1');
  await expect(page.locator('[data-roi-result-row]')).toContainText('µm²');
  await expect(page.locator('[data-roi-result-row]')).toContainText('Raw intensity (16-bit measurement)');
  const roiObjectId = await page.locator('[data-roi-result-row]').getAttribute('data-roi-object-id');
  expect(roiObjectId).toMatch(/^roi:[^|]+\|0:1$/);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const download = await downloadPromise;
  const csvPath = await download.path();
  const csv = await readFile(csvPath, 'utf8');
  const csvLines = csv.trim().split('\n');
  expect(csvLines[0]).toBe('roi,roi_object_id,series,series_slug,slice,z_index0,kind,label,x_px,y_px,count,length_um,length_mm,length_px,angle_deg,channel,channel_index0,time,time_index0,area_um2,area_mm2,pixels,mean,std,min,max,value_unit,value_source,created_at,source_format,source_files,source_warnings,xy_spacing_row_mm,xy_spacing_col_mm,z_spacing_mm,calibration_unit,calibration_source,spacing_trust,raw_int_den,perimeter_um,perimeter_mm,perimeter_px,circularity,x_um,y_um,x_mm,y_mm,int_den,int_den_mm2');
  const cells = csvLines[1].split(',');
  expect(cells[0]).toBe('1');
  expect(cells[1]).toBe(roiObjectId);
  expect(cells[2]).toBe('cells-roi');
  expect(cells[4]).toBe('1');
  expect(cells[5]).toBe('0');
  expect(cells[6]).toBe('ellipse');
  expect(cells[7]).toBe('ROI 1');
  expect(cells[14]).toBe('');
  expect(cells[15]).toBe('DAPI');
  expect(cells[16]).toBe('0');
  const areaUm2 = Number(cells[19]);
  const areaMm2 = Number(cells[20]);
  const pixels = Number(cells[21]);
  expect(pixels).toBeGreaterThan(0);
  expect(Math.abs(areaUm2 - pixels * CALIBRATED_OME_TIFF.pixelAreaUm2)).toBeLessThan(1e-6);
  expect(Math.abs(areaMm2 - pixels * CALIBRATED_OME_TIFF.pixelSpacingMm[0] * CALIBRATED_OME_TIFF.pixelSpacingMm[1])).toBeLessThan(1e-12);
  expect(cells[26]).toBe('raw');
  expect(cells[27]).toBe('raw_16bit');
  expect(cells[29]).toBe('OME-TIFF');
  expect(cells[30]).toBe('cells-roi.ome.tiff');
  expect(cells[31]).toBe('');
  expect(cells[32]).toBe(String(CALIBRATED_OME_TIFF.pixelSpacingMm[0]));
  expect(cells[33]).toBe(String(CALIBRATED_OME_TIFF.pixelSpacingMm[1]));
  expect(cells[34]).toBe('0.0015');
  expect(cells[35]).toBe('µm');
  expect(cells[36]).toBe('metadata');
  expect(cells[37]).toBe('Trusted metadata');
  expect(Number(cells[38])).toBeGreaterThan(0);

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 820, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await openDetailsPanelForViewport(page, viewport);
    await assertNoViewportOverflow(page);
  }
});

test('manual microscopy angle measurement enables ImageJ ROI ZIP export', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  const omeTiffPath = testInfo.outputPath('manual-angle-cells.ome.tiff');
  await writeCalibratedOmeTiff(omeTiffPath);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);
  await waitForCanvasPaint(page, '#view');
  await ensurePanelOpen(page, '#roi-results-panel', '#roi-results-imagej-export');
  await expect(page.locator('#roi-results-count')).toHaveText('0');
  await expect(page.locator('#roi-results-imagej-export')).toBeDisabled();

  await drawAngleMeasurement(page);
  await expect(page.locator('#overlay-svg .angle-group')).toHaveCount(1);
  await expect(page.locator('#roi-results-count')).toHaveText('1');
  const angleRow = page.locator('[data-roi-result-row]').filter({ hasText: 'Angle 1' });
  await expect(angleRow).toContainText('angle');
  await expect(angleRow).toContainText('Calibrated angle');
  await expect(angleRow).toContainText('°');
  await expect(page.locator('#roi-results-export')).toBeEnabled();
  await expect(page.locator('#roi-results-json-export')).toBeEnabled();
  await expect(page.locator('#roi-results-imagej-export')).toBeEnabled();

  const csvDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-export').click();
  const csvDownload = await csvDownloadPromise;
  const csv = await readFile(await csvDownload.path(), 'utf8');
  const [csvRow] = parseCsvRows(csv);
  expect(csvRow.kind).toBe('angle');
  expect(csvRow.label).toBe('Angle 1');
  expect(Number(csvRow.angle_deg)).toBeGreaterThan(0);
  expect(csvRow.value_source).toBe('angular_measurement');
  expect(csvRow.source_format).toBe('OME-TIFF');
  expect(csvRow.xy_spacing_row_mm).toBe('0.00025');
  expect(csvRow.xy_spacing_col_mm).toBe('0.0005');
  expect(csvRow.channel_index0).toBe('0');
  expect(csvRow.time_index0).toBe('0');

  const jsonDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-json-export').click();
  const jsonDownload = await jsonDownloadPromise;
  const json = JSON.parse(await readFile(await jsonDownload.path(), 'utf8'));
  expect(json.rows).toHaveLength(1);
  expect(json.rows[0]).toMatchObject({
    kind: 'angle',
    label: 'Angle 1',
    channelIndex: 0,
    timeIndex: 0,
    valueSource: 'angular_measurement',
  });
  expect(json.rows[0].angleDeg).toBeCloseTo(Number(csvRow.angle_deg), 6);
  expect(json.rows[0].points).toHaveLength(3);

  const imagejDownloadPromise = page.waitForEvent('download');
  await page.locator('#roi-results-imagej-export').click();
  const imagejDownload = await imagejDownloadPromise;
  const imagejZipPath = testInfo.outputPath('manual-angle-imagej-rois.zip');
  await imagejDownload.saveAs(imagejZipPath);
  const exportedRois = await parseImageJRoiZip(await readFile(imagejZipPath));
  expect(exportedRois).toHaveLength(1);
  expect(exportedRois[0].shape).toBe('angle');
  expect(exportedRois[0].name).toBe('Angle-1_z1_c1_t1');
  expect(exportedRois[0].label).toBe('Angle 1');
  expect(exportedRois[0].points).toHaveLength(3);
});

test('OME microscopy hyperstack import stays one series and switches channels without losing Z', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const omeTiffPath = testInfo.outputPath('cells-hyper.ome.tiff');
  await writeHyperstackOmeTiff(omeTiffPath);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropFiles(page, '#upload-zone', [{ path: omeTiffPath, mimeType: 'image/tiff' }]);
  await expect(page.locator('#series-name')).toHaveText('cells-hyper');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#slice-tot')).toHaveText('2');
  await expect(page.locator('#meta')).toContainText('Z 2 · C 2 · T 1');
  await waitForCanvasPaint(page, '#view');

  await page.locator('#scrub').evaluate((input) => {
    input.value = '1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await expect(page.locator('#microscopy-stack-panel')).toBeVisible();
  await page.locator('#microscopy-stack-panel .sec-title').click();
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('0');
  await expect(page.locator('.hyperstack-status')).toContainText('Z 2/2 · C 1/2 · T 1/1');
  await expect(page.locator('.hyperstack-channel-meta')).toContainText('DAPI · 460 nm');
  await expect(page.locator('.hyperstack-channel-swatch')).toHaveCSS('background-color', 'rgb(0, 0, 255)');
  const before = await page.locator('#view').evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  });

  await page.locator('#microscopy-channel-select').selectOption('1');
  await expect(page.locator('#microscopy-channel-select')).toHaveValue('1');
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await expect(page.locator('.hyperstack-status')).toContainText('Z 2/2 · C 2/2 · T 1/1');
  await expect(page.locator('.hyperstack-channel-meta')).toContainText('GFP · 510 nm');
  await expect(page.locator('.hyperstack-channel-swatch')).toHaveCSS('background-color', 'rgb(0, 255, 0)');
  await page.locator('#microscopy-composite-toggle').check();
  await expect(page.locator('#microscopy-composite-toggle')).toBeChecked();
  await expect(page.locator('.hyperstack-composite-list')).toContainText('C1 · DAPI');
  await expect(page.locator('.hyperstack-composite-list')).toContainText('C2 · GFP');
  const compositeUi = await page.locator('.hyperstack-composite-list').evaluate((list) => {
    return [...list.querySelectorAll('.hyperstack-checkbox-text')].every((text) => text.scrollWidth <= text.clientWidth + 1);
  });
  expect(compositeUi).toBe(true);
  const compositePixel = await page.locator('#view').evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return Array.from(ctx.getImageData(0, 0, 1, 1).data);
  });
  expect(compositePixel[1]).toBeGreaterThan(0);
  expect(compositePixel[2]).toBeGreaterThan(0);
  expect(compositePixel[0]).toBe(0);
  await page.locator('#microscopy-composite-c1').uncheck();
  const dapiOnlyPixel = await page.locator('#view').evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return Array.from(ctx.getImageData(0, 0, 1, 1).data);
  });
  expect(dapiOnlyPixel[2]).toBeGreaterThan(0);
  expect(dapiOnlyPixel[1]).toBe(0);
  const hyperstackUi = await page.locator('.hyperstack-channel-meta').evaluate((row) => {
    const text = row.querySelector('.hyperstack-channel-text');
    const rowRect = row.getBoundingClientRect();
    const textRect = text.getBoundingClientRect();
    return {
      rowRight: Math.round(rowRect.right),
      textRight: Math.round(textRect.right),
      textOverflow: text.scrollWidth > text.clientWidth + 1,
    };
  });
  expect(hyperstackUi.textOverflow).toBe(false);
  expect(hyperstackUi.textRight).toBeLessThanOrEqual(hyperstackUi.rowRight);
  const after = await page.locator('#view').evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  });
  expect(after).not.toEqual(before);

  const snapshot = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const series = state.manifest.series[state.seriesIdx];
    return {
      seriesCount: state.manifest.series.length,
      channelIndex: series.microscopy.channelIndex,
      channelName: series.microscopy.channelName,
      channelColor: series.microscopyDataset.channels[1].color,
      emissionWavelength: series.microscopyDataset.channels[1].emissionWavelength,
      timeIndex: series.microscopy.timeIndex,
      localStackCount: Object.keys(state._localMicroscopyStacks[series.slug]).length,
      mprHidden: document.getElementById('btn-mpr').classList.contains('hidden'),
      threeHidden: document.getElementById('btn-3d').classList.contains('hidden'),
    };
  });
  expect(snapshot).toEqual({
    seriesCount: initialCount + 1,
    channelIndex: 1,
    channelName: 'GFP',
    channelColor: '#00FF00',
    emissionWavelength: 510,
    timeIndex: 0,
    localStackCount: 2,
    mprHidden: false,
    threeHidden: false,
  });
});

test('ImageJ microscopy hyperstack import uses channel-fast order in the same C/T controls', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const imageJPath = testInfo.outputPath('cells-imagej.tif');
  await writeHyperstackImageJTiff(imageJPath);

  await routeConfig(page, { modalWebhookBase: '', r2PublicUrl: '', features: { cloudProcessing: false } });
  await openUploadModal(page);

  const initialCount = await page.locator('#series-list li').count();
  await dropFiles(page, '#upload-zone', [{ path: imageJPath, mimeType: 'image/tiff' }]);
  await expect(page.locator('#series-name')).toHaveText('cells-imagej');
  await expect(page.locator('#series-list li')).toHaveCount(initialCount + 1);
  await expect(page.locator('#series-desc')).toContainText('ImageJ-TIFF');
  await expect(page.locator('#meta')).toContainText('Z 2 · C 2 · T 1');
  await waitForCanvasPaint(page, '#view');

  await page.locator('#scrub').evaluate((input) => {
    input.value = '1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#microscopy-stack-panel .sec-title').click();
  const before = await page.locator('#view').evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  });

  await page.locator('#microscopy-channel-select').selectOption('1');
  await expect(page.locator('#slice-cur')).toHaveText('2');
  await expect(page.locator('.hyperstack-status')).toContainText('Z 2/2 · C 2/2 · T 1/1');
  const after = await page.locator('#view').evaluate((canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  });
  expect(after).not.toEqual(before);

  const snapshot = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.js');
    const series = state.manifest.series[state.seriesIdx];
    return {
      seriesCount: state.manifest.series.length,
      channelIndex: series.microscopy.channelIndex,
      channelName: series.microscopy.channelName,
      timeIndex: series.microscopy.timeIndex,
      localStackCount: Object.keys(state._localMicroscopyStacks[series.slug]).length,
    };
  });
  expect(snapshot).toEqual({
    seriesCount: initialCount + 1,
    channelIndex: 1,
    channelName: 'Channel 2',
    timeIndex: 0,
    localStackCount: 2,
  });
});
