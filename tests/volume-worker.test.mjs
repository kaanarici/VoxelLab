import assert from 'node:assert/strict';
import { test } from 'node:test';

let importCounter = 0;

async function installVolumeWorker(t, { drawImage } = {}) {
  const hadSelf = Object.hasOwn(globalThis, 'self');
  const hadOffscreenCanvas = Object.hasOwn(globalThis, 'OffscreenCanvas');
  const previousSelf = globalThis.self;
  const previousOffscreenCanvas = globalThis.OffscreenCanvas;
  const messages = [];

  t.after(() => {
    if (hadSelf) globalThis.self = previousSelf;
    else delete globalThis.self;
    if (hadOffscreenCanvas) globalThis.OffscreenCanvas = previousOffscreenCanvas;
    else delete globalThis.OffscreenCanvas;
  });

  globalThis.self = {
    onmessage: null,
    postMessage(message) {
      messages.push(message);
    },
  };
  globalThis.OffscreenCanvas = class {
    getContext() {
      return {
        clearRect() {},
        drawImage: drawImage || (() => {}),
        getImageData: () => ({ data: new Uint8ClampedArray([7, 0, 0, 255]) }),
      };
    }
  };

  importCounter += 1;
  await import(`../js/volume/volume-worker.js?test=${importCounter}`);
  return { messages };
}

test('volume worker closes transferred bitmaps after successful flatten', async (t) => {
  const { messages } = await installVolumeWorker(t);
  const closed = [];
  const bitmaps = [
    { close: () => closed.push('a') },
    { close: () => closed.push('b') },
  ];

  await globalThis.self.onmessage({ data: { id: 1, type: 'flatten-image-bitmaps', bitmaps, w: 1, h: 1, d: 2 } });

  assert.deepEqual(messages.map(message => message.type), ['flatten-result']);
  assert.deepEqual(closed, ['a', 'b']);
});

test('volume worker closes transferred bitmaps when flattening fails', async (t) => {
  const { messages } = await installVolumeWorker(t, {
    drawImage(bitmap) {
      if (bitmap.id === 'b') throw new Error('draw failed');
    },
  });
  const closed = [];
  const bitmaps = [
    { id: 'a', close: () => closed.push('a') },
    { id: 'b', close: () => closed.push('b') },
  ];

  await globalThis.self.onmessage({ data: { id: 2, type: 'flatten-image-bitmaps', bitmaps, w: 1, h: 1, d: 2 } });

  assert.deepEqual(messages.map(message => message.type), ['error']);
  assert.match(messages[0].error, /draw failed/);
  assert.deepEqual(closed, ['a', 'b']);
});
