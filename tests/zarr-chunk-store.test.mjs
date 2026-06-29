import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { setTimeout as setNodeTimeout, clearTimeout as clearNodeTimeout } from 'node:timers';
import { createRemoteZarrStore } from '../js/microscopy/zarr/zarr-chunk-store.js';
import { selectPyramidLevel } from '../js/microscopy/zarr/zarr-level-select.js';

function response({ status = 200, body = null, bytes = null } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
    async arrayBuffer() {
      const data = bytes || new Uint8Array();
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    },
  };
}

function bytes(length, start = 0) {
  return Uint8Array.from({ length }, (_, index) => (start + index) % 256);
}

function routeFetch(routes, calls = []) {
  return async (url) => {
    calls.push(url);
    const item = routes.get(url);
    if (!item) return response({ status: 404 });
    return typeof item === 'function' ? item(url) : item;
  };
}

function arrayMeta(overrides = {}) {
  return {
    zarr_format: 2,
    shape: [1, 4, 4],
    chunks: [1, 2, 2],
    dtype: '<u2',
    compressor: { id: 'blosc', cname: 'lz4' },
    filters: null,
    order: 'C',
    ...overrides,
  };
}

test('readJson fetches metadata and returns null on 404', async () => {
  const routes = new Map([
    ['https://example.test/cells.zarr/.zattrs', response({ body: { ome: { version: '0.4' } } })],
  ]);
  const store = createRemoteZarrStore({
    baseUrl: 'https://example.test/cells.zarr/',
    fetchImpl: routeFetch(routes),
    decode: async (data) => data,
  });

  assert.deepEqual(await store.readJson('.zattrs'), { ome: { version: '0.4' } });
  assert.equal(await store.readJson('missing/.zarray'), null);
});

test('readChunk builds dotted and slash-separated URLs and returns C-order chunk views', async () => {
  const calls = [];
  const routes = new Map([
    ['https://example.test/cells.zarr/0/0.1.1', response({ bytes: bytes(8, 10) })],
    ['https://example.test/cells.zarr/1/0/1/1', response({ bytes: bytes(8, 20) })],
  ]);
  const decodeCalls = [];
  const store = createRemoteZarrStore({
    baseUrl: 'https://example.test/cells.zarr',
    fetchImpl: routeFetch(routes, calls),
    decode: async (data, options) => {
      decodeCalls.push(options);
      return data;
    },
  });

  const dotted = await store.readChunk('0', [0, 1, 1], arrayMeta());
  const slashed = await store.readChunk('1', [0, 1, 1], arrayMeta({ dimension_separator: '/' }));

  assert.deepEqual(calls, [
    'https://example.test/cells.zarr/0/0.1.1',
    'https://example.test/cells.zarr/1/0/1/1',
  ]);
  assert.deepEqual(dotted.shape, [1, 2, 2]);
  assert.deepEqual(dotted.strides, [4, 2, 1]);
  assert.equal(dotted.view.byteLength, 8);
  assert.equal(slashed.view.byteLength, 8);
  assert.deepEqual(decodeCalls.map((item) => item.expectedBytes), [8, 8]);
  assert.deepEqual(decodeCalls[0].dtype, { bytes: 2 });
  assert.deepEqual(decodeCalls[0].compressor, { id: 'blosc', cname: 'lz4' });
});

test('readChunk rejects decoded byte-length mismatches with a named error', async () => {
  const routes = new Map([
    ['https://example.test/cells.zarr/0/0.0.0', response({ bytes: bytes(8) })],
  ]);
  const store = createRemoteZarrStore({
    baseUrl: 'https://example.test/cells.zarr',
    fetchImpl: routeFetch(routes),
    decode: async () => bytes(7),
  });

  await assert.rejects(
    store.readChunk('0', [0, 0, 0], arrayMeta()),
    (error) => error.name === 'ZarrChunkLengthError'
      && /expected 8, got 7/.test(error.message),
  );
});

