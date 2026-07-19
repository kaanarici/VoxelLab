/* global Response, queueMicrotask */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { URL } from 'node:url';

globalThis.location = new URL('http://127.0.0.1/');
const previousFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).endsWith('/config.local.json') || String(url).endsWith('./config.local.json')) {
    return new Response('', { status: 404 });
  }
  if (String(url).endsWith('/config.json') || String(url).endsWith('./config.json')) {
    return Response.json({ localApiToken: 'local-dev-token' });
  }
  throw new Error(`unexpected fetch ${url}`);
};
const config = await import('../js/config.js');
await config.loadConfig();
globalThis.fetch = previousFetch;

const {
  assetUrlForBrowser,
  imageUrlForStack,
  loadImageStack,
  rawVolumeUrlForSeries,
  regionMetaUrlForSeries,
  statsUrlForSeries,
} = await import('../js/series/series-image-stack.js');
const {
  BASE_PREFETCH_CONCURRENCY,
  REMOTE_BASE_PREFETCH_CONCURRENCY,
} = await import('../js/core/constants.js');
const { state } = await import('../js/core/state.js');

test('imageUrlForStack keeps bundled prototype data on local ./data paths', () => {
  const url = imageUrlForStack('t2_tse', 3, { slug: 't2_tse' });

  assert.equal(url, './data/t2_tse/0003.png');
});

test('imageUrlForStack supports R2-backed processed cloud series', () => {
  const series = { slug: 'cloud_job123', sliceUrlBase: 'https://r2.example/data/cloud_job123/' };

  const url = imageUrlForStack('cloud_job123', 12, series);

  assert.equal(url, '/api/proxy-asset?url=https%3A%2F%2Fr2.example%2Fdata%2Fcloud_job123%2F0012.png');
});

test('imageUrlForStack supports R2-backed overlay stacks without changing bundled overlays', () => {
  const series = {
    slug: 'cloud_job123',
    overlayUrlBases: {
      cloud_job123_regions: 'https://r2.example/data/cloud_job123_regions/',
    },
  };

  assert.equal(
    imageUrlForStack('cloud_job123_regions', 1, series),
    '/api/proxy-asset?url=https%3A%2F%2Fr2.example%2Fdata%2Fcloud_job123_regions%2F0001.png',
  );
  assert.equal(
    imageUrlForStack('t2_tse_regions', 1, { slug: 't2_tse' }),
    './data/t2_tse_regions/0001.png',
  );
});

test('imageUrlForStack supports the compact regionUrlBase manifest field', () => {
  const series = {
    slug: 'cloud_job123',
    regionUrlBase: 'https://r2.example/data/cloud_job123_regions/',
  };

  assert.equal(
    imageUrlForStack('cloud_job123_regions', 4, series),
    '/api/proxy-asset?url=https%3A%2F%2Fr2.example%2Fdata%2Fcloud_job123_regions%2F0004.png',
  );
});

test('regionMetaUrlForSeries supports R2-backed region sidecars', () => {
  const series = {
    slug: 'cloud_job123',
    regionMetaUrl: 'https://r2.example/data/cloud_job123_regions.json',
  };

  assert.equal(
    regionMetaUrlForSeries(series),
    '/api/proxy-asset?url=https%3A%2F%2Fr2.example%2Fdata%2Fcloud_job123_regions.json',
  );
  assert.equal(regionMetaUrlForSeries({ slug: 't2_tse' }), './data/t2_tse_regions.json');
});

test('assetUrlForBrowser keeps local assets direct and proxies remote ones on localhost', () => {
  assert.equal(assetUrlForBrowser('./data/t2_tse/0003.png'), './data/t2_tse/0003.png');
  assert.equal(
    assetUrlForBrowser('https://r2.example/cloud_job123.raw.zst'),
    '/api/proxy-asset?url=https%3A%2F%2Fr2.example%2Fcloud_job123.raw.zst',
  );
});

test('rawVolumeUrlForSeries proxies remote raw volumes on localhost', () => {
  assert.equal(
    rawVolumeUrlForSeries({ slug: 'cloud_job123', rawUrl: 'https://r2.example/cloud_job123.raw.zst' }),
    '/api/proxy-asset?url=https%3A%2F%2Fr2.example%2Fcloud_job123.raw.zst',
  );
  assert.equal(rawVolumeUrlForSeries({ slug: 't2_tse' }), './data/t2_tse.raw');
});

