import assert from 'node:assert/strict';
import { test } from 'node:test';
import { URL } from 'node:url';

globalThis.location = new URL('http://127.0.0.1/');

const links = [];
globalThis.document = {
  head: {
    appendChild(node) {
      links.push(node);
    },
  },
  createElement(tag) {
    assert.equal(tag, 'link');
    return {};
  },
};

const { applyCrossOriginPreloads, collectCrossOriginHosts } = await import('../js/preload-cross-origin.js');

test('collectCrossOriginHosts follows in-place hosted URL updates', () => {
  const manifest = {
    series: [{
      sliceUrlBase: 'https://r2.example/data/series-a/',
      rawUrl: 'https://files.example/series-a.raw.zst',
    }],
  };

  assert.deepEqual(collectCrossOriginHosts(manifest), [
    'https://r2.example',
    'https://files.example',
  ]);

  manifest.series[0].sliceUrlBase = 'https://replacement.example/data/series-a/';
  manifest.series[0].rawUrl = '';
  assert.deepEqual(collectCrossOriginHosts(manifest), ['https://replacement.example']);

  manifest.series[0] = { rawUrl: 'https://files.example/replaced.raw.zst' };
  assert.deepEqual(collectCrossOriginHosts(manifest), ['https://files.example']);

  manifest.series.push({ rawUrl: 'https://new.example/series-b.raw.zst' });
  assert.deepEqual(collectCrossOriginHosts(manifest), [
    'https://files.example',
    'https://new.example',
  ]);
});

test('applyCrossOriginPreloads skips proxy-asset image preloads that cannot carry local auth', () => {
  links.length = 0;
  applyCrossOriginPreloads({
    series: [{
      slug: 'cloud_preload',
      sliceUrlBase: 'https://r2.example/data/cloud_preload/',
      rawUrl: 'https://r2.example/cloud_preload.raw.zst',
    }],
  });

  assert.ok(links.find((link) => link.rel === 'preconnect' && link.href === 'https://r2.example'));
  assert.equal(links.find((link) => link.rel === 'preload'), undefined);
});
