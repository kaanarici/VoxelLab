import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { setTimeout as setNodeTimeout, clearTimeout as clearNodeTimeout } from 'node:timers';
import { createRemoteZarrStore } from '../js/microscopy/zarr/zarr-chunk-store.js';

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

function chunkResponse({ chunks, contentLength, onArrayBuffer = () => {} }) {
  let index = 0;
  return {
    status: 200,
    ok: true,
    headers: { get: name => name.toLowerCase() === 'content-length' ? contentLength : null },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true };
            return { done: false, value: chunks[index++] };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    },
    async arrayBuffer() {
      onArrayBuffer();
      throw new Error('arrayBuffer must not be used for a streaming response');
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

test('readChunk decodes full declared Zarr v2 edge-chunk shapes', async () => {
  const calls = [];
  const routes = new Map([
    ['https://example.test/cells.zarr/0/0.1.1', response({ bytes: bytes(6, 10) })],
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

  const chunk = await store.readChunk('0', [0, 1, 1], arrayMeta({
    shape: [1, 3, 4],
    chunks: [1, 2, 3],
    dtype: '|u1',
    compressor: null,
  }));

  assert.deepEqual(chunk.shape, [1, 2, 3]);
  assert.deepEqual(chunk.strides, [6, 3, 1]);
  assert.equal(chunk.view.byteLength, 6);
  assert.equal(decodeCalls[0].expectedBytes, 6);
});

test('readChunk uses only a concrete declared fill value for a missing remote chunk', async () => {
  const store = createRemoteZarrStore({
    baseUrl: 'https://example.test/cells.zarr',
    fetchImpl: routeFetch(new Map()),
    decode: async data => data,
  });
  const filled = await store.readChunk('0', [0, 0, 0], arrayMeta({ fill_value: 12 }));
  assert.equal(filled.view, null);
  assert.equal(filled.fillValue, 12);

  await assert.rejects(
    store.readChunk('1', [0, 0, 0], arrayMeta({ fill_value: null })),
    error => error.name === 'ZarrChunkNotFoundError' && /no concrete fill_value/.test(error.message),
  );
  await assert.rejects(
    store.readChunk('2', [0, 0, 0], arrayMeta()),
    error => error.name === 'ZarrChunkNotFoundError' && /no concrete fill_value/.test(error.message),
  );
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

test('readChunk rejects declared decoded chunks over budget before scheduling a fetch', async () => {
  let fetches = 0;
  const store = createRemoteZarrStore({
    baseUrl: 'https://example.test/cells.zarr',
    fetchImpl: async () => {
      fetches += 1;
      return response({ bytes: bytes(1) });
    },
    decode: async (data) => data,
  });

  await assert.rejects(
    store.readChunk('0', [0, 0, 0], arrayMeta({
      shape: [100_000_000, 1, 1],
      chunks: [100_000_000, 1, 1],
      dtype: '|u1',
    })),
    (error) => error.name === 'ZarrChunkLengthError' && /decoded Zarr chunk exceeds/i.test(error.message),
  );
  assert.equal(fetches, 0);
});

test('readChunk rejects an oversized Content-Length without calling arrayBuffer', async () => {
  let arrayBufferCalls = 0;
  const store = createRemoteZarrStore({
    baseUrl: 'https://example.test/cells.zarr',
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      headers: { get: name => name.toLowerCase() === 'content-length' ? '9' : null },
      async arrayBuffer() {
        arrayBufferCalls += 1;
        return new ArrayBuffer(9);
      },
    }),
    decode: async (data) => data,
    maxEncodedChunkBytes: 8,
  });

  await assert.rejects(
    store.readChunk('0', [0, 0, 0], arrayMeta({ shape: [1, 1, 1], chunks: [1, 1, 1], dtype: '|u1' })),
    { name: 'ZarrChunkEncodedLengthError' },
  );
  assert.equal(arrayBufferCalls, 0);
});

test('readChunk stops a streamed payload that exceeds the encoded chunk budget', async () => {
  const store = createRemoteZarrStore({
    baseUrl: 'https://example.test/cells.zarr',
    fetchImpl: async () => chunkResponse({
      contentLength: '1',
      chunks: [bytes(5), bytes(5, 5)],
    }),
    decode: async (data) => data,
    maxEncodedChunkBytes: 8,
  });

  await assert.rejects(
    store.readChunk('0', [0, 0, 0], arrayMeta({ shape: [1, 1, 1], chunks: [1, 1, 1], dtype: '|u1' })),
    (error) => error.name === 'ZarrChunkEncodedLengthError' && /while streaming/.test(error.message),
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
