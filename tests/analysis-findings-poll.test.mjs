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
  state.sliceIdx = 0;
  state.analysis = null;
  state.analysisBusy = false;
  const analysis = await import(`../js/analysis-findings.js?t=${Date.now()}-${Math.random()}`);

  t.after(() => {
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.location = previous.location;
    globalThis.setTimeout = previous.setTimeout;
    Date.now = previous.dateNow;
  });

  return { analysis, document, state, timers };
}

async function runQueuedTimers(timers, limit = 40) {
  for (let index = 0; timers.length && index < limit; index++) {
    await timers.shift()();
  }
}

test('analysis poll surfaces terminal error status', async (t) => {
  const { analysis, document, state, timers } = await setupAnalysisPollTest(t);
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.startsWith('/api/analyze?')) {
      assert.equal(options.method, 'POST');
      return Response.json({ message: 'started' });
    }
    if (value === '/api/analyze/status') {
      return Response.json({
        scan: {
          status: 'error',
          running: false,
          exitCode: 2,
          error: 'analyze.py exited with code 2: provider offline',
          last: 'provider offline',
        },
      });
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
    if (value.startsWith('/api/analyze?')) return Response.json({ message: 'started' });
    if (value === '/api/analyze/status') {
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
    if (value.startsWith('/api/analyze?')) return Response.json({ message: 'started' });
    if (value === '/api/analyze/status') return Response.json({});
    if (value.endsWith('/data/scan_analysis.json') || value.endsWith('./data/scan_analysis.json')) {
      sidecarFetched = true;
      return Response.json({ findings: [] });
    }
    assert.fail(`unexpected fetch ${value}`);
  };

  await analysis.startAnalysis('scan');
  await runQueuedTimers(timers);

  assert.equal(sidecarFetched, false);
  assert.match(document.getElementById('gen-status').textContent, /status missing for scan/);
});

test('analysis poll enforces a client deadline', async (t) => {
  const { analysis, document, timers } = await setupAnalysisPollTest(t);
  let now = 0;
  Date.now = () => now;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.startsWith('/api/analyze?')) return Response.json({ message: 'started' });
    if (value === '/api/analyze/status') {
      return Response.json({ scan: { status: 'running', running: true, last: 'working' } });
    }
    assert.fail(`unexpected fetch ${value}`);
  };

  await analysis.startAnalysis('scan');
  now = 20 * 60 * 1000;
  await runQueuedTimers(timers, 1);

  assert.match(document.getElementById('gen-status').textContent, /timed out after 20 minutes/);
});
