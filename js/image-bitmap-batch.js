export const DEFAULT_IMAGE_BITMAP_CONCURRENCY = 8;

function bitmapConcurrency(value) {
  const requested = Math.trunc(Number(value));
  const limit = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_IMAGE_BITMAP_CONCURRENCY;
  return Math.min(limit, DEFAULT_IMAGE_BITMAP_CONCURRENCY);
}

export async function createImageBitmapBatch(sources, { concurrency = DEFAULT_IMAGE_BITMAP_CONCURRENCY } = {}) {
  const input = Array.from(sources || []);
  const bitmaps = new Array(input.length);
  const workerCount = Math.min(
    bitmapConcurrency(concurrency),
    input.length,
  );
  let next = 0;
  let failed = false;
  const run = async () => {
    while (!failed) {
      const index = next;
      next += 1;
      if (index >= input.length) return;
      try {
        bitmaps[index] = await createImageBitmap(input[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };

  const results = await Promise.allSettled(Array.from({ length: workerCount }, run));
  const failedResult = results.find(result => result.status === 'rejected');
  if (failedResult) {
    for (const bitmap of bitmaps) bitmap?.close?.();
    throw failedResult.reason;
  }
  return bitmaps;
}
