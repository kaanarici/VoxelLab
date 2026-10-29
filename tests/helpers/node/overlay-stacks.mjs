export function cachedOverlayStack(dir, slices, { onPrefetch = () => {} } = {}) {
  const stack = new Array(slices);
  stack._dir = dir;
  stack.ensureIndex = () => Promise.resolve(true);
  stack.ensureWindow = () => {};
  stack.prefetchRemaining = (center, radius, opts) => {
    onPrefetch({ center, radius, opts });
    return Promise.resolve();
  };
  return stack;
}

export function forbidImageAllocation(t, message) {
  const previous = globalThis.Image;
  globalThis.Image = class {
    constructor() {
      throw new Error(message);
    }
  };
  t.after(() => { globalThis.Image = previous; });
}
