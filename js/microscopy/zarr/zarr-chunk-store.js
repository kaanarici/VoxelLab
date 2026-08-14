import {
  MAX_OME_ZARR_DECODED_CHUNK_BYTES,
  MAX_OME_ZARR_ENCODED_CHUNK_BYTES,
  readBoundedOmeZarrByteStream,
} from './zarr-resource-budget.js';
import { parseZarrArrayMeta, zarrChunkPath } from './zarr-array-meta.js';

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_CACHE_LIMIT = 256;

class ZarrChunkStoreError extends Error {
  constructor(name, message) {
    super(message);
    this.name = name;
  }
}

function abortError() {
  return new ZarrChunkStoreError('AbortError', 'Remote Zarr store request aborted.');
}

function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function cacheLimitValue(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeRelPath(value) {
  return String(value || '')
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function joinUrl(baseUrl, relPath) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const rel = normalizeRelPath(relPath);
  return rel ? `${base}/${rel}` : base;
}

function okResponse(response) {
  const status = Number(response?.status || 0);
  return response?.ok ?? (status >= 200 && status < 300);
}

function cOrderStrides(shape) {
  const strides = new Array(shape.length);
  let stride = 1;
  for (let i = shape.length - 1; i >= 0; i -= 1) {
    strides[i] = stride;
    stride *= shape[i];
  }
  return strides;
}

function product(values) {
  let total = 1;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value <= 0 || total > Number.MAX_SAFE_INTEGER / value) return 0;
    total *= value;
  }
  return total;
}

function bytesView(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new ZarrChunkStoreError('ZarrChunkDecodeError', 'Zarr chunk decode returned non-byte data.');
}

function parseArrayMeta(arrayMeta = {}, rawChunkCoords = []) {
  let parsed;
  try {
    parsed = parseZarrArrayMeta(arrayMeta, { context: 'Remote Zarr store' });
  } catch (error) {
    throw new ZarrChunkStoreError('ZarrArrayMetadataError', error.message);
  }
  const { shape, chunks, dtype } = parsed;

  const chunkCoords = Array.isArray(rawChunkCoords)
    ? rawChunkCoords.map((item) => Number(item))
    : [];
  if (chunkCoords.length !== shape.length || chunkCoords.some((item) => !Number.isInteger(item) || item < 0)) {
    throw new ZarrChunkStoreError('ZarrChunkCoordinateError', 'Zarr chunk coordinates must match the array rank.');
  }
  if (chunkCoords.some((coord, axis) => coord * chunks[axis] >= shape[axis])) {
    throw new ZarrChunkStoreError('ZarrChunkCoordinateError', 'Zarr chunk coordinates are outside the array shape.');
  }

  return { ...parsed, shape, chunks, chunkCoords, dtype };
}

function chunkRelPath(arrayPath, chunkCoords, parsed) {
  return normalizeRelPath(zarrChunkPath(arrayPath, parsed, chunkCoords));
}

function getCached(cache, key) {
  if (!cache.has(key)) return null;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function setCached(cache, key, value, limit) {
  if (limit <= 0) return;
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    cache.delete(cache.keys().next().value);
  }
}

function responseStatus(response) {
  return Number(response?.status || 0);
}

function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  return headers?.[name] ?? headers?.[name.toLowerCase()] ?? '';
}

function encodedChunkError(message) {
  return new ZarrChunkStoreError('ZarrChunkEncodedLengthError', message);
}

async function responseBytes(response, maxBytes) {
  const contentLength = Number(headerValue(response?.headers, 'content-length'));
  if (Number.isSafeInteger(contentLength) && contentLength > maxBytes) {
    throw encodedChunkError(`Encoded Zarr chunk exceeds the ${maxBytes} byte budget (Content-Length: ${contentLength}).`);
  }
  if (response?.body && typeof response.body.getReader === 'function') {
    return readBoundedOmeZarrByteStream(response.body, {
      maxBytes,
      createLimitError: encodedChunkError,
    });
  }
  if (typeof response.arrayBuffer !== 'function') {
    throw new ZarrChunkStoreError('ZarrStoreFetchError', 'Zarr chunk response does not expose arrayBuffer().');
  }
  const bytes = bytesView(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw encodedChunkError(`Encoded Zarr chunk exceeds the ${maxBytes} byte budget.`);
  }
  return bytes;
}

async function responseJson(response) {
  if (typeof response.json === 'function') return response.json();
  if (typeof response.text !== 'function') {
    throw new ZarrChunkStoreError('ZarrStoreFetchError', 'Zarr metadata response does not expose json() or text().');
  }
  return JSON.parse(await response.text());
}

