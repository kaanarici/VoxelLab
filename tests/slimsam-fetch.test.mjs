import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const originalFetch = globalThis.fetch;
const {
  slimsamFetchMeta,
  slimsamSetManifest,
} = await import('../js/overlay/slimsam-fetch.js');

after(() => {
  globalThis.fetch = originalFetch;
});

test('slimsamSetManifest clears slug-only metadata caches', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({
        width: calls === 1 ? 128 : 256,
        height: 64,
        slices: 3,
        embed_dim: 256,
        embed_h: 64,
        embed_w: 64,
      }),
    };
  };

  slimsamSetManifest({ series: [{ slug: 'scan', rawUrl: 'https://example.test/a.raw.zst' }] });
  assert.equal((await slimsamFetchMeta('scan')).width, 128);
  assert.equal((await slimsamFetchMeta('scan')).width, 128);
  assert.equal(calls, 1);

  slimsamSetManifest({ series: [{ slug: 'scan', rawUrl: 'https://example.test/b.raw.zst' }] });
  assert.equal((await slimsamFetchMeta('scan')).width, 256);
  assert.equal(calls, 2);
});
