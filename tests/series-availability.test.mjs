import assert from 'node:assert/strict';
import { test } from 'node:test';
import { URL } from 'node:url';

globalThis.location = new URL('http://127.0.0.1/');
const previousFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).endsWith('config.local.json')) return new Response('', { status: 404 });
  if (String(url).endsWith('config.json')) return Response.json({ localApiToken: 'local-dev-token' });
  throw new Error(`unexpected fetch ${url}`);
};
const config = await import('../js/config.js');
await config.loadConfig();
globalThis.fetch = previousFetch;

const {
  probeSeriesAvailable,
  firstAvailableSeriesIdx,
  seriesProbeOrder,
  isSeriesKnownUnavailable,
  clearSeriesAvailability,
  markSeriesUnavailable,
  seriesCanOpenInViewer,
  seriesHasSessionPixels,
} = await import('../js/series/series-availability.js');

const series = (slug, extra = {}) => ({ slug, slices: 10, ...extra });
const okFetch = async () => ({ ok: true });
const notFoundFetch = async () => ({ ok: false, status: 404 });

test('probeSeriesAvailable accepts a series whose opening slice resolves', async () => {
  assert.equal(await probeSeriesAvailable(series('t2_tse'), { fetchImpl: okFetch }), true);
});

test('probeSeriesAvailable rejects a non-ok response', async () => {
  assert.equal(await probeSeriesAvailable(series('t2_tse'), { fetchImpl: notFoundFetch }), false);
});

test('probeSeriesAvailable treats a transport failure as unavailable', async () => {
  const throwing = async () => { throw new Error('502 Bad Gateway'); };
  assert.equal(await probeSeriesAvailable(series('cloud_ct3'), { fetchImpl: throwing }), false);
});

test('probeSeriesAvailable fails closed on a series declaring no slices', async () => {
  let called = false;
  const spy = async () => { called = true; return { ok: true }; };
  assert.equal(await probeSeriesAvailable({ slug: 'empty', slices: 0 }, { fetchImpl: spy }), false);
  assert.equal(called, false, 'must not fetch for a series that declares no slices');
});

test('probeSeriesAvailable gives up once the timeout aborts', async () => {
  const hang = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  assert.equal(await probeSeriesAvailable(series('slow'), { fetchImpl: hang, timeoutMs: 10 }), false);
});

test('firstAvailableSeriesIdx skips unreachable series and opens the first that resolves', async () => {
  clearSeriesAvailability();
  const list = [series('cloud_a'), series('cloud_b'), series('local_c')];
  const fetchImpl = async (url) => ({ ok: String(url).includes('local_c') });

  const idx = await firstAvailableSeriesIdx(list, [0, 1, 2], { fetchImpl });

  assert.equal(idx, 2);
  assert.equal(isSeriesKnownUnavailable('cloud_a'), true);
  assert.equal(isSeriesKnownUnavailable('cloud_b'), true);
  assert.equal(isSeriesKnownUnavailable('local_c'), false);
});

test('firstAvailableSeriesIdx stops probing at the cap and still opens a series', async () => {
  clearSeriesAvailability();
  const list = Array.from({ length: 8 }, (_, i) => series(`s${i}`));
  let probes = 0;
  const fetchImpl = async () => { probes += 1; return { ok: false }; };

  const idx = await firstAvailableSeriesIdx(list, [0, 1, 2, 3, 4, 5, 6, 7], { fetchImpl, maxProbes: 3 });

  assert.equal(probes, 3, 'probing must be bounded so an offline manifest cannot stall boot');
  assert.equal(idx, 3, 'the next candidate is accepted unprobed rather than opening nothing');
});

test('firstAvailableSeriesIdx reports -1 for an empty manifest', async () => {
  assert.equal(await firstAvailableSeriesIdx([], [], { fetchImpl: okFetch }), -1);
});

test('seriesProbeOrder puts the preferred index first and keeps the rest in manifest order', () => {
  const list = [series('a'), series('b'), series('c')];
  assert.deepEqual(seriesProbeOrder(list, 2), [2, 0, 1]);
  assert.deepEqual(seriesProbeOrder(list, 0), [0, 1, 2]);
});

test('seriesProbeOrder drops a preferred index that is not in the manifest', () => {
  assert.deepEqual(seriesProbeOrder([series('a')], 5), [0]);
});

test('seriesCanOpenInViewer accepts in-session local stacks without a remote URL', () => {
  const local = series('local_ct4');
  const stacks = { local_ct4: Array.from({ length: 10 }, () => ({ complete: true, naturalWidth: 1 })) };
  assert.equal(seriesHasSessionPixels(local, { localStacks: stacks }), true);
  assert.equal(seriesCanOpenInViewer(local, { localStacks: stacks }), true);
});

test('seriesCanOpenInViewer rejects a known-unavailable series without session pixels', () => {
  clearSeriesAvailability();
  markSeriesUnavailable('cloud_ct4');
  assert.equal(seriesCanOpenInViewer(series('cloud_ct4'), { localStacks: {} }), false);
});

test('seriesCanOpenInViewer allows a remote cloud series until it is known unavailable', () => {
  clearSeriesAvailability();
  const remote = series('cloud_ct4', { sliceUrlBase: 'https://r2.example/data/cloud_ct4' });
  assert.equal(seriesCanOpenInViewer(remote, { localStacks: {} }), true);
  markSeriesUnavailable('cloud_ct4');
  assert.equal(seriesCanOpenInViewer(remote, { localStacks: {} }), false);
});
