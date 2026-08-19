import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

const storage = new Map();
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
};

const {
  forgetPreferredOverlay,
  getPreferredOverlays,
  migratePreferredOverlayKinds,
  rememberPreferredOverlay,
  setPreferredOverlays,
} = await import('../js/overlay/overlay-preferences.js');

test('migratePreferredOverlayKinds maps loader aliases once', () => {
  assert.deepEqual(migratePreferredOverlayKinds(['seg', 'regions', 'heatmap']), {
    kinds: ['tissue', 'labels', 'heatmap'],
    changed: true,
  });
  assert.deepEqual(migratePreferredOverlayKinds(['tissue', 'labels']), {
    kinds: ['tissue', 'labels'],
    changed: false,
  });
});

test('getPreferredOverlays migrates saved loader keys then persists canonical kinds', () => {
  storage.clear();
  storage.set('voxellab.overlay.preferred.CT', JSON.stringify(['seg', 'sym']));

  assert.deepEqual(getPreferredOverlays('CT'), ['tissue', 'heatmap']);
  assert.equal(storage.get('voxellab.overlay.preferred.CT'), JSON.stringify(['tissue', 'heatmap']));
  assert.deepEqual(getPreferredOverlays('CT'), ['tissue', 'heatmap']);
});

test('live preferred-overlay writes accept persist kinds only', () => {
  storage.clear();
  setPreferredOverlays('MR', ['seg', 'labels', 'heatmap']);
  assert.deepEqual(getPreferredOverlays('MR'), ['labels', 'heatmap']);

  rememberPreferredOverlay('MR', 'seg');
  rememberPreferredOverlay('MR', 'tissue');
  assert.deepEqual(getPreferredOverlays('MR'), ['labels', 'heatmap', 'tissue']);

  forgetPreferredOverlay('MR', 'regions');
  forgetPreferredOverlay('MR', 'labels');
  assert.deepEqual(getPreferredOverlays('MR'), ['heatmap', 'tissue']);
});