export function createRemoteZarrStore({
  baseUrl,
  fetchImpl,
  decode,
  concurrency = DEFAULT_CONCURRENCY,
  cacheLimit = DEFAULT_CACHE_LIMIT,
  maxDecodedChunkBytes = MAX_OME_ZARR_DECODED_CHUNK_BYTES,
  maxEncodedChunkBytes = MAX_OME_ZARR_ENCODED_CHUNK_BYTES,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new ZarrChunkStoreError('ZarrStoreConfigError', 'createRemoteZarrStore requires fetchImpl.');
  }
  if (typeof decode !== 'function') {
    throw new ZarrChunkStoreError('ZarrStoreConfigError', 'createRemoteZarrStore requires decode.');
  }

  const maxActive = positiveInteger(concurrency, DEFAULT_CONCURRENCY);
  const maxCache = cacheLimitValue(cacheLimit);
  const maxDecodedBytes = Math.min(positiveInteger(maxDecodedChunkBytes, MAX_OME_ZARR_DECODED_CHUNK_BYTES), MAX_OME_ZARR_DECODED_CHUNK_BYTES);
  const maxEncodedBytes = Math.min(positiveInteger(maxEncodedChunkBytes, MAX_OME_ZARR_ENCODED_CHUNK_BYTES), MAX_OME_ZARR_ENCODED_CHUNK_BYTES);
  const controller = new AbortController();
  const cache = new Map();
  const inFlight = new Map();
  const queue = [];
  let active = 0;
  let aborted = false;

  function throwIfAborted() {
    if (aborted || controller.signal.aborted) throw abortError();
  }

  function rejectQueued() {
    while (queue.length) {
      queue.shift().reject(abortError());
    }
  }

  function runWithAbort(promise) {
    const source = Promise.resolve(promise);
    // When abort wins the race, the underlying fetch/decode settles afterward with
    // no other consumer; register a no-op handler so it never becomes unhandled.
    source.catch(() => {});
    if (aborted || controller.signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError());
      controller.signal.addEventListener('abort', onAbort, { once: true });
      source.then((value) => {
        controller.signal.removeEventListener('abort', onAbort);
        resolve(value);
      }, (error) => {
        controller.signal.removeEventListener('abort', onAbort);
        reject(error);
      });
    });
  }

  function pump() {
    while (!aborted && active < maxActive && queue.length) {
      const item = queue.shift();
      active += 1;
      Promise.resolve()
        .then(() => {
          throwIfAborted();
          return runWithAbort(item.task(controller.signal));
        })
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  function schedule(task) {
    if (aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
  }

  async function fetchResponse(url, signal) {
    const response = await fetchImpl(url, { signal });
    throwIfAborted();
    if (!response || typeof response !== 'object') {
      throw new ZarrChunkStoreError('ZarrStoreFetchError', `Zarr fetch returned an invalid response for ${url}.`);
    }
    return response;
  }

  async function readJson(relPath) {
    const url = joinUrl(baseUrl, relPath);
    return schedule(async (signal) => {
      const response = await fetchResponse(url, signal);
      if (responseStatus(response) === 404) return null;
      if (!okResponse(response)) {
        throw new ZarrChunkStoreError('ZarrStoreFetchError', `Zarr metadata fetch failed (${responseStatus(response) || 'unknown'}): ${url}`);
      }
      return responseJson(response);
    });
  }

  async function readChunk(arrayPath, rawChunkCoords, arrayMeta = {}) {
    const parsed = parseArrayMeta(arrayMeta, rawChunkCoords);
    const { chunks, chunkCoords, dtype } = parsed;
    const storedChunkShape = chunks;
    const expectedBytes = product(storedChunkShape) * dtype.bytes;
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > maxDecodedBytes) {
      return Promise.reject(new ZarrChunkStoreError(
        'ZarrChunkLengthError',
        `Decoded Zarr chunk exceeds the ${maxDecodedBytes} byte budget for ${chunkRelPath(arrayPath, chunkCoords, parsed)}.`,
      ));
    }
    const relPath = chunkRelPath(arrayPath, chunkCoords, parsed);
    const key = relPath;
    const cached = getCached(cache, key);
    if (cached) return cached;
    if (inFlight.has(key)) return inFlight.get(key);

    const promise = schedule(async (signal) => {
      const url = joinUrl(baseUrl, relPath);
      const response = await fetchResponse(url, signal);
      if (responseStatus(response) === 404) {
        if (!parsed.hasFillValue) {
          throw new ZarrChunkStoreError('ZarrChunkNotFoundError', `Zarr chunk is missing and the array has no concrete fill_value: ${url}`);
        }
        const entry = { shape: storedChunkShape, strides: cOrderStrides(storedChunkShape), view: null, fillValue: parsed.fillValue };
        setCached(cache, key, entry, maxCache);
        return entry;
      }
      if (!okResponse(response)) {
        const status = responseStatus(response);
        const name = status === 404 ? 'ZarrChunkNotFoundError' : 'ZarrStoreFetchError';
        throw new ZarrChunkStoreError(name, `Zarr chunk fetch failed (${status || 'unknown'}): ${url}`);
      }
      const bytes = await responseBytes(response, maxEncodedBytes);
      throwIfAborted();
      const decoded = bytesView(await decode(bytes, {
        compressor: parsed.compressor,
        filters: parsed.filters,
        dtype: { bytes: dtype.bytes },
        expectedBytes,
      }));
      throwIfAborted();
      if (decoded.byteLength !== expectedBytes) {
        throw new ZarrChunkStoreError(
          'ZarrChunkLengthError',
          `Decoded Zarr chunk byte length mismatch for ${relPath}: expected ${expectedBytes}, got ${decoded.byteLength}.`,
        );
      }

      const entry = {
        shape: storedChunkShape,
        strides: cOrderStrides(storedChunkShape),
        view: new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength),
      };
      setCached(cache, key, entry, maxCache);
      return entry;
    });

    inFlight.set(key, promise);
    promise.then(() => {
      inFlight.delete(key);
    }, () => {
      inFlight.delete(key);
    });
    return promise;
  }

  function abort() {
    if (aborted) return;
    aborted = true;
    controller.abort();
    rejectQueued();
  }

  return { readJson, readChunk, abort };
}
