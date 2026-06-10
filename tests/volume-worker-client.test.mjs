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
