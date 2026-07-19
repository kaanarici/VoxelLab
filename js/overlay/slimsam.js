// SlimSAM integration — manifest, embedding fetch, ONNX decoder, overlay.
// See slimsam-fetch.js, slimsam-inference.js, slimsam-overlay.js.

import {
  slimsamSetManifest,
  slimsamFetchMeta,
  slimsamFetchEmbeddings,
} from './slimsam-fetch.js';
import {
  slimsamEnsureDecoderSession,
  slimsamRunDecoder,
} from './slimsam-inference.js';

export { overlayMask } from './slimsam-overlay.js';

let _manifestRef = null;

export function initSlimSAM(manifest) {
  _manifestRef = manifest;
  slimsamSetManifest(manifest);
}

export async function isSlimSAMAvailable(seriesIdx) {
  const info = await getSlimSAMInfo(seriesIdx);
  return !!info.available;
}

export async function getSlimSAMInfo(seriesIdx) {
  const series = _manifestRef?.series?.[seriesIdx];
  if (!series) return { available: false, reason: 'no_series' };
  const meta = await slimsamFetchMeta(series.slug);
  if (!meta) return { available: false, reason: 'missing_embeddings', slug: series.slug };
  const validation = validateSlimSAMMeta(meta, series);
  if (!validation.valid) {
    return {
      available: false,
      reason: validation.reason,
      slug: series.slug,
      meta,
      expected: validation.expected,
    };
  }
  return { available: true, slug: series.slug, meta };
}

export async function runSlimSAMClick(x, y, sliceIdx, seriesIdx) {
  const series = _manifestRef?.series?.[seriesIdx];
  if (!series) return null;
  const slug = series.slug;

  const info = await getSlimSAMInfo(seriesIdx);
  if (!info.available) return null;
  const meta = info.meta;

  const embedBuf = await slimsamFetchEmbeddings(slug, meta);
  if (!embedBuf) return null;

  if (sliceIdx < 0 || sliceIdx >= meta.slices) return null;
  const floatsPerSlice = meta.embed_dim * meta.embed_h * meta.embed_w;
  const offset = sliceIdx * floatsPerSlice;
  let allZero = true;
  for (let i = offset; i < offset + floatsPerSlice; i++) {
    if (embedBuf[i] !== 0) { allZero = false; break; }
  }
  if (allZero) {
    console.warn(`[slimsam] slice ${sliceIdx} of ${slug} has no embedding (skipped during encode)`);
    return null;
  }

  const session = await slimsamEnsureDecoderSession();
  if (!session) return null;

  try {
    return await slimsamRunDecoder(session, embedBuf, meta, sliceIdx, x, y);
  } catch (e) {
    console.error('[slimsam] decoder inference failed:', e);
    return null;
  }
}

export function validateSlimSAMMeta(meta, series) {
  if (!meta || !series) return { valid: false, reason: 'missing_meta' };
  const expected = {
    width: Number(series.width || 0),
    height: Number(series.height || 0),
    slices: Number(series.slices || 0),
  };
  const actual = {
    width: Number(meta.width || 0),
    height: Number(meta.height || 0),
    slices: Number(meta.slices || 0),
  };
  const shapeOk = Number(meta.embed_dim) > 0 &&
    Number(meta.embed_h) > 0 &&
    Number(meta.embed_w) > 0 &&
    actual.width > 0 &&
    actual.height > 0 &&
    actual.slices > 0;
  if (!shapeOk) return { valid: false, reason: 'invalid_meta_shape', expected };
  if (expected.width && actual.width !== expected.width) return { valid: false, reason: 'geometry_mismatch', expected };
  if (expected.height && actual.height !== expected.height) return { valid: false, reason: 'geometry_mismatch', expected };
  if (expected.slices && actual.slices !== expected.slices) return { valid: false, reason: 'geometry_mismatch', expected };
  return { valid: true, reason: '' };
}