test('statsUrlForSeries supports R2-backed stats sidecars', () => {
  assert.equal(
    statsUrlForSeries({ slug: 'cloud_job123', statsUrl: 'https://r2.example/data/cloud_job123_stats.json' }),
    '/api/proxy-asset?url=https%3A%2F%2Fr2.example%2Fdata%2Fcloud_job123_stats.json',
  );
  assert.equal(statsUrlForSeries({ slug: 't2_tse' }), './data/t2_tse_stats.json');
});

test('loadImageStack keeps same-origin image loads on direct img src even when Cache Storage exists', async (t) => {
  const previousCaches = globalThis.caches;
  const previousFetch = globalThis.fetch;
  const previousImage = globalThis.Image;
  const loaded = [];

  t.after(() => {
    globalThis.caches = previousCaches;
    globalThis.fetch = previousFetch;
    globalThis.Image = previousImage;
  });

  globalThis.caches = { open: async () => { throw new Error('unexpected cache open'); } };
  globalThis.fetch = async () => { throw new Error('unexpected fetch'); };
  globalThis.Image = class {
    set src(value) {
      this._src = value;
      loaded.push(value);
      this.complete = true;
      this.naturalWidth = 1;
      queueMicrotask(() => this.onload?.());
    }

    get src() {
      return this._src;
    }
  };

  const result = loadImageStack('local_fast', 1, [], { slug: 'local_fast' }, { windowRadius: 0, initialIndex: 0 });
  await Promise.all(result.loaders);

  assert.deepEqual(loaded, ['./data/local_fast/0000.png']);
});

test('loadImageStack still fetches proxy images so local auth headers can be attached', async (t) => {
  const previousCaches = globalThis.caches;
  const previousFetch = globalThis.fetch;
  const previousImage = globalThis.Image;
  const previousCreateObjectUrl = URL.createObjectURL;
  const previousRevokeObjectUrl = URL.revokeObjectURL;
  const requests = [];
  const loaded = [];
  const revoked = [];

  t.after(() => {
    globalThis.caches = previousCaches;
    globalThis.fetch = previousFetch;
    globalThis.Image = previousImage;
    URL.createObjectURL = previousCreateObjectUrl;
    URL.revokeObjectURL = previousRevokeObjectUrl;
  });

  globalThis.caches = undefined;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), token: init?.headers?.['X-VoxelLab-Local-Token'] });
    return new Response('png', { status: 200 });
  };
  URL.createObjectURL = () => 'blob:proxy-image';
  URL.revokeObjectURL = (url) => revoked.push(url);
  globalThis.Image = class {
    set src(value) {
      this._src = value;
      loaded.push(value);
      this.complete = true;
      this.naturalWidth = 1;
      queueMicrotask(() => this.onload?.());
    }

    get src() {
      return this._src;
    }
  };

  const result = loadImageStack(
    'cloud_job123',
    1,
    [],
    { slug: 'cloud_job123', sliceUrlBase: 'https://r2.example/data/cloud_job123/' },
    { windowRadius: 0, initialIndex: 0 },
  );
  await Promise.all(result.loaders);

  assert.deepEqual(loaded, ['blob:proxy-image']);
  assert.deepEqual(revoked, ['blob:proxy-image']);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/proxy-asset\?url=/);
  assert.equal(requests[0].token, 'local-dev-token');
});

test('loadImageStack reuses in-memory local DICOM/NIfTI imports', async () => {
  const localImgs = [
    { complete: true, naturalWidth: 4 },
    { complete: true, naturalWidth: 4 },
  ];
  state._localStacks = { local_abc: localImgs };

  const result = loadImageStack('local_abc', 2, []);
  await Promise.all(result.loaders);

  assert.equal(result.imgs, localImgs);
  assert.equal(result.imgs._dir, 'local_abc');
});

test('loadImageStack limits local import loaders to the visible window', async () => {
  const localImgs = Array.from({ length: 20 }, () => ({ complete: true, naturalWidth: 4 }));
  state._localStacks = { local_windowed: localImgs };

  const result = loadImageStack(
    'local_windowed',
    20,
    [],
    { slug: 'local_windowed' },
    { windowRadius: 2, initialIndex: 10 },
  );
  await Promise.all(result.loaders);

  assert.equal(result.imgs, localImgs);
  assert.equal(result.loaders.length, 5);
});

