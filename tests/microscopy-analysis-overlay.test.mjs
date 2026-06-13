/* global URL */
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
  setThresholdOverlay, setParticleOverlay, clearAnalysisOverlay,
  analysisOverlayState, analysisOverlayStale, renderAnalysisOverlay,
} = await import('../js/microscopy/microscopy-analysis-overlay.js');

function fakeCtx() {
  let put = 0;
  return {
    putCount: () => put,
    getImageData: (_x, _y, gw, gh) => ({ data: new Uint8ClampedArray(gw * gh * 4) }),
    putImageData: () => { put++; },
  };
}

const micro = { imageDomain: 'microscopy', microscopy: { channelIndex: 0, timeIndex: 0 } };
const hostAt = (z) => ({ sliceIdx: z, manifest: { series: [micro] }, seriesIdx: 0 });

test('analysis overlay draws only on its captured C/Z/T plane', () => {
  clearAnalysisOverlay();
  setThresholdOverlay({ mask: new Uint8Array([1, 0, 0, 1]), width: 2, height: 2, c: 0, z: 3, t: 0 });

  assert.equal(analysisOverlayStale(analysisOverlayState(), hostAt(2), micro), true, 'stale on a different Z');
  const ctxWrong = fakeCtx();
  assert.equal(renderAnalysisOverlay(ctxWrong, hostAt(2), micro), false);
  assert.equal(ctxWrong.putCount(), 0, 'no draw off-plane');

  assert.equal(analysisOverlayStale(analysisOverlayState(), hostAt(3), micro), false, 'fresh on captured Z');
  const ctxRight = fakeCtx();
  assert.equal(renderAnalysisOverlay(ctxRight, hostAt(3), micro), true);
  assert.equal(ctxRight.putCount(), 1, 'threshold mask drawn on-plane');
});

test('non-microscopy series and cleared state are always stale', () => {
  setParticleOverlay({ labeledMask: new Uint32Array([1, 0, 0, 2]), width: 2, height: 2, c: 0, z: 0, t: 0 });
  assert.equal(analysisOverlayStale(analysisOverlayState(), hostAt(0), { imageDomain: 'dicom' }), true);
  assert.equal(renderAnalysisOverlay(fakeCtx(), hostAt(0), micro), true, 'labeled mask draws on its plane');
  clearAnalysisOverlay();
  assert.equal(renderAnalysisOverlay(fakeCtx(), hostAt(0), micro), false);
  assert.equal(analysisOverlayState(), null);
});
