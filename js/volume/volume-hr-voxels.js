// 16-bit raw volume fetch, optional zstd decompress, Cache API, worker path.
// Invokes MPR redraw + 3D rebuild via callbacks registered in initHrVoxelsLoading.

import { $ } from '../dom.js';
import { FZSTD_ESM_URL, VOLUME_CACHE_NAME } from '../core/dependencies.js';
import { state } from '../core/state.js';
import { softFail } from '../core/error.js';
import { loadConfig, localApiHeaders } from '../config.js';
import { rawVolumeUrlForSeries } from '../series/series-image-stack.js';
import {
  cleanupStaleCaches,
  MAX_VOLUME_CACHE_ENTRIES,
  trimCacheEntries,
} from '../core/cached-fetch.js';
import {
  clearHrLoadingState,
  setHrLoadingState,
  setHrVoxelCache,
} from '../runtime/viewer-runtime.js';
import { syncViewerRuntimeSession } from '../runtime/viewer-session.js';
import { clearLocalRawVolume, touchLocalRawVolume } from '../local-raw-volume-cache.js';
import {
  createRawVolumePayloadError,
  isRawVolumePayloadError,
  normalizeUint16RawVolume,
  rawVolumeResourceBudget,
} from './volume-raw-normalize.js';
import { decodeZstdRawVolume } from './volume-zstd-decode.js';
import { runVolumeWorker } from './volume-worker-client.js';

const cleanupOldVolumeCaches = () => cleanupStaleCaches(
  'voxellab-volumes-',
  VOLUME_CACHE_NAME,
  ['mri-volumes-v1'],
);
// Fire-and-forget at module load: cleanup runs once, never blocks a fetch.
if (typeof self !== 'undefined' && 'caches' in self) cleanupOldVolumeCaches();

async function proxyFetchInit(url, signal) {
  try {
    if (new URL(url, globalThis.location?.href || 'http://localhost/').pathname === '/api/proxy-asset') {
      await loadConfig();
      return { signal, headers: localApiHeaders() };
    }
  } catch {
    // Fall through to a plain fetch init.
  }
  return { signal };
}

const callbacks = {
  is3dActive: () => false,
  isMprActive: () => false,
  drawMPR: () => {},
  rebuildVolume: async () => {},
};

export function initHrVoxelsLoading(deps) {
  callbacks.is3dActive = deps.is3dActive;
  callbacks.isMprActive = deps.isMprActive;
  callbacks.drawMPR = deps.drawMPR;
  callbacks.rebuildVolume = deps.rebuildVolume;
}

function showVolumeLoading(series, kind, key) {
  const el = $('viewer-status');
  if (!el) return;
  const label = kind === 'compressed' ? 'Streaming volume' : 'Loading volume';
  el.dataset.loadingKey = key;
  el.textContent = `${label} · ${series.name || series.slug} …`;
  el.hidden = false;
}

function hideVolumeLoading(key = '') {
  const el = $('viewer-status');
  if (!el) return;
  if (key && el.dataset.loadingKey !== key) return;
  el.hidden = true;
  delete el.dataset.loadingKey;
}

async function normalizeRawVolumeBuffer(buf, compressed, expected) {
  let buffer = buf;
  if (compressed) {
    const { Decompress } = await import(FZSTD_ESM_URL);
    buffer = decodeZstdRawVolume(buffer, expected, Decompress);
  }
  return normalizeUint16RawVolume(buffer, expected);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('raw volume request aborted');
  error.name = 'AbortError';
  throw error;
}

async function readBoundedResponseBuffer(response, maxBytes, signal) {
  const contentLength = Number(response?.headers?.get?.('content-length'));
  if (Number.isSafeInteger(contentLength) && contentLength > maxBytes) {
    throw createRawVolumePayloadError(`Content-Length ${contentLength} exceeds the ${maxBytes} byte encoded limit`);
  }
  throwIfAborted(signal);
  if (!response?.body || typeof response.body.getReader !== 'function') {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw createRawVolumePayloadError(`encoded payload exceeds the ${maxBytes} byte limit`);
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const parts = [];
  let length = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (bytes.byteLength > maxBytes - length) {
        await reader.cancel().catch(() => {});
        throw createRawVolumePayloadError(`encoded payload exceeds the ${maxBytes} byte limit while streaming`);
      }
      parts.push(bytes);
      length += bytes.byteLength;
    }
  } finally {
    reader.releaseLock?.();
  }

  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output.buffer;
}

/**
 * Loads (and caches) the 16-bit raw volume for the current series,
 * normalized to a Float32Array in the [0, 1] range. Shared by 3D
 * renderer + MPR reslicer.
 *
 * Returns Promise<Float32Array | null>. Null = no data available.
 */
