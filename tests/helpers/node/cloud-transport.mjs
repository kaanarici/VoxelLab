import { URL } from 'node:url';

export const CLOUD_OPTIONS = {
  trustedUploadOrigins: ['https://upload.example'],
};

export const VALID_SERIES_ENTRY = {
  slug: 'cloud_job123',
  name: 'Cloud CT',
  description: '2 slices',
  slices: 2,
  width: 4,
  height: 4,
  pixelSpacing: [1, 1],
  sliceThickness: 1,
  hasRaw: true,
};

export function freshCloudModule() {
  return import(new URL(`../../../js/cloud.js?t=${Date.now()}-${Math.random()}`, import.meta.url).href);
}

export function sharedConfigModule() {
  return import(new URL('../../../js/config.js', import.meta.url).href);
}

export function installCloudTransport(t, handler, { immediateTimers = true } = {}) {
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  const calls = [];

  t.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
  });

  if (immediateTimers) {
    globalThis.setTimeout = (fn) => {
      fn();
      return 0;
    };
  }

  globalThis.fetch = async (url, options = {}) => {
    const call = {
      url: String(url),
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
    };
    calls.push(call);
    return handler(call, options);
  };

  return {
    calls,
    endingWith(suffix) { return calls.find(call => call.url.endsWith(suffix)); },
    startingWith(prefix) { return calls.filter(call => call.url.startsWith(prefix)); },
    jsonBody(suffix) {
      const call = calls.find(item => item.url.endsWith(suffix));
      return call?.body ? JSON.parse(call.body) : null;
    },
  };
}

export function cloudUploadRoutes({
  uploadUrlFor = item => `https://upload.example/${item.filename}`,
  onPresign = () => {},
  startProcessing = () => Response.json({ status: 'started' }),
  checkStatus = () => Response.json({ status: 'complete', slug: 'cloud_job123' }),
  results = null,
  fallback = null,
} = {}) {
  return (call, options) => {
    if (call.url.endsWith('/get_upload_urls')) {
      const body = JSON.parse(call.body);
      onPresign(body);
      return Response.json({
        urls: Object.fromEntries(body.items.map(item => [item.upload_id, uploadUrlFor(item)])),
      });
    }
    if (call.url.startsWith('https://upload.example/')) return new Response('', { status: 200 });
    if (call.url.endsWith('/start_processing')) return startProcessing(call, options);
    if (call.url.endsWith('/check_status')) return checkStatus(call, options);
    if (results && call.url.startsWith('https://r2.example/results/')) return results(call, options);
    if (fallback) return fallback(call, options);
    throw new Error(`unexpected fetch ${call.method} ${call.url}`);
  };
}
