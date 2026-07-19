import assert from 'node:assert/strict';
import { test } from 'node:test';

import { state } from '../js/core/state.js';

let importCounter = 0;

function rawUint16Buffer(values) {
  const bytes = new Uint16Array(values);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function freshHrModule() {
  importCounter += 1;
  return import(`../js/volume/volume-hr-voxels.js?test=${importCounter}`);
}

test('ensureHRVoxels falls back to main-thread normalization when worker postMessage fails', async (t) => {
  const hadWorker = Object.hasOwn(globalThis, 'Worker');
  const hadFetch = Object.hasOwn(globalThis, 'fetch');
  const hadSelf = Object.hasOwn(globalThis, 'self');
  const previousWorker = globalThis.Worker;
  const previousFetch = globalThis.fetch;
  const previousSelf = globalThis.self;

  t.after(() => {
    if (hadWorker) globalThis.Worker = previousWorker;
    else delete globalThis.Worker;
    if (hadFetch) globalThis.fetch = previousFetch;
    else delete globalThis.fetch;
    if (hadSelf) globalThis.self = previousSelf;
    else delete globalThis.self;
  });

  delete globalThis.self;
  globalThis.Worker = class {
    postMessage() {
      throw new Error('worker unavailable');
    }
  };
  globalThis.fetch = async () => new globalThis.Response(rawUint16Buffer([0, 65535]), { status: 200 });

  state.manifest = {
    series: [{
      slug: 'raw_stack',
      width: 1,
      height: 1,
      slices: 2,
      hasRaw: true,
    }],
  };
  state.seriesIdx = 0;
  state.hrVoxels = null;
  state.hrKey = '';
  state.hrLoading = null;
  state.hrLoadingKey = '';
  state.hrAbortController = null;
  state._localRawVolumes = {};

  const { ensureHRVoxels } = await freshHrModule();
  const result = await ensureHRVoxels();

  assert.ok(result instanceof Float32Array);
  assert.deepEqual([...result], [0, 1]);
  assert.equal(state.hrVoxels, result);
  assert.equal(state.hrKey, '0:raw_stack:');
});

test('ensureHRVoxels rejects oversized encoded responses before buffering or caching', async (t) => {
  const previous = {
    Worker: globalThis.Worker,
    caches: globalThis.caches,
    fetch: globalThis.fetch,
    self: globalThis.self,
    warn: console.warn,
  };
  const had = Object.fromEntries(Object.keys(previous).map(key => [key, Object.hasOwn(globalThis, key)]));
  let cacheWrites = 0;
  let arrayBufferReads = 0;
  const cache = {
    async keys() { return []; },
    async delete() { return true; },
    async match() { return null; },
    async put() { cacheWrites += 1; },
  };

  t.after(() => {
    for (const key of ['Worker', 'caches', 'fetch', 'self']) {
      if (had[key]) globalThis[key] = previous[key];
      else delete globalThis[key];
    }
    console.warn = previous.warn;
  });

  delete globalThis.Worker;
  globalThis.self = { caches: globalThis.caches };
  globalThis.caches = { open: async () => cache, keys: async () => [], delete: async () => true };
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: name => name === 'content-length' ? '1000000' : null },
    body: null,
    async arrayBuffer() {
      arrayBufferReads += 1;
      return new ArrayBuffer(1);
    },
  });
  console.warn = () => {};

  state.manifest = {
    series: [{
      slug: 'oversized_remote_raw',
      width: 1,
      height: 1,
      slices: 1,
      hasRaw: false,
      rawUrl: 'https://assets.example/oversized.raw.zst',
    }],
  };
  state.seriesIdx = 0;
  state.hrVoxels = null;
  state.hrKey = '';
  state.hrLoading = null;
  state.hrLoadingKey = '';
  state.hrAbortController = null;
  state._localRawVolumes = {};

  const { ensureHRVoxels } = await freshHrModule();
  assert.equal(await ensureHRVoxels(), null);
  assert.equal(arrayBufferReads, 0);
  assert.equal(cacheWrites, 0);
});

test('ensureHRVoxels retains a bounded fallback after a transferred worker payload fails', async (t) => {
  const previousWorker = globalThis.Worker;
  const previousFetch = globalThis.fetch;
  const previousSelf = globalThis.self;
  const hadWorker = Object.hasOwn(globalThis, 'Worker');
  const hadFetch = Object.hasOwn(globalThis, 'fetch');
  const hadSelf = Object.hasOwn(globalThis, 'self');
  const { terminateVolumeWorker } = await import('../js/volume/volume-worker-client.js');
  terminateVolumeWorker();

  t.after(() => {
    terminateVolumeWorker();
    if (hadWorker) globalThis.Worker = previousWorker;
    else delete globalThis.Worker;
    if (hadFetch) globalThis.fetch = previousFetch;
    else delete globalThis.fetch;
    if (hadSelf) globalThis.self = previousSelf;
    else delete globalThis.self;
  });

  delete globalThis.self;
  globalThis.Worker = class {
    postMessage(message, transfer) {
      structuredClone(message, { transfer });
      globalThis.queueMicrotask(() => {
        this.onmessage({ data: { id: message.id, type: 'error', error: 'worker decode failed' } });
      });
    }
    terminate() {}
  };
  globalThis.fetch = async () => new Response(rawUint16Buffer([0, 65535]), { status: 200 });

  state.manifest = {
    series: [{ slug: 'worker_fallback', width: 1, height: 1, slices: 2, hasRaw: true }],
  };
  state.seriesIdx = 0;
  state.hrVoxels = null;
  state.hrKey = '';
  state.hrLoading = null;
  state.hrLoadingKey = '';
  state.hrAbortController = null;
  state._localRawVolumes = {};

  const { ensureHRVoxels } = await freshHrModule();
  assert.deepEqual([...(await ensureHRVoxels())], [0, 1]);
});

test('ensureHRVoxels does not evict a valid cached response when selection aborts', async (t) => {
  const previous = {
    Worker: globalThis.Worker,
    caches: globalThis.caches,
    fetch: globalThis.fetch,
    self: globalThis.self,
  };
  const had = Object.fromEntries(Object.keys(previous).map(key => [key, Object.hasOwn(globalThis, key)]));
  const { terminateVolumeWorker } = await import('../js/volume/volume-worker-client.js');
  terminateVolumeWorker();
  let cacheDeletes = 0;
  const cache = {
    async keys() { return []; },
    async delete() { cacheDeletes += 1; return true; },
    async match() {
      state.hrAbortController.abort();
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    },
    async put() {},
  };

  t.after(() => {
    terminateVolumeWorker();
    for (const key of Object.keys(previous)) {
      if (had[key]) globalThis[key] = previous[key];
      else delete globalThis[key];
    }
  });

  delete globalThis.Worker;
  globalThis.self = { caches: {} };
  globalThis.caches = { open: async () => cache, keys: async () => [], delete: async () => true };
  globalThis.fetch = async () => { throw new Error('cache hit should not fetch'); };
  state.manifest = {
    series: [{
      slug: 'cached_abort',
      width: 1,
      height: 1,
      slices: 1,
      hasRaw: false,
      rawUrl: 'https://assets.example/cached.raw.zst',
    }],
  };
  state.seriesIdx = 0;
  state.hrVoxels = null;
  state.hrKey = '';
  state.hrLoading = null;
  state.hrLoadingKey = '';
  state.hrAbortController = null;
  state._localRawVolumes = {};

  const { ensureHRVoxels } = await freshHrModule();
  assert.equal(await ensureHRVoxels(), null);
  assert.equal(cacheDeletes, 0);
});
