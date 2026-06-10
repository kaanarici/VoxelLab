/* global Request, Response */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import {
  CDN_DEPENDENCY_URLS,
  THREE_ADDONS_URL,
  THREE_MODULE_URL,
} from '../js/core/dependencies.js';
import { LAZY_OPTIONAL_MODULES } from '../scripts/gen_sw_manifest.mjs';
import { PRECACHE_LOCAL } from '../js/sw-precache-manifest.js';

const root = fileURLToPath(new URL('..', import.meta.url));
// Manifest precaches itself only via sw.js's own SW load, not as an app module.
const LAZY_JS_MODULES = new Set(
  [...LAZY_OPTIONAL_MODULES].filter((modulePath) => modulePath !== 'js/sw-precache-manifest.js'),
);
const PRECACHED = new Set(PRECACHE_LOCAL.map((asset) => asset.replace(/^\.\//, '')));

function walkFiles(dir, predicate) {
  const out = [];
  for (const entry of readdirSync(join(root, dir))) {
    const rel = join(dir, entry);
    const stat = statSync(join(root, rel));
    if (stat.isDirectory()) out.push(...walkFiles(rel, predicate));
    else if (predicate(rel)) out.push(rel);
  }
  return out;
}

test('service worker precaches local JS modules except lazy optional modules', () => {
  const modules = walkFiles('js', filePath => filePath.endsWith('.js'))
    .filter((modulePath) => modulePath !== 'js/sw-precache-manifest.js')
    .sort();
  const missing = modules.filter((modulePath) => !PRECACHED.has(modulePath) && !LAZY_JS_MODULES.has(modulePath));

  assert.deepEqual(missing, []);
  for (const modulePath of LAZY_JS_MODULES) {
    assert.equal(PRECACHED.has(modulePath), false, `${modulePath} should stay out of install-time precache`);
  }
});

test('service worker caches CDN dependencies only after first use', () => {
  const trackballUrl = `${THREE_ADDONS_URL}controls/TrackballControls.js/+esm`;
  assert.ok(CDN_DEPENDENCY_URLS.includes(THREE_MODULE_URL));
  assert.ok(CDN_DEPENDENCY_URLS.includes(trackballUrl));
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.equal(/cdnCache\.add\(/.test(sw), false);
  assert.equal(/INSTALL_PRECACHE_CDN_URLS/.test(sw), false);
});

test('service worker precaches local CSS and HTML templates', () => {
  const files = [
    ...walkFiles('css', filePath => filePath.endsWith('.css')),
    ...walkFiles('templates', filePath => filePath.endsWith('.html')),
  ].sort();
  const missing = files.filter((filePath) => !PRECACHED.has(filePath));

  assert.deepEqual(missing, []);
});

test('service worker install caps base data and only preloads declared sidecars', async () => {
  const previousSelf = globalThis.self;
  const previousCaches = globalThis.caches;
  const previousFetch = globalThis.fetch;
  const listeners = {};
  const added = { static: [], cdn: [], data: [] };
  const manifest = {
    series: [
      {
        slug: 'large_stack',
        slices: 40,
        hasRegions: true,
        hasSeg: true,
        hasSym: true,
        hasContext: true,
      },
      {
        slug: 'sidecar_stack',
        slices: 2,
        hasAnalysis: true,
        hasContext: true,
        hasAskHistory: true,
        hasStats: true,
      },
    ],
  };

  globalThis.self = {
    location: { href: 'http://localhost/', origin: 'http://localhost' },
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  globalThis.caches = {
    open: async (name) => ({
      addAll: async (urls) => { added.static.push(...urls); },
      add: async (url) => {
        if (name.includes('cdn')) added.cdn.push(url);
        else added.data.push(url);
      },
      put: async () => {},
      match: async () => null,
    }),
    keys: async () => [],
    delete: async () => true,
  };
  globalThis.fetch = async () => new Response(JSON.stringify(manifest), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  try {
    await import(`../sw.js?install-cap=${Date.now()}`);
    await new Promise((resolve, reject) => {
      listeners.install({
        waitUntil(promise) {
          promise.then(resolve, reject);
        },
      });
    });

    assert.ok(added.data.includes('./data/large_stack/0000.png'));
    assert.ok(added.data.includes('./data/large_stack/0031.png'));
    assert.equal(added.data.includes('./data/large_stack/0032.png'), false);
    assert.equal(added.data.some((url) => url.startsWith('./data/large_stack_regions/')), false);
    assert.equal(added.data.some((url) => url.startsWith('./data/large_stack_seg/')), false);
    assert.equal(added.data.some((url) => url.startsWith('./data/large_stack_sym/')), false);
    assert.ok(added.data.includes('./data/large_stack_regions.json'));
    assert.equal(added.data.includes('./data/large_stack_analysis.json'), false);
    assert.equal(added.data.includes('./data/large_stack_asks.json'), false);
    assert.equal(added.data.includes('./data/large_stack_stats.json'), false);
    assert.ok(added.data.includes('./data/sidecar_stack_analysis.json'));
    assert.ok(added.data.includes('./data/sidecar_stack_asks.json'));
    assert.ok(added.data.includes('./data/sidecar_stack_stats.json'));
    assert.deepEqual(added.cdn, []);
  } finally {
    globalThis.self = previousSelf;
    globalThis.caches = previousCaches;
    globalThis.fetch = previousFetch;
  }
});

test('service worker serves versioned app modules from cache before network', async () => {
  const previousSelf = globalThis.self;
  const previousCaches = globalThis.caches;
  const previousFetch = globalThis.fetch;
  const listeners = {};
  const cachedResponse = new Response('cached module', { status: 200 });
  let networkCalls = 0;

  globalThis.self = {
    location: { href: 'http://localhost/', origin: 'http://localhost' },
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  globalThis.caches = {
    open: async () => ({
      match: async () => cachedResponse.clone(),
      put: async () => {},
      add: async () => {},
      addAll: async () => {},
    }),
    keys: async () => [],
    delete: async () => true,
  };
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error('network should not gate cached modules');
  };

  try {
    await import(`../sw.js?cache-first=${Date.now()}`);
    const response = await new Promise((resolve, reject) => {
      listeners.fetch({
        request: new Request('http://localhost/js/bootstrap.js'),
        respondWith(promise) {
          promise.then(resolve, reject);
        },
      });
    });

    assert.equal(await response.text(), 'cached module');
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.self = previousSelf;
    globalThis.caches = previousCaches;
    globalThis.fetch = previousFetch;
  }
});