export async function ensureHRVoxels() {
  const series = state.manifest.series[state.seriesIdx];
  if (!series.hasRaw && !series.rawUrl) return null;
  let budget;
  try {
    budget = rawVolumeResourceBudget(series.width, series.height, series.slices);
  } catch (error) {
    console.warn(`raw volume rejected for ${series.slug}:`, error);
    return null;
  }
  const expected = budget.expectedVoxels;
  const key = `${state.seriesIdx}:${series.slug}:${series.rawUrl || ''}`;
  if (state.hrKey === key && state.hrVoxels) return state.hrVoxels;

  // Local imports: use the in-memory Float32 volume directly (no fetch needed).
  const localRaw = state._localRawVolumes?.[series.slug];
  if (localRaw) {
    if (!(localRaw instanceof Float32Array) || localRaw.length !== expected) {
      clearLocalRawVolume(series.slug);
    } else {
      touchLocalRawVolume(series.slug);
      setHrVoxelCache(localRaw, key);
      syncViewerRuntimeSession(series);
      if (callbacks.isMprActive()) callbacks.drawMPR();
      if (callbacks.is3dActive()) await callbacks.rebuildVolume();
      return localRaw;
    }
  }

  if (state.hrLoading && state.hrLoadingKey === key) return state.hrLoading;
  if (state.hrAbortController && state.hrLoadingKey && state.hrLoadingKey !== key) {
    state.hrAbortController.abort();
  }

  const controller = new AbortController();
  setHrLoadingState({ key, controller });
  const promise = (async () => {
    let cache = null;
    let cachedEntry = false;
    let url = '';
    try {
      // Local-first: a bundled uncompressed .raw (hasRaw) is the source of truth.
      // The compressed rawUrl (e.g. R2) is only for deploys that don't ship the
      // volume — series-contract auto-derives it from hasRaw, so it's set even on
      // local series; preferring it would force a needless CDN round-trip that
      // breaks offline. hasRaw means the file is here, so use it.
      const useCompressed = !series.hasRaw && Boolean(series.rawUrl);
      url = useCompressed ? rawVolumeUrlForSeries(series) : `./data/${series.slug}.raw`;
      const signal = controller.signal;
      const maxEncodedBytes = useCompressed ? budget.maxEncodedBytes : budget.decodedBytes;

      showVolumeLoading(series, useCompressed ? 'compressed' : 'raw', key);

      let buf;
      let cacheBuffer = null;
      cache = useCompressed && typeof self !== 'undefined' && 'caches' in self
        ? await softFail(caches.open(VOLUME_CACHE_NAME), 'high-res volume cache')
        : null;
      if (cache) {
        await trimCacheEntries(cache, MAX_VOLUME_CACHE_ENTRIES, url);
        const cached = await cache.match(url);
        if (cached) {
          cachedEntry = true;
          buf = await readBoundedResponseBuffer(cached, maxEncodedBytes, signal);
        } else {
          const r = await fetch(url, await proxyFetchInit(url, signal));
          if (!r.ok) { hideVolumeLoading(key); return null; }
          buf = await readBoundedResponseBuffer(r, maxEncodedBytes, signal);
          cacheBuffer = buf.slice(0);
        }
      } else {
        const r = await fetch(url, await proxyFetchInit(url, signal));
        if (!r.ok) { hideVolumeLoading(key); return null; }
        buf = await readBoundedResponseBuffer(r, maxEncodedBytes, signal);
      }
      if (state.hrLoadingKey !== key) {
        hideVolumeLoading(key);
        return null;
      }

      let f32;
      const fallbackBuffer = typeof Worker !== 'undefined'
        ? (cacheBuffer || buf.slice(0))
        : buf;
      if (typeof Worker !== 'undefined') {
        f32 = await runVolumeWorker(buf, useCompressed, expected);
      }
      if (!f32) f32 = await normalizeRawVolumeBuffer(fallbackBuffer, useCompressed, expected);
      if (!f32) throw new Error('raw volume decode failed');
      if (state.hrLoadingKey !== key) {
        hideVolumeLoading(key);
        return null;
      }
      if (cache && cacheBuffer) {
        await softFail(cache.put(url, new Response(cacheBuffer, {
          headers: { 'Content-Type': 'application/zstd' },
        })), 'high-res volume cache write');
        await trimCacheEntries(cache, MAX_VOLUME_CACHE_ENTRIES, url);
      }
      setHrVoxelCache(f32, key);
      syncViewerRuntimeSession(series);
      hideVolumeLoading(key);
      if (callbacks.isMprActive()) callbacks.drawMPR();
      if (callbacks.is3dActive()) await callbacks.rebuildVolume();
      return f32;
    } catch (e) {
      if (cachedEntry && isRawVolumePayloadError(e) && cache && typeof cache.delete === 'function') {
        await softFail(cache.delete(url), 'invalid high-res volume cache entry');
      }
      if (e?.name !== 'AbortError') {
        console.warn(`raw volume fetch failed for ${series.slug}:`, e);
      }
      hideVolumeLoading(key);
      return null;
    } finally {
      clearHrLoadingState(key);
    }
  })();
  setHrLoadingState({ key, controller, promise });
  return promise;
}
