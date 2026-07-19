import assert from 'node:assert/strict';
import { test } from 'node:test';

function makeElement(id, owner) {
  return {
    id,
    hidden: false,
    textContent: '',
    dataset: {},
    onclick: null,
    _innerHTML: '',
    classList: {
      add() {},
      remove() {},
      toggle() {},
    },
    style: {
      setProperty() {},
    },
    appendChild() {},
    addEventListener() {},
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    set innerHTML(value) {
      this._innerHTML = String(value);
      for (const match of this._innerHTML.matchAll(/id="([^"]+)"/g)) {
        owner.getElementById(match[1]);
      }
    },
    get innerHTML() {
      return this._innerHTML;
    },
  };
}

function makeDocument() {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id, document));
      return elements.get(id);
    },
    querySelector() {
      return null;
    },
  };
  document.getElementById('findings');
  document.getElementById('findings-panel');
  return document;
}

async function setupAnalysisPollTest(t) {
  const previous = {
    document: globalThis.document,
    fetch: globalThis.fetch,
    location: globalThis.location,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    dateNow: Date.now,
  };
  const document = makeDocument();
  const timers = [];
  globalThis.document = document;
  globalThis.location = { href: 'http://localhost:8000/', hostname: 'localhost', search: '' };
  globalThis.setTimeout = (fn) => {
    timers.push(fn);
    return timers.length;
  };
  globalThis.clearTimeout = () => {};
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value === '/api/local-token') return Response.json({ localApiToken: 'local-token' });
    if (value.endsWith('config.local.json') || value.endsWith('config.json')) {
      return Response.json({
        localAiAvailable: true,
        ai: { enabled: true, ready: true, issues: [] },
        features: { aiAnalysis: true },
      });
    }
    return new Response('', { status: 404 });
  };

  const config = await import('../js/config.js');
  await config.loadConfig();
  const { state } = await import('../js/core/state.js');
  state.manifest = { series: [{ slug: 'scan', slices: 3 }] };
  state.seriesIdx = 0;
  state.selectRequestId = 1;
  state.sliceIdx = 0;
  state.analysis = null;
  state.analysisBusy = false;
  const analysis = await import(`../js/analysis-findings.js?t=${Date.now()}-${Math.random()}`);

  t.after(() => {
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.location = previous.location;
    globalThis.setTimeout = previous.setTimeout;
    globalThis.clearTimeout = previous.clearTimeout;
    Date.now = previous.dateNow;
  });

  return { analysis, document, state, timers };
}

async function runQueuedTimers(timers, limit = 40) {
  for (let index = 0; timers.length && index < limit; index++) {
    await timers.shift()();
  }
}

function startedAnalysisResponse(url) {
  const parsed = new URL(String(url), 'http://localhost');
  const analysisKey = parsed.searchParams.get('analysisKey');
  assert.match(analysisKey || '', /^v2:[0-9a-f]{32}$/);
  return Response.json({
    message: 'started',
    analysisKey,
    slug: parsed.searchParams.get('slug'),
    resultUrl: `./data/analysis-${analysisKey.replace(':', '-')}.json`,
  });
}

function analysisStatus(analysisKey, fields) {
  return {
    [analysisKey]: {
      analysisKey,
      slug: 'scan',
      resultUrl: `./data/analysis-${analysisKey.replace(':', '-')}.json`,
      ...fields,
    },
  };
}

function isAnalysisStatusRequest(value) {
  return String(value).startsWith('/api/analyze/status?analysisKey=v2%3A');
}

test('analysis poll surfaces terminal error status', async (t) => {
  const { analysis, document, state, timers } = await setupAnalysisPollTest(t);
  let analysisKey;
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.startsWith('/api/analyze?')) {
      assert.equal(options.method, 'POST');
      analysisKey = new URL(value, 'http://localhost').searchParams.get('analysisKey');
      return startedAnalysisResponse(value);
    }
    if (isAnalysisStatusRequest(value)) {
      return Response.json(analysisStatus(analysisKey, {
          status: 'error',
          running: false,
          exitCode: 2,
          error: 'analyze.py exited with code 2: provider offline',
          last: 'provider offline',
      }));
    }
    assert.fail(`unexpected fetch ${value}`);
  };

  await analysis.startAnalysis('scan');
  await runQueuedTimers(timers);

  assert.equal(state.analysisBusy, false);
  assert.match(document.getElementById('gen-status').textContent, /provider offline/);
});

test('analysis poll fails after sustained status HTTP errors', async (t) => {
  const { analysis, document, timers } = await setupAnalysisPollTest(t);
  let statusChecks = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.startsWith('/api/analyze?')) return startedAnalysisResponse(value);
    if (isAnalysisStatusRequest(value)) {
      statusChecks++;
      return new Response('bad gateway', { status: 502 });
    }
    assert.fail(`unexpected fetch ${value}`);
  };

  await analysis.startAnalysis('scan');
  await runQueuedTimers(timers);

  assert.equal(statusChecks, 12);
  assert.match(document.getElementById('gen-status').textContent, /status check kept failing \(HTTP 502\)/);
});

