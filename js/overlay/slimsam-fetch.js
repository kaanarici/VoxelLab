// SAM embedding + metadata fetch for the SlimSAM browser tool.

import { FZSTD_ESM_URL } from '../core/dependencies.js';
import { cachedFetchJson, cachedFetchResponse } from '../core/cached-fetch.js';
import { assetUrlForBrowser } from '../series/series-image-stack.js';

let _manifest = null;
let _r2Base = null;
let _metaCache = new Map();
let _embedCache = new Map();

export function slimsamSetManifest(manifest) {
  if (manifest !== _manifest) slimsamClearCaches();
  _manifest = manifest;
  _r2Base = null;
}

export function slimsamClearCaches() {
  _metaCache = new Map();
  _embedCache = new Map();
}

function _inferR2Base() {
  if (_r2Base) return _r2Base;
  if (!_manifest) return null;
  for (const s of _manifest.series || []) {
    if (s.rawUrl) {
      const idx = s.rawUrl.lastIndexOf('/');
      if (idx > 0) {
        _r2Base = s.rawUrl.slice(0, idx);
        return _r2Base;
      }
    }
  }
  return null;
}

export async function slimsamFetchMeta(slug) {
  if (_metaCache.has(slug)) return _metaCache.get(slug);

  const localUrl = `./data/${slug}_sam_meta.json`;
  try {
    const meta = await cachedFetchJson(localUrl);
    if (meta) {
      _metaCache.set(slug, meta);
      return meta;
    }
  } catch { /* fall through */ }

  const base = _inferR2Base();
  if (base) {
    try {
      const meta = await cachedFetchJson(sidecarUrl(base, `${slug}_sam_meta.json`));
      if (meta) {
        _metaCache.set(slug, meta);
        return meta;
      }
    } catch { /* fall through */ }
  }

  _metaCache.set(slug, null);
  return null;
}

export async function slimsamFetchEmbeddings(slug, meta) {
  if (_embedCache.has(slug)) return _embedCache.get(slug);

  const totalFloats = meta.slices * meta.embed_dim * meta.embed_h * meta.embed_w;
  const base = _inferR2Base();

  try {
    const local = await cachedFetchResponse(`./data/${slug}_sam_embed.bin`);
    if (local.ok) {
      return slimsamProcessEmbedResponse(slug, local, false, totalFloats);
    }
  } catch { /* fall through */ }

  if (base) {
    try {
      const compressed = await cachedFetchResponse(sidecarUrl(base, `${slug}_sam_embed.bin.zst`), { priority: 'high' });
      if (compressed.ok) {
        return slimsamProcessEmbedResponse(slug, compressed, true, totalFloats);
      }
      const fallback = await cachedFetchResponse(sidecarUrl(base, `${slug}_sam_embed.bin`), { priority: 'high' });
      if (fallback.ok) {
        return slimsamProcessEmbedResponse(slug, fallback, false, totalFloats);
      }
    } catch (e) {
      console.error(`[slimsam] fetch embeddings for ${slug} failed:`, e);
    }
  }

  _embedCache.set(slug, null);
  return null;
}

function sidecarUrl(base, filename) {
  return assetUrlForBrowser(`${base}/${filename}`);
}

async function slimsamProcessEmbedResponse(slug, response, compressed, totalFloats) {
  let buf = await response.arrayBuffer();

  if (compressed) {
    const { decompress } = await import(FZSTD_ESM_URL);
    const decompressed = decompress(new Uint8Array(buf));
    buf = decompressed.buffer.slice(
      decompressed.byteOffset,
      decompressed.byteOffset + decompressed.byteLength,
    );
  }

  const f16 = new Uint16Array(buf);
  if (f16.length !== totalFloats) {
    console.warn(
      `[slimsam] embedding size mismatch for ${slug}: ` +
      `got ${f16.length}, expected ${totalFloats}`
    );
    _embedCache.set(slug, null);
    return null;
  }

  const f32 = new Float32Array(totalFloats);
  for (let i = 0; i < totalFloats; i++) {
    f32[i] = float16ToFloat32(f16[i]);
  }

  _embedCache.set(slug, f32);
  return f32;
}

function float16ToFloat32(h) {
  const sign = (h >> 15) & 1;
  const exp  = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;

  if (exp === 0) {
    if (frac === 0) return sign ? -0 : 0;
    return (sign ? -1 : 1) * Math.pow(2, -14) * (frac / 1024);
  }
  if (exp === 0x1f) {
    return frac ? NaN : (sign ? -Infinity : Infinity);
  }
  return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
}