test('readChunk LRU cache refreshes hits and evicts the oldest chunk', async () => {
  const counts = new Map();
  const routes = new Map([
    ['https://example.test/cells.zarr/0/0.0.0', () => response({ bytes: bytes(1, 0) })],
    ['https://example.test/cells.zarr/0/0.0.1', () => response({ bytes: bytes(1, 1) })],
    ['https://example.test/cells.zarr/0/0.0.2', () => response({ bytes: bytes(1, 2) })],
  ]);
  const fetchImpl = async (url) => {
    counts.set(url, (counts.get(url) || 0) + 1);
    return routes.get(url)(url);
  };
  const store = createRemoteZarrStore({
    baseUrl: 'https://example.test/cells.zarr',
    fetchImpl,
    decode: async (data) => data,
    cacheLimit: 2,
  });
  const meta = arrayMeta({ shape: [1, 1, 3], chunks: [1, 1, 1], dtype: '|u1' });

  await store.readChunk('0', [0, 0, 0], meta);
  await store.readChunk('0', [0, 0, 1], meta);
  await store.readChunk('0', [0, 0, 0], meta);
  await store.readChunk('0', [0, 0, 2], meta);
  await store.readChunk('0', [0, 0, 1], meta);

  assert.equal(counts.get('https://example.test/cells.zarr/0/0.0.0'), 1);
  assert.equal(counts.get('https://example.test/cells.zarr/0/0.0.1'), 2);
  assert.equal(counts.get('https://example.test/cells.zarr/0/0.0.2'), 1);
});

test('readChunk dedupes concurrent identical chunk requests', async () => {
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    await delay(5);
    return response({ bytes: bytes(8) });
  };
  const store = createRemoteZarrStore({
    baseUrl: 'https://example.test/cells.zarr',
    fetchImpl,
    decode: async (data) => data,
  });

  const [first, second] = await Promise.all([
    store.readChunk('0', [0, 0, 0], arrayMeta()),
    store.readChunk('0', [0, 0, 0], arrayMeta()),
  ]);

  assert.equal(fetchCount, 1);
  assert.equal(first, second);
});

test('readChunk bounds concurrent fetches', async () => {
  const tracker = { active: 0, maxActive: 0 };
  const fetchImpl = async () => {
    tracker.active += 1;
    tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
    try {
      await delay(5);
      return response({ bytes: bytes(1) });
    } finally {
      tracker.active -= 1;
    }
  };
  const store = createRemoteZarrStore({
    baseUrl: 'https://example.test/cells.zarr',
    fetchImpl,
    decode: async (data) => data,
    concurrency: 2,
  });
  const meta = arrayMeta({ shape: [1, 1, 6], chunks: [1, 1, 1], dtype: '|u1' });

  await Promise.all(Array.from({ length: 6 }, (_, x) => store.readChunk('0', [0, 0, x], meta)));

  assert.equal(tracker.maxActive <= 2, true);
  assert.equal(tracker.maxActive > 1, true);
});

test('abort rejects in-flight and queued chunk reads', async () => {
  const fetchImpl = async (_url, options = {}) => new Promise((_resolve, reject) => {
    const timer = setNodeTimeout(() => reject(new Error('fetch should have been aborted')), 100);
    options.signal.addEventListener('abort', () => {
      clearNodeTimeout(timer);
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const store = createRemoteZarrStore({
    baseUrl: 'https://example.test/cells.zarr',
    fetchImpl,
    decode: async (data) => data,
    concurrency: 1,
  });
  const meta = arrayMeta({ shape: [1, 1, 2], chunks: [1, 1, 1], dtype: '|u1' });

  const inFlight = store.readChunk('0', [0, 0, 0], meta);
  const queued = store.readChunk('0', [0, 0, 1], meta);
  await delay(0);
  store.abort();

  await assert.rejects(inFlight, { name: 'AbortError' });
  await assert.rejects(queued, { name: 'AbortError' });
});

test('selectPyramidLevel picks the coarsest fitting level or the coarsest fallback', () => {
  const levels = [
    { level: 0, path: '0', width: 8000, height: 4000, downsample: 1 },
    { level: 1, path: '1', width: 2000, height: 1000, downsample: 4 },
    { level: 2, path: '2', width: 500, height: 250, downsample: 16 },
  ];

  const withinBudget = selectPyramidLevel(levels, { maxPlanePixels: 4_000_000 });
  assert.equal(withinBudget.level, 2);
  assert.equal(withinBudget.path, '2');
  assert.equal(withinBudget.width, 500);
  assert.equal(withinBudget.height, 250);
  assert.equal(withinBudget.downsample, 16);
  assert.match(withinBudget.reason, /within 4000000 pixel budget/);

  const fallback = selectPyramidLevel(levels, { maxPlanePixels: 100_000 });
  assert.equal(fallback.level, 2);
  assert.match(fallback.reason, /no level fits 100000 pixel budget/);

  const empty = selectPyramidLevel([], { maxPlanePixels: 1 });
  assert.equal(empty.level, null);
  assert.match(empty.reason, /No pyramid levels/);
});