test('analysis poll fails when status entry disappears', async (t) => {
  const { analysis, document, timers } = await setupAnalysisPollTest(t);
  let sidecarFetched = false;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.startsWith('/api/analyze?')) return startedAnalysisResponse(value);
    if (isAnalysisStatusRequest(value)) return Response.json({});
    if (value.includes('/data/analysis-v2-')) {
      sidecarFetched = true;
      return Response.json({ findings: [] });
    }
    assert.fail(`unexpected fetch ${value}`);
  };

  await analysis.startAnalysis('scan');
  await runQueuedTimers(timers);

  assert.equal(sidecarFetched, false);
  assert.match(document.getElementById('gen-status').textContent, /status missing for the current source series/);
});

test('analysis poll enforces a client deadline', async (t) => {
  const { analysis, document, timers } = await setupAnalysisPollTest(t);
  let now = 0;
  let analysisKey;
  Date.now = () => now;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.startsWith('/api/analyze?')) {
      analysisKey = new URL(value, 'http://localhost').searchParams.get('analysisKey');
      return startedAnalysisResponse(value);
    }
    if (isAnalysisStatusRequest(value)) {
      return Response.json(analysisStatus(analysisKey, { status: 'running', running: true, last: 'working' }));
    }
    assert.fail(`unexpected fetch ${value}`);
  };

  await analysis.startAnalysis('scan');
  now = 20 * 60 * 1000;
  await runQueuedTimers(timers, 1);

  assert.match(document.getElementById('gen-status').textContent, /timed out after 20 minutes/);
});

test('analysis cancellation aborts an in-flight status poll without changing state', async (t) => {
  const { analysis, state, timers } = await setupAnalysisPollTest(t);
  let statusSignal = null;
  let markStatusStarted;
  const statusStarted = new Promise(resolve => { markStatusStarted = resolve; });
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.startsWith('/api/analyze?')) return startedAnalysisResponse(value);
    if (isAnalysisStatusRequest(value)) {
      return new Promise((_resolve, reject) => {
        statusSignal = options.signal;
        markStatusStarted();
        options.signal?.addEventListener('abort', () => {
          reject(new DOMException('cancelled', 'AbortError'));
        }, { once: true });
      });
    }
    assert.fail(`unexpected fetch ${value}`);
  };

  await analysis.startAnalysis('scan');
  const polling = timers.shift()();
  await statusStarted;
  assert.equal(analysis.cancelActiveAnalysis(), true);
  await polling;

  assert.equal(statusSignal?.aborted, true);
  assert.equal(state.analysisBusy, false);
  assert.equal(state.analysis, null);
});

test('analysis completion cannot cross a selection session or same-slug series replacement', async (t) => {
  const { analysis, state, timers } = await setupAnalysisPollTest(t);
  let resolveStatus;
  const statusPending = new Promise(resolve => { resolveStatus = resolve; });
  let sidecarFetches = 0;
  let analysisKey;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.startsWith('/api/analyze?')) {
      analysisKey = new URL(value, 'http://localhost').searchParams.get('analysisKey');
      return startedAnalysisResponse(value);
    }
    if (isAnalysisStatusRequest(value)) return statusPending;
    if (value.includes('/data/analysis-v2-')) {
      sidecarFetches++;
      return Response.json({ analysisKey, summary: 'stale', findings: [] });
    }
    assert.fail(`unexpected fetch ${value}`);
  };

  await analysis.startAnalysis('scan');
  const polling = timers.shift()();
  const replacement = { slug: 'scan', slices: 3, studyUID: 'replacement-study' };
  state.manifest = { studyUID: 'replacement-study', series: [replacement] };
  state.seriesIdx = 0;
  state.selectRequestId++;
  state.analysis = null;
  resolveStatus(analysisStatus(analysisKey, { status: 'done', running: false }));
  await polling;

  assert.equal(sidecarFetches, 0);
  assert.equal(state.analysis, null);
  assert.equal(state.analysisBusy, true);
  assert.equal(analysis.cancelActiveAnalysis(), true);
  assert.equal(state.analysisBusy, false);
});

test('selection reload prefers the exact keyed result over a coexisting legacy sidecar', async (t) => {
  const { analysis, state } = await setupAnalysisPollTest(t);
  const series = { slug: 'scan', slices: 3, studyUID: 'study-a', hasAnalysis: true };
  const manifest = { studyUID: 'study-a', series: [series] };
  state.manifest = manifest;
  let legacyFetches = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.startsWith('/api/analyze/result?')) {
      const analysisKey = new URL(value, 'http://localhost').searchParams.get('analysisKey');
      return Response.json({ analysisKey, slug: 'scan', summary: 'keyed', findings: [] });
    }
    if (value.endsWith('/data/scan_analysis.json')) {
      legacyFetches++;
      return Response.json({ slug: 'scan', summary: 'legacy', findings: [] });
    }
    assert.fail(`unexpected fetch ${value}`);
  };

  const firstSelection = await analysis.loadPersistedSeriesAnalysis(series, manifest);
  const reloadSelection = await analysis.loadPersistedSeriesAnalysis(series, manifest);

  assert.equal(firstSelection.summary, 'keyed');
  assert.equal(reloadSelection.summary, 'keyed');
  assert.equal(legacyFetches, 0);
});