test('loadImageStack can start with only a visible slice window and backfill later', async (t) => {
  const previousImage = globalThis.Image;
  const loaded = [];

  t.after(() => {
    globalThis.Image = previousImage;
  });

  globalThis.Image = class {
    set src(value) {
      this._src = value;
      loaded.push(value);
      this.complete = true;
      this.naturalWidth = 1;
      queueMicrotask(() => this.onload?.());
    }

    get src() {
      return this._src;
    }
  };

  const result = loadImageStack(
    'cloud_job123',
    20,
    [],
    { slug: 'cloud_job123', sliceUrlBase: './data/cloud_job123/' },
    { windowRadius: 5, initialIndex: 10 },
  );
  await Promise.all(result.loaders);

  assert.equal(result.imgs.filter(Boolean).length, 11);
  await result.imgs.prefetchRemaining(10, 5);
  assert.equal(result.imgs.filter(Boolean).length, 20);
  assert.equal(loaded.length, 20);
});

test('loadImageStack ensures the visible window when reusing a partial stack', async (t) => {
  const previousImage = globalThis.Image;
  const loaded = [];

  t.after(() => {
    globalThis.Image = previousImage;
  });

  globalThis.Image = class {
    set src(value) {
      this._src = value;
      loaded.push(value);
      this.complete = true;
      this.naturalWidth = 1;
      queueMicrotask(() => this.onload?.());
    }

    get src() {
      return this._src;
    }
  };

  const existing = new Array(8);
  existing._dir = 'cloud_job123';
  existing[0] = { complete: true, naturalWidth: 1, src: './already-loaded.png' };

  const result = loadImageStack(
    'cloud_job123',
    8,
    existing,
    { slug: 'cloud_job123', sliceUrlBase: './data/cloud_job123/' },
    { windowRadius: 1, initialIndex: 4 },
  );
  await Promise.all(result.loaders);

  assert.equal(result.imgs, existing);
  assert.deepEqual(Object.keys(existing).filter(key => /^\d+$/.test(key)).sort(), ['0', '3', '4', '5']);
  assert.deepEqual(loaded, [
    './data/cloud_job123/0003.png',
    './data/cloud_job123/0004.png',
    './data/cloud_job123/0005.png',
  ]);
});

test('loadImageStack retries a previously failed slice entry', async (t) => {
  const previousImage = globalThis.Image;
  const loaded = [];

  t.after(() => {
    globalThis.Image = previousImage;
  });

  globalThis.Image = class {
    set src(value) {
      this._src = value;
      loaded.push(value);
      this.complete = true;
      this.naturalWidth = 1;
      queueMicrotask(() => this.onload?.());
    }

    get src() {
      return this._src;
    }
  };

  const existing = new Array(3);
  existing._dir = 'cloud_job123';
  existing[1] = { complete: true, naturalWidth: 0, src: './failed-once.png' };

  const result = loadImageStack(
    'cloud_job123',
    3,
    existing,
    { slug: 'cloud_job123', sliceUrlBase: './data/cloud_job123/' },
    { windowRadius: 0, initialIndex: 1 },
  );
  await Promise.all(result.loaders);

  assert.equal(result.imgs, existing);
  assert.equal(existing[1].naturalWidth, 1);
  assert.deepEqual(loaded, [
    './data/cloud_job123/0001.png',
  ]);
});

test('loadImageStack prefetch skips already loaded slices but retries failed ones', async (t) => {
  const previousImage = globalThis.Image;
  const loaded = [];

  t.after(() => {
    globalThis.Image = previousImage;
  });

  globalThis.Image = class {
    set src(value) {
      this._src = value;
      loaded.push(value);
      this.complete = true;
      this.naturalWidth = 1;
      queueMicrotask(() => this.onload?.());
    }

    get src() {
      return this._src;
    }
  };

  const existing = new Array(5);
  existing._dir = 'cloud_job123';
  existing[0] = { complete: true, naturalWidth: 1, src: './already-loaded-0.png' };
  existing[1] = { complete: true, naturalWidth: 0, src: './failed-once-1.png' };
  existing[3] = { complete: true, naturalWidth: 1, src: './already-loaded-3.png' };

  const result = loadImageStack(
    'cloud_job123',
    5,
    existing,
    { slug: 'cloud_job123', sliceUrlBase: './data/cloud_job123/' },
    { windowRadius: 0, initialIndex: -1 },
  );
  await result.imgs.prefetchRemaining(2, 0, { concurrency: 1, limit: Infinity });

  assert.equal(result.imgs, existing);
  assert.deepEqual(loaded, [
    './data/cloud_job123/0001.png',
    './data/cloud_job123/0004.png',
  ]);
});

