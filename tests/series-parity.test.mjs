import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';

globalThis.location = new URL('http://127.0.0.1/');

const {
  GEOMETRY_KIND_CAPABILITY,
  canUseMpr3D,
  geometryKindForSeries,
  reconstructionCapabilityForSeries,
} = await import('../js/series/series-capabilities.js');
const { applyPublicSeriesUrls } = await import('../js/series/series-contract.js');

const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

test('geometry kind fixture matches JS capability mapping', () => {
  const fixture = readJson('./fixtures/contract/geometry-kinds.json');
  const expectedMap = Object.fromEntries(fixture.cases.map(item => [item.kind, item.capability]));

  assert.deepEqual(GEOMETRY_KIND_CAPABILITY, expectedMap);
  for (const item of fixture.cases) {
    assert.equal(geometryKindForSeries(item.series), item.kind, item.kind);
    assert.equal(reconstructionCapabilityForSeries(item.series), item.capability, item.kind);
    assert.equal(item.series.renderability, item.renderability, item.kind);
    assert.equal(canUseMpr3D(item.series), item.canMpr3D, item.kind);
  }
});

test('public series URL fixture matches JS backfill implementation', () => {
  const fixture = readJson('./fixtures/contract/public-series-urls.json');

  for (const item of fixture.cases) {
    assert.deepEqual(applyPublicSeriesUrls(item.input, item.publicBase), item.expected, item.id);
  }
});
