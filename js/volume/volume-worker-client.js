// Main-thread bridge to js/volume-worker.js — fzstd decompress +
// uint16→float32 offloaded so the UI stays responsive on large volumes.

let _volumeWorker = null;
let _workerIdCounter = 0;
const _workerCallbacks = new Map();

function workerFailureError(event, fallback) {
  if (event instanceof Error) return event;
  const candidate = event?.message;
  const message = candidate != null && String(candidate) === candidate && candidate ? candidate : fallback;
  return new Error(message);
}

function settleWorkerFailure(worker, error) {
  // A worker failure invalidates every request sent to that worker. Clear the
  // map before settling callbacks so rejection handlers can safely submit work
  // to a freshly-created worker without being affected by this failure.
  if (_volumeWorker !== worker) return;
  _volumeWorker = null;
  const callbacks = [..._workerCallbacks.values()];
  _workerCallbacks.clear();
  try { worker.terminate?.(); } catch { /* The worker is already gone. */ }
  for (const cb of callbacks) {
    if (cb.reject) cb.reject(error);
    else cb.resolve?.(null);
  }
}

function getVolumeWorker() {
  if (!_volumeWorker) {
    _volumeWorker = new Worker('./js/volume/volume-worker.js', { type: 'module' });
    const worker = _volumeWorker;
    _volumeWorker.onmessage = (e) => {
      const { id } = e.data;
      const cb = _workerCallbacks.get(id);
      if (!cb) return;
      if (e.data.type === 'progress') {
        cb.onProgress?.(e.data.stage, e.data.detail);
        return;
      }
      _workerCallbacks.delete(id);
      if (e.data.type === 'result') {
        const expected = Math.floor(Number(cb.expectedVoxels || 0));
        if (expected > 0 && e.data.f32?.length !== expected) cb.resolve(null);
        else cb.resolve(e.data.f32);
      }
      else if (e.data.type === 'flatten-result') cb.resolve(e.data.bytes);
      else if (e.data.type === 'dicom-result') cb.resolve(e.data.payload || null);
      else if (e.data.type === 'error') cb.reject?.(new Error(e.data.error)) || cb.resolve(null);
      else cb.resolve(null);
    };
    _volumeWorker.onerror = (event) => {
      event?.preventDefault?.();
      settleWorkerFailure(worker, workerFailureError(event, 'Volume worker failed'));
    };
    _volumeWorker.onmessageerror = (event) => {
      event?.preventDefault?.();
      settleWorkerFailure(worker, workerFailureError(event, 'Volume worker message failed'));
    };
  }
  return _volumeWorker;
}

/**
 * Stop the shared worker and settle every request it owns. This is the only
 * supported termination path so callers never leave promises pending.
 */
export function terminateVolumeWorker() {
  if (!_volumeWorker) return;
  settleWorkerFailure(_volumeWorker, new Error('Volume worker terminated'));
}

function postVolumeWorkerMessage(id, message, transfer, onError) {
  try {
    const worker = getVolumeWorker();
    if (transfer === undefined) worker.postMessage(message);
    else worker.postMessage(message, transfer);
  } catch (err) {
    _workerCallbacks.delete(id);
    onError(err);
  }
}

/**
 * Flatten slice ImageBitmaps into one Uint8Array (length === w * h * d) off the
 * main thread. Caller is responsible for
 * `createImageBitmap(<img>)` on the main thread; ownership of the bitmaps
 * is transferred to the worker. Throws if the worker is unavailable.
 *
 * @param {{ bitmaps: ImageBitmap[], w: number, h: number, d: number }} opts
 * @returns {Promise<Uint8Array>}
 */
export function flattenImageBitmapsInWorker({ bitmaps, w, h, d }) {
  if (!(globalThis.Worker instanceof Function) || !(globalThis.OffscreenCanvas instanceof Function)) {
    return Promise.reject(new Error('flattenImageBitmapsInWorker: Worker/OffscreenCanvas unavailable'));
  }
  if (!Array.isArray(bitmaps) || bitmaps.length !== d) {
    return Promise.reject(new Error('flattenImageBitmapsInWorker: bitmap count mismatch'));
  }
  return new Promise((resolve, reject) => {
    const id = ++_workerIdCounter;
    _workerCallbacks.set(id, {
      resolve: (bytes) => bytes ? resolve(bytes) : reject(new Error('flatten failed')),
      reject,
    });
    postVolumeWorkerMessage(id,
      { type: 'flatten-image-bitmaps', id, bitmaps, w, h, d },
      bitmaps,
      reject,
    );
  });
}

export function runVolumeWorker(buffer, compressed, expectedVoxels) {
  return new Promise((resolve) => {
    const id = ++_workerIdCounter;
    _workerCallbacks.set(id, { resolve, expectedVoxels });
    postVolumeWorkerMessage(id,
      { type: 'decompress', id, buffer, compressed, expectedVoxels },
      [buffer],
      () => resolve(null),
    );
  });
}

function requestDicomFilesFromWorker(type, files, onProgress) {
  return new Promise((resolve) => {
    const id = ++_workerIdCounter;
    _workerCallbacks.set(id, { resolve, onProgress });
    postVolumeWorkerMessage(
      id,
      { type, id, files },
      undefined,
      () => resolve(null),
    );
  });
}

export function scanDicomFilesInWorker(files, onProgress = () => {}) {
  return requestDicomFilesFromWorker('scan-dicom-files', files, onProgress);
}

export function parseDicomFilesInWorker(files, onProgress = () => {}) {
  return requestDicomFilesFromWorker('parse-dicom-files', files, onProgress);
}
