// Global viewer state. App document + runtime buffers behind one proxy.
// App writes go through viewer-commands. Runtime caches use viewer-runtime
// setters. `_` roots and cmpStacks are raw maps; entry writes use
// setPassthroughRootEntry so subscribers still hear them.

import { createInitialAppModel } from './state/app-model.js';
import { createInitialRuntimeState } from './state/runtime-state.js';
import { RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE } from './viewer-session-shape.js';

const listeners = new Map();
const proxyCache = new WeakMap();
const proxyTargets = new WeakMap();
const pending = new Map();
const PASSTHROUGH_ROOT_KEYS = new Set(['cmpStacks']);

let batchDepth = 0;
let flushing = false;

const appRaw = createInitialAppModel();
const runtimeRaw = createInitialRuntimeState();
const appRootKeys = new Set(Object.keys(appRaw));
const runtimeRootKeys = new Set(Object.keys(runtimeRaw));
const duplicateRootKeys = [...appRootKeys].filter(key => runtimeRootKeys.has(key));
if (duplicateRootKeys.length) {
  throw new Error(`State roots must have one owner: ${duplicateRootKeys.join(', ')}`);
}

function rootSource(key) {
  return runtimeRootKeys.has(key) ? runtimeRaw : appRaw;
}

function createLinkedRaw() {
  const linked = {};
  const roots = new Set([
    ...Object.keys(appRaw),
    ...Object.keys(runtimeRaw),
  ]);
  for (const key of roots) {
    const source = rootSource(key);
    Object.defineProperty(linked, key, {
      configurable: true,
      enumerable: true,
      get: () => source[key],
      set: (value) => { source[key] = value; },
    });
  }
  return linked;
}

const raw = createLinkedRaw();

function isObject(value) {
  return value != null && Object(value) === value && !(value instanceof Function);
}

function isProxyable(value) {
  if (!isObject(value)) return false;
  return Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype;
}

function toPath(key) {
  if (Array.isArray(key)) return key.map(String);
  return String(key).split('.');
}

function resolvePath(path) {
  return { target: rootSource(path[0]), path };
}

function getAtPath(target, path) {
  if (target === raw) {
    const resolved = resolvePath(path);
    return getAtPath(resolved.target, resolved.path);
  }
  let cur = target;
  for (const part of path) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function unwrap(value) {
  return proxyTargets.get(value) || value;
}

function expandKeys(path) {
  const keys = new Set();
  for (let i = path.length; i > 0; i--) {
    keys.add(path.slice(0, i).join('.'));
  }
  return keys;
}

function markChanged(path) {
  pending.set(path.join('.'), path);
  if (batchDepth === 0) flush();
}

function flush() {
  if (flushing || batchDepth > 0) return;
  flushing = true;
  try {
    while (pending.size) {
      const changed = [...pending.values()];
      pending.clear();
      const notifyKeys = new Set();
      for (const path of changed) {
        for (const expanded of expandKeys(path)) notifyKeys.add(expanded);
      }
      for (const key of notifyKeys) {
        const subs = listeners.get(key);
        if (!subs || subs.size === 0) continue;
        const value = getAtPath(raw, toPath(key));
        for (const fn of [...subs]) {
          try {
            fn(value, key);
          } catch (err) {
            console.error(`[state:${key}]`, err);
          }
        }
      }
    }
  } finally {
    flushing = false;
  }
}

function createProxy(target, path = []) {
  if (!isProxyable(target)) return target;
  if (proxyCache.has(target)) return proxyCache.get(target);

  const proxy = new Proxy(target, {
    get(obj, key) {
      if (String(key) === key && path.length === 0 && (key.startsWith('_') || PASSTHROUGH_ROOT_KEYS.has(key))) {
        return obj[key];
      }
      return createProxy(obj[key], [...path, String(key)]);
    },
    set(obj, key, value) {
      const next = unwrap(value);
      if (Object.is(obj[key], next)) return true;
      obj[key] = next;
      markChanged([...path, String(key)]);
      return true;
    },
    deleteProperty(obj, key) {
      if (!(key in obj)) return true;
      delete obj[key];
      markChanged([...path, String(key)]);
      return true;
    },
  });

  proxyCache.set(target, proxy);
  proxyTargets.set(proxy, target);
  return proxy;
}

function cloneValue(value, seen = new WeakMap()) {
  if (!isObject(value)) return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (const item of value) out.push(cloneValue(item, seen));
    return out;
  }
  if (value instanceof Set) {
    const out = [];
    seen.set(value, out);
    for (const item of value) out.push(cloneValue(item, seen));
    return out;
  }
  if (value instanceof Map) {
    const out = {};
    seen.set(value, out);
    for (const [key, child] of value) out[String(key)] = cloneValue(child, seen);
    return out;
  }
  if (ArrayBuffer.isView(value)) return { type: value.constructor.name, length: value.length };
  if (value instanceof ArrayBuffer) return { type: 'ArrayBuffer', byteLength: value.byteLength };
  if (value instanceof Date) return value.toISOString();
  if (Object.getPrototypeOf(value) !== Object.prototype) return null;
  const out = {};
  seen.set(value, out);
  for (const [key, child] of Object.entries(value)) out[key] = cloneValue(child, seen);
  return out;
}

function buildSnapshot() {
  const snapshot = cloneValue(appRaw);
  snapshot.voxels = cloneValue(runtimeRaw.voxels);
  snapshot.voxelsKey = runtimeRaw.voxelsKey;
  snapshot.cmpStacks = cloneValue(runtimeRaw.cmpStacks);
  snapshot.viewerSession = cloneValue(runtimeRaw.viewerSession);
  for (const cache of Object.values(RUNTIME_OVERLAY_CACHE_KEYS_BY_TYPE)) {
    snapshot[cache.imgs] = cloneValue(runtimeRaw[cache.imgs]);
  }
  snapshot.hrVoxels = cloneValue(runtimeRaw.hrVoxels);
  snapshot.hrKey = runtimeRaw.hrKey;
  return snapshot;
}

function deepFreeze(value) {
  if (!isObject(value) || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export const state = createProxy(raw);

export function subscribe(key, fn) {
  const name = String(key);
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name)?.delete(fn);
}

export function batch(fn) {
  batchDepth++;
  const finish = () => {
    batchDepth = Math.max(0, batchDepth - 1);
    if (batchDepth === 0) flush();
  };
  try {
    const result = fn();
    if (result?.then instanceof Function) {
      return result.finally(finish);
    }
    finish();
    return result;
  } catch (err) {
    finish();
    throw err;
  }
}

export function setPassthroughRootEntry(rootKey, entryKey, value) {
  const bucket = rootSource(rootKey)[rootKey];
  if (!isObject(bucket)) return false;
  const next = unwrap(value);
  if (Object.is(bucket[entryKey], next)) return true;
  bucket[entryKey] = next;
  markChanged([String(rootKey), String(entryKey)]);
  return true;
}

export function deletePassthroughRootEntry(rootKey, entryKey) {
  const bucket = rootSource(rootKey)[rootKey];
  if (!isObject(bucket) || !(entryKey in bucket)) return true;
  delete bucket[entryKey];
  markChanged([String(rootKey), String(entryKey)]);
  return true;
}

export function getStateSnapshot() {
  return deepFreeze(buildSnapshot());
}
