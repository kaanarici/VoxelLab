/* global console, process, TextDecoder */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverOmeZarrMetadata, parseOmeZarrFiles } from '../js/microscopy/microscopy-zarr-import.js';
import { lengthUnitToMm, normalizeLengthUnit } from '../js/core/physical-units.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACK_ID = 'ome-zarr-public-metadata-sample';

async function fileLike(root, relativePath) {
  const filePath = path.join(root, relativePath);
  const bytes = await readFile(filePath);
  return {
    name: path.basename(relativePath),
    path: relativePath,
    webkitRelativePath: relativePath,
    async text() {
      return new TextDecoder('utf-8').decode(bytes);
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function axisSummary(metadata) {
  return Object.fromEntries(metadata.axes.map(axis => [axis.name, {
    size: axis.size,
    unit: axis.unit,
    scale: axis.scale,
    known: axis.known,
  }]));
}

function axisSpacingMm(axis) {
  return axis.known ? axis.scale * lengthUnitToMm(axis.unit) : 0;
}

function arraySummary(arrayMeta = {}) {
  return {
    shape: Array.isArray(arrayMeta.shape) ? arrayMeta.shape.map(Number) : [],
    chunks: Array.isArray(arrayMeta.chunks) ? arrayMeta.chunks.map(Number) : [],
    dtype: arrayMeta.dtype || '',
    order: arrayMeta.order || '',
    compressor: arrayMeta.compressor?.id || null,
  };
}

async function main() {
  const catalog = JSON.parse(await readFile(path.join(ROOT, 'demo_packs/catalog.json'), 'utf8'));
  const pack = catalog.packs.find(item => item?.id === PACK_ID);
  assert.ok(pack, `${PACK_ID} pack missing from catalog`);
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'voxellab-ome-zarr-public-'));
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

    const sourceRoot = path.join(tempRoot, pack.target_dir);
    const files = await Promise.all(pack.files.map(item => fileLike(sourceRoot, item.path)));
    const discovery = await discoverOmeZarrMetadata(files);
    assert.ok(discovery, 'public OME-Zarr metadata should be discoverable');
    const metadata = discovery.metadata;
    const contract = pack.fixture_contract;
    const axes = axisSummary(metadata);

    assert.deepEqual(metadata.errors, []);
    assert.equal(metadata.multiscales.version, contract.ngff_version);
    assert.equal(metadata.pixel.type, contract.pixel_type);
    assert.deepEqual(metadata.levels.map(level => level.path), contract.levels);
    assert.deepEqual(contract.level_arrays.map(item => ({
      path: item.path,
      ...arraySummary(discovery.arrayMetadataByPath[item.path]),
    })), contract.level_arrays);
    assert.deepEqual(metadata.channels.map(channel => channel.name), contract.channels);
    assert.deepEqual(metadata.channels.map(channel => channel.color), contract.channel_colors);
    assert.deepEqual(metadata.channels.map(channel => channel.lut), contract.channel_luts);
    assert.deepEqual(metadata.channels.map(channel => channel.dataRange), contract.channel_data_ranges);
    assert.deepEqual(metadata.channels.map(channel => channel.displayRange), contract.channel_display_ranges);
    assert.equal(axes.c.size, contract.dimensions[0]);
    assert.equal(axes.z.size, contract.dimensions[1]);
    assert.equal(axes.y.size, contract.dimensions[2]);
    assert.equal(axes.x.size, contract.dimensions[3]);
    assert.equal(axes.z.unit, contract.physical_units.z);
    assert.equal(axes.y.unit, contract.physical_units.y);
    assert.equal(axes.x.unit, contract.physical_units.x);
    assert.equal(axes.z.known, true);
    assert.equal(axes.y.known, true);
    assert.equal(axes.x.known, true);
    assert.equal(normalizeLengthUnit(axes.z.unit), 'µm');
    assert.equal(normalizeLengthUnit(axes.y.unit), 'µm');
    assert.equal(normalizeLengthUnit(axes.x.unit), 'µm');
    assert.equal(axes.z.scale, contract.physical_scales_micrometer.z);
    assert.equal(axes.y.scale, contract.physical_scales_micrometer.y);
    assert.equal(axes.x.scale, contract.physical_scales_micrometer.x);
    assert.equal(axisSpacingMm(axes.z), contract.physical_spacing_mm.z);
    assert.equal(axisSpacingMm(axes.y), contract.physical_spacing_mm.y);
    assert.equal(axisSpacingMm(axes.x), contract.physical_spacing_mm.x);
    assert.equal(metadata.warnings.includes('ome_version_missing'), false);

    const parsed = await parseOmeZarrFiles(files);
    assert.deepEqual(parsed.results, []);
    assert.equal(parsed.status.includes('OME-Zarr metadata recognized'), true, parsed.status);
    assert.equal(parsed.status.includes('uncompressed chunks only'), true, parsed.status);

    console.log(JSON.stringify({
      pack: PACK_ID,
      source: contract.root,
      version: metadata.multiscales.version,
      pixelType: metadata.pixel.type,
      axes: contract.axes_order,
      dimensions: contract.dimensions,
      physicalUnits: {
        z: axes.z.unit,
        y: axes.y.unit,
        x: axes.x.unit,
      },
      physicalSpacingMm: {
        z: axisSpacingMm(axes.z),
        y: axisSpacingMm(axes.y),
        x: axisSpacingMm(axes.x),
      },
      channels: metadata.channels.map(channel => ({
        name: channel.name,
        color: channel.color,
        lut: channel.lut,
        displayRange: channel.displayRange,
      })),
      levels: metadata.levels.map(level => ({
        path: level.path,
        ...arraySummary(discovery.arrayMetadataByPath[level.path]),
      })),
      boundary: 'metadata-only: compressed public arrays and remote chunks intentionally fail closed',
    }, null, 2));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
