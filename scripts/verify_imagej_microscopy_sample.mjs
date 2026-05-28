/* global console, process */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rm, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { parseMicroscopyFiles } from '../js/microscopy-import.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACK_ID = 'imagej-confocal-series-sample';

function installCanvasStub() {
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            createImageData(width, height) {
              return { width, height, data: new Uint8ClampedArray(width * height * 4) };
            },
            putImageData() {},
          };
        },
      };
    },
  };
}

function arrayBufferFor(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function approxEqual(actual, expected, label) {
  assert.ok(Math.abs(Number(actual) - Number(expected)) < 1e-15, `${label}: ${actual} != ${expected}`);
}

function installStorageStub() {
  const storage = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); },
    },
  });
  if (!globalThis.location) globalThis.location = new URL('http://127.0.0.1/');
}

async function verifyCalibratedRoiCsv(entry, expected) {
  installStorageStub();
  const [
    { setRoiEntriesForSlice },
    { roiResultRows, roiResultsCsv },
    { state },
  ] = await Promise.all([
    import('../js/annotation-graph.js'),
    import('../js/roi-results.js'),
    import('../js/state.js'),
  ]);
  const pixels = 40;
  const areaMm2 = pixels * entry.pixelSpacing[0] * entry.pixelSpacing[1];
  state.manifest = { series: [entry] };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  setRoiEntriesForSlice(entry.slug, 0, [{
    id: 1,
    shape: 'polygon',
    microscopy: {
      channelIndex: 0,
      channelName: entry.microscopy?.channelName || '',
      timeIndex: 0,
    },
    stats: {
      pixels,
      area_mm2: areaMm2,
      mean: 12,
      std: 3,
      min: 1,
      max: 20,
    },
    createdAt: 1_700_000_000_000,
  }]);

  const [row] = roiResultRows(state, entry);
  assert.equal(row.pixels, pixels);
  assert.equal(row.areaUnit, 'µm²');
  approxEqual(row.areaMm2, areaMm2, 'ROI area mm2');
  approxEqual(row.areaUnit2, pixels * (expected.expected_pixel_spacing_mm[0] / 0.001) * (expected.expected_pixel_spacing_mm[1] / 0.001), 'ROI area um2');

  const [header, line] = roiResultsCsv([row], entry).trim().split('\n');
  assert.equal(header, 'roi,roi_object_id,series,series_slug,slice,kind,channel,time,area_um2,area_mm2,pixels,mean,std,min,max,value_unit,value_source,created_at');
  const cells = line.split(',');
  assert.equal(cells[0], '1');
  assert.equal(cells[5], 'polygon');
  assert.equal(Number(cells[8]), row.areaUnit2);
  assert.equal(Number(cells[9]), row.areaMm2);
  assert.equal(Number(cells[10]), pixels);
  assert.equal(cells[15], '8-bit');
  assert.equal(cells[16], 'display_8bit');
  return {
    pixels,
    areaUm2: row.areaUnit2,
    areaMm2: row.areaMm2,
    csvHeader: header,
  };
}

function expectedStackKeys(fixture) {
  if (Array.isArray(fixture.local_stack_keys)) return fixture.local_stack_keys;
  const [, , , channelCount, timeCount] = fixture.dimensions;
  const keys = [];
  for (let timeIndex = 0; timeIndex < timeCount; timeIndex += 1) {
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      keys.push(`${channelIndex}|${timeIndex}`);
    }
  }
  return keys;
}

