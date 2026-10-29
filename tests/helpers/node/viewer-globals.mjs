import { URL } from 'node:url';

export function memoryStorage(entries = []) {
  const store = new Map(entries);
  return {
    store,
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); },
    clear() { store.clear(); },
  };
}

export function failingStorage(reason = 'quota') {
  return {
    getItem() { return null; },
    setItem() { throw new Error(reason); },
    removeItem() {},
    clear() {},
  };
}

export function installViewerGlobals({
  origin = 'http://127.0.0.1/',
  document = { getElementById: () => null },
  storage = memoryStorage(),
  desktop = undefined,
} = {}) {
  const previous = {
    location: globalThis.location,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    self: globalThis.self,
    voxellabDesktop: globalThis.voxellabDesktop,
  };
  globalThis.location = new URL(origin);
  globalThis.document = document;
  globalThis.localStorage = storage;
  globalThis.self = globalThis;
  if (desktop !== undefined) globalThis.voxellabDesktop = desktop;
  return {
    storage,
    store: storage.store,
    document,
    restore() {
      globalThis.location = previous.location;
      globalThis.document = previous.document;
      globalThis.localStorage = previous.localStorage;
      globalThis.self = previous.self;
      globalThis.voxellabDesktop = previous.voxellabDesktop;
    },
  };
}

export function withGlobal(name, value) {
  const previous = globalThis[name];
  globalThis[name] = value;
  return () => { globalThis[name] = previous; };
}
