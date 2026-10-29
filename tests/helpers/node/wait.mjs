export function nextTask() {
  return new Promise(resolve => setImmediate(resolve));
}

export async function waitFor(predicate, { timeout = 2000, interval = 5, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeout}ms waiting for ${message}`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

export function waitForValue(read, expected, options = {}) {
  return waitFor(
    () => Object.is(read(), expected),
    { message: `value to become ${String(expected)}`, ...options },
  );
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