async function extractZip(zipPath, targetDir) {
  await mkdir(targetDir, { recursive: true });
  const script = [
    'import os, pathlib, sys, zipfile',
    'zip_path = pathlib.Path(sys.argv[1])',
    'target = pathlib.Path(sys.argv[2])',
    'root = target.resolve()',
    'with zipfile.ZipFile(zip_path) as bundle:',
    '    for info in bundle.infolist():',
    '        destination = (root / info.filename).resolve()',
    '        if not str(destination).startswith(str(root) + os.sep):',
    '            raise SystemExit(f"{info.filename}: zip member escapes extraction root")',
    '    bundle.extractall(target)',
  ].join('\n');
  execFileSync(process.execPath, [
    path.join(ROOT, 'scripts/run_python.mjs'),
    '-c',
    script,
    zipPath,
    targetDir,
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
}

async function main() {
  const catalog = JSON.parse(await readFile(path.join(ROOT, 'demo_packs/catalog.json'), 'utf8'));
  const pack = catalog.packs.find(item => item?.id === PACK_ID);
  assert.ok(pack, `${PACK_ID} pack missing from catalog`);
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'voxellab-imagej-sample-'));
  try {
    execFileSync(process.execPath, [
      path.join(ROOT, 'scripts/run_python.mjs'),
      path.join(ROOT, 'scripts/install_demo_data.py'),
      '--root', tempRoot,
      '--data-dir', path.join(tempRoot, 'data'),
      '--demo', 'none',
      '--pack', PACK_ID,
      '--json',
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });

    const fileMeta = pack.files[0];
    const fixture = pack.fixture_contract.files[0];
    const zipPath = path.join(tempRoot, pack.target_dir, fileMeta.path);
    const extractDir = path.join(tempRoot, 'extracted');
    await extractZip(zipPath, extractDir);

    const tiffPath = path.join(extractDir, fixture.archive_member);
    const bytes = await readFile(tiffPath);
    assert.equal(bytes.byteLength, fixture.size_bytes, `${fixture.archive_member} size mismatch`);
    assert.equal(sha256(bytes), fixture.sha256, `${fixture.archive_member} sha256 mismatch`);

    installCanvasStub();
    const results = await parseMicroscopyFiles([{
      name: fixture.archive_member,
      path: tiffPath,
      async arrayBuffer() {
        return arrayBufferFor(bytes);
      },
    }]);
    assert.equal(results?.length, 1, `${fixture.archive_member} should import as one microscopy series`);
    const entry = results[0].entry;
    const dataset = entry.microscopyDataset;
    const axes = Object.fromEntries(dataset.axes.map(axis => [axis.name, axis.size]));
    const [x, y, z, c, t] = fixture.dimensions;
    const stackKeys = expectedStackKeys(fixture);
    assert.deepEqual({ x: axes.x, y: axes.y, z: axes.z, c: axes.c, t: axes.t }, { x, y, z, c, t });
    assert.equal(dataset.planes.length, z * c * t, `${fixture.archive_member} plane count mismatch`);
    assert.deepEqual(Object.keys(results[0].localStacks), stackKeys, `${fixture.archive_member} local stack keys mismatch`);
    assert.deepEqual(entry.microscopy.availablePositions || [], stackKeys, `${fixture.archive_member} available positions mismatch`);
    for (const key of stackKeys) {
      assert.equal(results[0].localStacks[key]?.length, z, `${fixture.archive_member} ${key} Z stack length mismatch`);
    }
    assert.equal(dataset.source.originalFormat, 'ImageJ-TIFF');
    assert.equal(dataset.pixel.type, fixture.pixel_type);
    assert.equal(entry.imageDomain, 'microscopy');

    const expected = pack.fixture_contract.calibration;
    approxEqual(entry.pixelSpacing[0], expected.expected_pixel_spacing_mm[0], 'row spacing');
    approxEqual(entry.pixelSpacing[1], expected.expected_pixel_spacing_mm[1], 'column spacing');
    approxEqual(entry.sliceThickness, expected.expected_slice_thickness_mm, 'slice thickness');
    assert.deepEqual(dataset.source.warnings || [], expected.expected_warnings);
    const roiCsv = await verifyCalibratedRoiCsv(entry, expected);

    console.log(JSON.stringify({
      pack: PACK_ID,
      verified: {
        path: fileMeta.path,
        archiveMember: fixture.archive_member,
        axes: { x, y, z, c, t },
        stackKeys,
        pixelType: dataset.pixel.type,
        calibration: {
          pixelSpacing: entry.pixelSpacing,
          sliceThickness: entry.sliceThickness,
          warnings: dataset.source.warnings || [],
        },
        roiCsv,
      },
    }, null, 2));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
