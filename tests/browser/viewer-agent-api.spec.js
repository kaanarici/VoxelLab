import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const HEADER_BYTES = 352;

function phantomNifti({ width = 160, height = 120, depth = 6, spacing = [0.5, 0.75, 2] } = {}) {
  const buffer = Buffer.alloc(HEADER_BYTES + width * height * depth);
  buffer.writeInt32LE(348, 0);
  buffer.write('n+1\0', 344, 'ascii');
  [3, width, height, depth, 1, 1, 1, 1].forEach((value, index) => buffer.writeInt16LE(value, 40 + index * 2));
  buffer.writeInt16LE(2, 70);
  buffer.writeInt16LE(8, 72);
  [1, ...spacing].forEach((value, index) => buffer.writeFloatLE(value, 76 + index * 4));
  buffer.writeFloatLE(HEADER_BYTES, 108);
  buffer.writeUInt8(2, 123);
  for (let z = 0; z < depth; z++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const inDisk = (x + 0.5 - 80) ** 2 + (y + 0.5 - 60) ** 2 <= 400;
        buffer[HEADER_BYTES + z * width * height + y * width + x] = inDisk ? 200 : 20;
      }
    }
  }
  return buffer;
}

test('agent API opens a calibrated volume and measures in physical units', async ({ page }, testInfo) => {
  const path = testInfo.outputPath('agent-phantom.nii');
  await writeFile(path, phantomNifti());
  await page.route('**/data/manifest.json', (route) => route.fulfill({ json: { patient: 'anonymous', studyDate: '', series: [] } }));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.voxellab?.ready === true);

  const empty = await page.evaluate(() => window.voxellab.call('measure', { from: [1, 1], to: [2, 2] }).catch((e) => e.message));
  expect(empty).toContain('no study is open');

  const inputs = await page.evaluate(() => window.voxellab.call('prepare_import'));
  await page.setInputFiles(inputs.files, path);
  const opened = await page.evaluate(() => window.voxellab.call('open'));
  expect(opened.opened).toHaveLength(1);
  expect(opened.opened[0]).toMatchObject({ name: 'agent-phantom', width: 160, height: 120, slices: 6, calibrated: true, pixelSpacingMm: { row: 0.75, col: 0.5 } });

  const call = (method, params) => page.evaluate(([m, p]) => window.voxellab.call(m, p), [method, params]);
  expect(await call('measure', { from: [60, 60], to: [100, 60] })).toMatchObject({ lengthPx: 40, lengthMm: 20, calibrated: true });
  expect(await call('measure', { from: [80, 40], to: [80, 80], slice: 3 })).toMatchObject({ slice: 3, lengthMm: 30 });
  expect((await call('angle', { points: [[100, 60], [80, 60], [80, 40]] })).degrees).toBeCloseTo(90, 6);

  const ellipse = await call('roi', { "shape": 'ellipse', center: [80, 60], radii: [10, 10] });
  expect(ellipse.stats.area_mm2).toBeCloseTo(ellipse.stats.pixels * 0.375, 6);
  expect(ellipse.stats.std).toBe(0);
  const square = await call('roi', { "shape": 'polygon', points: [[70, 50], [90, 50], [90, 70], [70, 70]] });
  expect(square.stats.area_mm2).toBeCloseTo(square.stats.pixels * 0.375, 6);

  const inside = await call('pixel', { x: 80, y: 60 });
  const outside = await call('pixel', { x: 5, y: 5 });
  expect(inside.displayValue).toBeGreaterThan(outside.displayValue);
  expect(inside.patientMm).toEqual({ x: 40, y: 45, z: 6 });

  await call('annotate', { x: 80, y: 60, text: 'disk center' });
  const { rows, notes } = await call('list_findings');
  expect(rows.map((row) => row.kind).sort()).toEqual(['angle', 'ellipse', 'line', 'line', 'polygon']);
  expect(notes).toEqual([{ slice: 3, x: 80, y: 60, text: 'disk center' }]);
  const csv = await call('export_roi_csv');
  expect(csv.rows).toBe(rows.length);
  expect(csv.csv.split('\n')[0]).toContain('kind');

  const outOfBounds = await call('measure', { from: [0, 0], to: [500, 0] }).catch((e) => e.message);
  expect(outOfBounds).toContain('outside the 160x120 image');
});
