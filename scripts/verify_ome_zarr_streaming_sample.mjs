#!/usr/bin/env node
/* global console, process, fetch, AbortSignal */
// Live end-to-end proof that VoxelLab streams a real, public, compressed,
// multiscale OME-Zarr dataset: fetches IDR metadata + chunks over the network,
// decodes Blosc(LZ4, byte-shuffle) uint16 chunks with the dependency-free codec,
// and asserts the decoded level-0 plane matches the authoritative numcodecs
// golden committed under tests/fixtures/zarr/. This is a network verifier (like
// demo:verify:*), not a hermetic unit test.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { decodeZarrChunk } from '../js/microscopy/zarr/zarr-codecs.js';
import { createRemoteZarrStore } from '../js/microscopy/zarr/zarr-chunk-store.js';
import { selectPyramidLevel } from '../js/microscopy/zarr/zarr-level-select.js';
import { normalizeOmeZarrMetadata } from '../js/microscopy/microscopy-zarr-metadata.js';

const BASE_URL = 'https://uk1s3.embassy.ebi.ac.uk/idr/zarr/v0.4/idr0062A/6001240.zarr';
const GOLDEN_URL = new URL('../tests/fixtures/zarr/idr0062A-6001240-L0-c0z0.golden.json', import.meta.url);
const REQUEST_TIMEOUT_MS = 30_000;

function timeoutFetch(url, options = {}) {
  const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);
  return fetch(url, { ...options, signal: AbortSignal.any(signals) });
}

function planeStats(view, count) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  const first8 = [];
  for (let i = 0; i < count; i += 1) {
    const value = view.getUint16(i * 2, true);
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
    if (i < 8) first8.push(value);
  }
  return { min, max, sum, first8 };
}

async function main() {
  const golden = JSON.parse(await readFile(GOLDEN_URL, 'utf8'));
  const store = createRemoteZarrStore({ baseUrl: BASE_URL, fetchImpl: timeoutFetch, decode: decodeZarrChunk });

  console.log(`Streaming OME-Zarr metadata from ${BASE_URL}`);
  const rootAttrs = await store.readJson('.zattrs');
  assert.ok(rootAttrs, 'root .zattrs should be fetchable');

  const multiscales = rootAttrs?.multiscales || rootAttrs?.attributes?.ome?.multiscales || [];
  const datasetPaths = (multiscales[0]?.datasets || []).map((d) => String(d.path));
  assert.deepEqual(datasetPaths, ['0', '1', '2'], 'expected 3 pyramid levels');

  const arrayMetadataByPath = {};
  for (const path of datasetPaths) {
    const meta = await store.readJson(`${path}/.zarray`);
    assert.ok(meta, `level ${path} .zarray should be fetchable`);
    arrayMetadataByPath[path] = meta;
  }

  const metadata = normalizeOmeZarrMetadata(rootAttrs, { arrayMetadataByPath });
  assert.deepEqual(metadata.errors, [], `metadata errors: ${metadata.errors.join(', ')}`);
  assert.equal(metadata.pixel.type, 'uint16', 'pixel type');
  assert.equal(metadata.levels.length, 3, 'level count');
  assert.equal(metadata.channels.length, 2, 'channel count');

  const level0 = arrayMetadataByPath['0'];
  assert.deepEqual(level0.shape, [2, 236, 275, 271], 'level-0 shape');
  assert.equal(level0.compressor?.id, 'blosc', 'level-0 compressor is blosc');
  assert.equal(level0.compressor?.cname, 'lz4', 'level-0 blosc cname is lz4');

  // normalizeOmeZarrMetadata().levels carry {level, path, scale} but not plane
  // dimensions, so enrich each level with width/height/downsample from its own
  // .zarray shape + the x/y axis indices before level-of-detail selection.
  const xIndex = metadata.axes.findIndex((axis) => axis.name === 'x');
  const yIndex = metadata.axes.findIndex((axis) => axis.name === 'y');
  const baseWidth = level0.shape[xIndex];
  const enrichedLevels = metadata.levels.map((level) => {
    const shape = arrayMetadataByPath[level.path]?.shape || [];
    const width = shape[xIndex];
    const height = shape[yIndex];
    return { ...level, width, height, downsample: width ? Math.round(baseWidth / width) : 1 };
  });

  // Pyramid level-of-detail selection: a tiny budget must pick a coarse level.
  const coarse = selectPyramidLevel(enrichedLevels, { maxPlanePixels: 10_000 });
  assert.ok(coarse.level && coarse.path !== '0', `coarse selection should avoid level 0, got ${coarse.path}`);
  console.log(`Level select (budget 10k px): level ${coarse.path} (${coarse.reason})`);

  // The proof: live-fetch + decode the real level-0 (c0,z0) chunk and match the
  // numcodecs golden bit-for-bit at the statistics level.
  console.log('Streaming + decoding level-0 chunk [0,0,0,0] (Blosc/LZ4/byte-shuffle)...');
  const chunk = await store.readChunk('0', [0, 0, 0, 0], level0);
  const count = chunk.shape[chunk.shape.length - 1] * chunk.shape[chunk.shape.length - 2];
  assert.equal(count, golden.count, 'decoded element count');
  const stats = planeStats(chunk.view, count);
  assert.deepEqual(stats.first8, golden.first8, 'first 8 decoded values');
  assert.equal(stats.min, golden.min, 'min');
  assert.equal(stats.max, golden.max, 'max');
  assert.equal(stats.sum, golden.sum, 'sum');

  // Prove a coarser level also streams + decodes (multiscale, not just level 0).
  const coarseMeta = arrayMetadataByPath[coarse.path];
  const coarseChunk = await store.readChunk(coarse.path, [0, 0, 0, 0], coarseMeta);
  assert.ok(coarseChunk.view.byteLength > 0, 'coarse level chunk decodes');
  console.log(`Coarse level ${coarse.path} chunk decoded: ${coarseChunk.shape.join('x')}`);

  store.abort();
  console.log('PASS: live IDR OME-Zarr streaming matches the authoritative numcodecs golden.');
}

main().catch((error) => {
  console.error(`FAIL: ${error?.message || error}`);
  process.exitCode = 1;
});