test('loadImageStack prefetch assigns each pending slice once across workers', async (t) => {
  const previousImage = globalThis.Image;
  const loaded = [];

  t.after(() => {
    globalThis.Image = previousImage;
  });

  globalThis.Image = class {
    set src(value) {
      this._src = value;
      loaded.push(value);
      this.complete = true;
      this.naturalWidth = 1;
      queueMicrotask(() => this.onload?.());
    }

    get src() {
      return this._src;
    }
  };

  const result = loadImageStack(
    'cloud_job123',
    7,
    [],
    { slug: 'cloud_job123', sliceUrlBase: './data/cloud_job123/' },
    { windowRadius: 0, initialIndex: 3 },
  );
  await Promise.all(result.loaders);
  loaded.length = 0;

  await result.imgs.prefetchRemaining(3, 0, { concurrency: 3, limit: Infinity });

  const loadedIndexes = loaded.map(url => Number(/(\d{4})\.png/.exec(url)?.[1]));
  assert.deepEqual(loadedIndexes, [2, 4, 1, 5, 0, 6]);
});

test('loadImageStack treats invalid prefetch concurrency as the default worker count', async (t) => {
  const previousImage = globalThis.Image;
  const loaded = [];

  t.after(() => {
    globalThis.Image = previousImage;
  });

  globalThis.Image = class {
    set src(value) {
      this._src = value;
      loaded.push(value);
      this.complete = true;
      this.naturalWidth = 1;
      queueMicrotask(() => this.onload?.());
    }

    get src() {
      return this._src;
    }
  };

  const result = loadImageStack(
    'cloud_job123',
    4,
    [],
    { slug: 'cloud_job123', sliceUrlBase: './data/cloud_job123/' },
    { windowRadius: 0, initialIndex: 1 },
  );
  await Promise.all(result.loaders);
  loaded.length = 0;

  await result.imgs.prefetchRemaining(1, 0, { concurrency: 0.5, limit: Infinity });

  const loadedIndexes = loaded.map(url => Number(/(\d{4})\.png/.exec(url)?.[1]));
  assert.deepEqual(loadedIndexes, [0, 2, 3]);
});

test('loadImageStack clamps excessive prefetch concurrency without lowering remote defaults', async (t) => {
  const previousImage = globalThis.Image;
  const tracker = { active: 0, maxActive: 0 };

  t.after(() => {
    globalThis.Image = previousImage;
  });

  globalThis.Image = class {
    set src(value) {
      this._src = value;
      this.complete = true;
      this.naturalWidth = 1;
      tracker.active += 1;
      tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
      queueMicrotask(() => {
        tracker.active -= 1;
        this.onload?.();
      });
    }

    get src() {
      return this._src;
    }
  };

  const result = loadImageStack(
    'cloud_job123',
    REMOTE_BASE_PREFETCH_CONCURRENCY + 10,
    [],
    { slug: 'cloud_job123', sliceUrlBase: './data/cloud_job123/' },
    { windowRadius: 0, initialIndex: 0 },
  );
  await Promise.all(result.loaders);
  tracker.active = 0;
  tracker.maxActive = 0;

  await result.imgs.prefetchRemaining(0, 0, { concurrency: 10_000, limit: Infinity });

  assert.equal(tracker.maxActive, REMOTE_BASE_PREFETCH_CONCURRENCY);
  assert.ok(tracker.maxActive > BASE_PREFETCH_CONCURRENCY);
});

test('loadImageStack bounded prefetch avoids scanning the whole stack', async (t) => {
  const previousImage = globalThis.Image;
  const loaded = [];
  let tailRead = false;

  t.after(() => {
    globalThis.Image = previousImage;
  });

  globalThis.Image = class {
    set src(value) {
      this._src = value;
      loaded.push(value);
      this.complete = true;
      this.naturalWidth = 1;
      queueMicrotask(() => this.onload?.());
    }

    get src() {
      return this._src;
    }
  };

  const result = loadImageStack(
    'cloud_job123',
    10000,
    [],
    { slug: 'cloud_job123', sliceUrlBase: './data/cloud_job123/' },
    { windowRadius: 0, initialIndex: 3 },
  );
  await Promise.all(result.loaders);
  loaded.length = 0;
  Object.defineProperty(result.imgs, 9999, {
    configurable: true,
    get() {
      tailRead = true;
      return undefined;
    },
  });

  await result.imgs.prefetchRemaining(3, 0, { concurrency: 1, limit: 2 });

  const loadedIndexes = loaded.map(url => Number(/(\d{4})\.png/.exec(url)?.[1]));
  assert.deepEqual(loadedIndexes, [2, 4]);
  assert.equal(tailRead, false);
});
