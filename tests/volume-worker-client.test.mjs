import assert from 'node:assert/strict';
import { test } from 'node:test';

let importCounter = 0;

async function freshClient() {
  importCounter += 1;
  return import(`../js/volume/volume-worker-client.js?test=${importCounter}`);
}

function installWorker(t, WorkerClass, { offscreen = false } = {}) {
  const hadWorker = Object.hasOwn(globalThis, 'Worker');
  const hadOffscreen = Object.hasOwn(globalThis, 'OffscreenCanvas');
  const previousWorker = globalThis.Worker;
  const previousOffscreen = globalThis.OffscreenCanvas;

  t.after(() => {
    if (hadWorker) globalThis.Worker = previousWorker;
    else delete globalThis.Worker;
    if (hadOffscreen) globalThis.OffscreenCanvas = previousOffscreen;
    else delete globalThis.OffscreenCanvas;
  });

  globalThis.Worker = WorkerClass;
  if (offscreen) globalThis.OffscreenCanvas = class OffscreenCanvas {};
}

test('runVolumeWorker resolves null when worker postMessage throws', async (t) => {
  class ThrowingWorker {
    postMessage() {
      throw new Error('post failed');
    }
  }
  installWorker(t, ThrowingWorker);

  const { runVolumeWorker } = await freshClient();
  const result = await runVolumeWorker(new ArrayBuffer(4), true, 2);

  assert.equal(result, null);
});

test('parseDicomFilesInWorker resolves null when worker postMessage throws', async (t) => {
  class ThrowingWorker {
    postMessage() {
      throw new Error('post failed');
    }
  }
  installWorker(t, ThrowingWorker);

  const { parseDicomFilesInWorker } = await freshClient();
  const result = await parseDicomFilesInWorker([]);

  assert.equal(result, null);
});

test('flattenImageBitmapsInWorker rejects when worker postMessage throws', async (t) => {
  class ThrowingWorker {
    postMessage() {
      throw new Error('post failed');
    }
  }
  installWorker(t, ThrowingWorker, { offscreen: true });

  const { flattenImageBitmapsInWorker } = await freshClient();

  await assert.rejects(
    () => flattenImageBitmapsInWorker({ bitmaps: [{}], w: 1, h: 1, d: 1 }),
    /post failed/,
  );
});

test('runVolumeWorker still resolves worker results', async (t) => {
  class RespondingWorker {
    postMessage(message) {
      globalThis.queueMicrotask(() => {
        this.onmessage({
          data: {
            id: message.id,
            type: 'result',
            f32: new Float32Array([1, 2]),
          },
        });
      });
    }
  }
  installWorker(t, RespondingWorker);

  const { runVolumeWorker } = await freshClient();
  const result = await runVolumeWorker(new ArrayBuffer(4), false, 2);

  assert.deepEqual(Array.from(result), [1, 2]);
});

test('flattenImageBitmapsInWorker still resolves worker bytes', async (t) => {
  class RespondingWorker {
    postMessage(message) {
      globalThis.queueMicrotask(() => {
        this.onmessage({
          data: {
            id: message.id,
            type: 'flatten-result',
            bytes: new Uint8Array([7]),
          },
        });
      });
    }
  }
  installWorker(t, RespondingWorker, { offscreen: true });

  const { flattenImageBitmapsInWorker } = await freshClient();
  const result = await flattenImageBitmapsInWorker({ bitmaps: [{}], w: 1, h: 1, d: 1 });

  assert.deepEqual(Array.from(result), [7]);
});

test('worker errors settle every in-flight request and recreate the worker', async (t) => {
  const workers = [];
  class FailingWorker {
    constructor() {
      workers.push(this);
    }

    postMessage(message) {
      if (workers.length === 1) return;
      globalThis.queueMicrotask(() => {
        this.onmessage({
          data: { id: message.id, type: 'result', f32: new Float32Array([3]) },
        });
      });
    }

    terminate() {
      this.terminated = true;
    }
  }
  installWorker(t, FailingWorker, { offscreen: true });

  const {
    computeGradientInWorker,
    flattenImageBitmapsInWorker,
    parseDicomFilesInWorker,
    runVolumeWorker,
  } = await freshClient();
  const volume = runVolumeWorker(new ArrayBuffer(2), false, 1);
  const dicom = parseDicomFilesInWorker([]);
  const flatten = flattenImageBitmapsInWorker({ bitmaps: [{}], w: 1, h: 1, d: 1 });
  const gradient = computeGradientInWorker(new Float32Array([1]), 1, 1, 1, true);

  workers[0].onerror({ message: 'worker crashed', preventDefault() {} });

  assert.deepEqual(await Promise.allSettled([volume, dicom, flatten, gradient]), [
    { status: 'fulfilled', value: null },
    { status: 'fulfilled', value: null },
    { status: 'rejected', reason: new Error('worker crashed') },
    { status: 'rejected', reason: new Error('worker crashed') },
  ]);
  assert.equal(workers[0].terminated, true);

  const recovered = await runVolumeWorker(new ArrayBuffer(2), false, 1);
  assert.deepEqual(Array.from(recovered), [3]);
  assert.equal(workers.length, 2);
});

test('message errors and explicit termination reject worker-only operations', async (t) => {
  const workers = [];
  class SilentWorker {
    constructor() {
      workers.push(this);
    }

    postMessage() {}
    terminate() {
      this.terminated = true;
    }
  }
  installWorker(t, SilentWorker, { offscreen: true });

  const { flattenImageBitmapsInWorker, terminateVolumeWorker } = await freshClient();
  const messageError = flattenImageBitmapsInWorker({ bitmaps: [{}], w: 1, h: 1, d: 1 });
  workers[0].onmessageerror({ preventDefault() {} });
  await assert.rejects(messageError, /Volume worker message failed/);

  const pending = flattenImageBitmapsInWorker({ bitmaps: [{}], w: 1, h: 1, d: 1 });
  terminateVolumeWorker();

  await assert.rejects(pending, /Volume worker terminated/);
  assert.equal(workers[1].terminated, true);
});
