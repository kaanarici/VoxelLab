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
