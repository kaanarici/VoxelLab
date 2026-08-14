import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMicroscopyFiles } from '../js/microscopy/microscopy-import.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACK_ID = 'ome-microscopy-samples';

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

async function main() {
  const catalog = JSON.parse(await readFile(path.join(ROOT, 'demo_packs/catalog.json'), 'utf8'));
  const pack = catalog.packs.find(item => item?.id === PACK_ID);
  assert.ok(pack, `${PACK_ID} pack missing from catalog`);
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'voxellab-ome-samples-'));
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

    installCanvasStub();
    const filesByPath = new Map(pack.files.map(item => [item.path, item]));
    const calibration = pack.fixture_contract.calibration || {};
    const expectedPixelSpacing = calibration.expected_pixel_spacing_mm || [0, 0];
    const expectedSliceThickness = calibration.expected_slice_thickness_mm || 0;
    const verified = [];
    for (const fixture of pack.fixture_contract.files) {
      const fileMeta = filesByPath.get(fixture.path);
      assert.ok(fileMeta, `${fixture.path} missing from pack files`);
      const filePath = path.join(tempRoot, pack.target_dir, fixture.path);
      const bytes = await readFile(filePath);
      assert.equal(bytes.byteLength, fileMeta.size_bytes, `${fixture.path} size mismatch`);
      const results = await parseMicroscopyFiles([{
        name: path.basename(fixture.path),
        path: filePath,
        async arrayBuffer() {
          return arrayBufferFor(bytes);
        },
      }]);
      assert.equal(results?.length, 1, `${fixture.path} should import as one microscopy series`);
      const entry = results[0].entry;
      const dataset = entry.microscopyDataset;
      const axes = Object.fromEntries(dataset.axes.map(axis => [axis.name, axis.size]));
      const [x, y, z, c, t] = fixture.dimensions;
      const stackKeys = expectedStackKeys(fixture);
      assert.deepEqual({ x: axes.x, y: axes.y, z: axes.z, c: axes.c, t: axes.t }, { x, y, z, c, t });
      assert.equal(dataset.planes.length, z * c * t, `${fixture.path} plane count mismatch`);
      assert.deepEqual(Object.keys(results[0].localStacks), stackKeys, `${fixture.path} local stack keys mismatch`);
      assert.deepEqual(entry.microscopy.availablePositions || [], stackKeys, `${fixture.path} available positions mismatch`);
      for (const key of stackKeys) {
        assert.equal(results[0].localStacks[key]?.length, z, `${fixture.path} ${key} Z stack length mismatch`);
      }
      assert.equal(dataset.source.originalFormat, 'OME-TIFF');
      assert.equal(entry.imageDomain, 'microscopy');
      assert.deepEqual(entry.pixelSpacing, expectedPixelSpacing, `${fixture.path} pixel spacing mismatch`);
      assert.equal(entry.sliceThickness, expectedSliceThickness, `${fixture.path} slice thickness mismatch`);
      const expectedWarnings = fixture.expected_warnings || calibration.expected_warnings || [];
      assert.deepEqual(dataset.source.warnings || [], expectedWarnings, `${fixture.path} calibration warnings mismatch`);
      verified.push({
        path: fixture.path,
        role: fixture.role,
        axes: { x, y, z, c, t },
        stackKeys,
        calibration: {
          pixelSpacing: entry.pixelSpacing,
          sliceThickness: entry.sliceThickness,
          warnings: dataset.source.warnings || [],
        },
      });
    }
    console.log(JSON.stringify({ pack: PACK_ID, verified }, null, 2));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
