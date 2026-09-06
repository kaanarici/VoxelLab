const params = new URLSearchParams(globalThis.location?.search || '');

export const PERF_MODE = (() => {
  const raw = params.get('perf');
  return raw === '1' || raw === 'true';
})();