test('selection reloads exact keyed results even when the legacy manifest flag is false', async (t) => {
  const { analysis } = await setupAnalysisPollTest(t);
  const series = { slug: 'scan', slices: 3, studyUID: 'study-a', hasAnalysis: false };
  const manifest = { studyUID: 'study-a', series: [series] };
  let fetches = 0;
  globalThis.fetch = async (url) => {
    fetches += 1;
    const value = String(url);
    const analysisKey = new URL(value, 'http://localhost').searchParams.get('analysisKey');
    return Response.json({ analysisKey, slug: 'scan', summary: 'keyed', findings: [] });
  };

  const loaded = await analysis.loadPersistedSeriesAnalysis(series, manifest);

  assert.equal(loaded.summary, 'keyed');
  assert.equal(fetches, 1);
});

test('selection falls back to declared legacy analysis only when keyed data is unavailable', async (t) => {
  const { analysis } = await setupAnalysisPollTest(t);
  const series = { slug: 'scan', slices: 3, studyUID: 'study-a', hasAnalysis: true };
  const manifest = { studyUID: 'study-a', series: [series] };
  const fetched = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    fetched.push(value);
    if (value.startsWith('/api/analyze/result?')) return Response.json({});
    if (value.endsWith('/data/scan_analysis.json')) {
      return Response.json({ slug: 'scan', summary: 'legacy', findings: [] });
    }
    assert.fail(`unexpected fetch ${value}`);
  };

  const loaded = await analysis.loadPersistedSeriesAnalysis(series, manifest);

  assert.equal(loaded.summary, 'legacy');
  assert.equal(fetched.length, 2);
});

test('selection rejects a present keyed result bound to another slug without legacy fallback', async (t) => {
  const { analysis } = await setupAnalysisPollTest(t);
  const series = { slug: 'scan', slices: 3, studyUID: 'study-a', hasAnalysis: true };
  const manifest = { studyUID: 'study-a', series: [series] };
  let legacyFetches = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.startsWith('/api/analyze/result?')) {
      const analysisKey = new URL(value, 'http://localhost').searchParams.get('analysisKey');
      return Response.json({ analysisKey, slug: 'other', findings: [] });
    }
    if (value.endsWith('/data/scan_analysis.json')) {
      legacyFetches++;
      return Response.json({ slug: 'scan', summary: 'legacy', findings: [] });
    }
    assert.fail(`unexpected fetch ${value}`);
  };

  assert.equal(await analysis.loadPersistedSeriesAnalysis(series, manifest), null);
  assert.equal(legacyFetches, 0);
});

test('selection does not hide a keyed-result server failure behind legacy data', async (t) => {
  const { analysis } = await setupAnalysisPollTest(t);
  const series = { slug: 'scan', slices: 3, studyUID: 'study-a', hasAnalysis: true };
  const manifest = { studyUID: 'study-a', series: [series] };
  let legacyFetches = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.startsWith('/api/analyze/result?')) return new Response('', { status: 500 });
    if (value.endsWith('/data/scan_analysis.json')) {
      legacyFetches++;
      return Response.json({ slug: 'scan', summary: 'legacy', findings: [] });
    }
    assert.fail(`unexpected fetch ${value}`);
  };

  assert.equal(await analysis.loadPersistedSeriesAnalysis(series, manifest), null);
  assert.equal(legacyFetches, 0);
});

test('analysis result URLs reject malformed identity values', async (t) => {
  const { analysis } = await setupAnalysisPollTest(t);
  assert.equal(analysis.analysisResultUrl('../../escape'), '');
  assert.equal(analysis.analysisResultUrl('v2:ABCDEF'), '');
  assert.equal(analysis.analysisResultLookupUrl('../../escape'), '');
  assert.equal(analysis.analysisResultLookupUrl('v2:ABCDEF'), '');
});

test('analysis completion rejects a keyed payload bound to another slug', async (t) => {
  const { analysis, document, state, timers } = await setupAnalysisPollTest(t);
  let analysisKey;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.startsWith('/api/analyze?')) {
      analysisKey = new URL(value, 'http://localhost').searchParams.get('analysisKey');
      return startedAnalysisResponse(value);
    }
    if (isAnalysisStatusRequest(value)) {
      return Response.json(analysisStatus(analysisKey, { status: 'done', running: false }));
    }
    if (value.includes('/data/analysis-v2-')) {
      return Response.json({ analysisKey, slug: 'other', summary: 'replayed', findings: [] });
    }
    assert.fail(`unexpected fetch ${value}`);
  };

  await analysis.startAnalysis('scan');
  await runQueuedTimers(timers);

  assert.equal(state.analysis, null);
  assert.equal(state.analysisBusy, false);
  assert.match(document.getElementById('gen-status').textContent, /mismatched source-series identity/);
});
