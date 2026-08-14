import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const {
  DEFAULT_IMAGE_BITMAP_CONCURRENCY,
  createImageBitmapBatch,
} = await import('../js/image-bitmap-batch.js');

test('createImageBitmapBatch caps concurrent bitmap creation', async (t) => {
  const previousCreateImageBitmap = globalThis.createImageBitmap;
  let active = 0;
  let maxActive = 0;
  const releaseQueue = [];

  t.after(() => {
    globalThis.createImageBitmap = previousCreateImageBitmap;
  });

  globalThis.createImageBitmap = async (source) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => releaseQueue.push(resolve));
    active -= 1;
    return { source };
  };

  const pending = createImageBitmapBatch([0, 1, 2, 3, 4], { concurrency: 2 });
  while (releaseQueue.length < 2) await delay(0);
  assert.equal(maxActive, 2);
  for (;;) {
    const release = releaseQueue.shift();
    if (!release) break;
    release();
    await delay(0);
  }
  while (releaseQueue.length) releaseQueue.shift()();

  const bitmaps = await pending;
  assert.deepEqual(bitmaps.map(bitmap => bitmap.source), [0, 1, 2, 3, 4]);
  assert.equal(maxActive, 2);
});

test('createImageBitmapBatch clamps excessive requested concurrency', async (t) => {
  const previousCreateImageBitmap = globalThis.createImageBitmap;
  let active = 0;
  let maxActive = 0;
  const releaseQueue = [];

  t.after(() => {
    globalThis.createImageBitmap = previousCreateImageBitmap;
  });

  globalThis.createImageBitmap = async (source) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => releaseQueue.push(resolve));
    active -= 1;
    return { source };
  };

  const sources = Array.from({ length: DEFAULT_IMAGE_BITMAP_CONCURRENCY + 4 }, (_, index) => index);
  const pending = createImageBitmapBatch(sources, { concurrency: 10_000 });
  while (releaseQueue.length < DEFAULT_IMAGE_BITMAP_CONCURRENCY) await delay(0);
  assert.equal(maxActive, DEFAULT_IMAGE_BITMAP_CONCURRENCY);
  for (;;) {
    const release = releaseQueue.shift();
    if (!release) break;
    release();
    await delay(0);
  }
  while (releaseQueue.length) releaseQueue.shift()();

  const bitmaps = await pending;
  assert.deepEqual(bitmaps.map(bitmap => bitmap.source), sources);
  assert.equal(maxActive, DEFAULT_IMAGE_BITMAP_CONCURRENCY);
});

test('createImageBitmapBatch closes partial bitmaps on failure', async (t) => {
  const previousCreateImageBitmap = globalThis.createImageBitmap;
  const closed = [];

  t.after(() => {
    globalThis.createImageBitmap = previousCreateImageBitmap;
  });

  globalThis.createImageBitmap = async (source) => {
    if (source === 'bad') throw new Error('decode failed');
    return { close: () => closed.push(source) };
  };

  await assert.rejects(
    () => createImageBitmapBatch(['ok', 'bad'], { concurrency: 1 }),
    /decode failed/,
  );
  assert.deepEqual(closed, ['ok']);
});

test('createImageBitmapBatch closes bitmaps from slower in-flight workers after failure', async (t) => {
  const previousCreateImageBitmap = globalThis.createImageBitmap;
  const closed = [];

  t.after(() => {
    globalThis.createImageBitmap = previousCreateImageBitmap;
  });

  globalThis.createImageBitmap = async (source) => {
    if (source === 'slow') await delay(1);
    if (source === 'bad') throw new Error('decode failed');
    return { close: () => closed.push(source) };
  };

  await assert.rejects(
    () => createImageBitmapBatch(['slow', 'bad', 'late'], { concurrency: 2 }),
    /decode failed/,
  );
  assert.deepEqual(closed, ['slow']);
});
