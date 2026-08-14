// Findings sidebar + /api/analyze + scrubber severity ticks. Static builds
// keep cached findings; generation requires the local backend helper APIs.
import { state, HAS_LOCAL_BACKEND } from './core/state.js';
import { $, escapeHtml } from './dom.js';
import { viewerAiFlags, localApiHeaders } from './config.js';
import { cachedFetchResponse, cachedFetchJson } from './core/cached-fetch.js';
import { setAnalysis, setAnalysisBusy, setSliceIndex } from './core/state/viewer-commands.js';
import { seriesPersistenceKey } from './series/series-identity.js';
import { setScrubMarkers } from './scrubber-markers.js';

let _renderScrubTicks = () => {};
let activeAnalysisRequest = null;
let analysisRequestId = 0;
const ANALYSIS_POLL_DEADLINE_MS = 20 * 60 * 1000;
const MAX_CONSECUTIVE_ANALYSIS_STATUS_FAILURES = 12;
const ANALYSIS_POLL_DELAY_MS = 2000;
const ANALYSIS_KEY_PATTERN = /^v2:[0-9a-f]{32}$/;

const analysisUnavailableMessage = (flags) => {
  if (flags.aiUnavailableMessage) return flags.aiUnavailableMessage;
  return '';
};

function terminalAnalysisPollError(message) {
  const error = new Error(message);
  error.analysisTerminal = true;
  return error;
}

function isCurrentAnalysisRequest(request) {
  return activeAnalysisRequest?.id === request.id
    && !request.controller.signal.aborted
    && state.selectRequestId === request.selectionRequestId
    && state.manifest === request.manifest
    && state.manifest?.series?.[state.seriesIdx] === request.series
    && request.series.slug === request.slug
    && seriesPersistenceKey(request.series, request.manifest) === request.analysisKey;
}

export function analysisResultUrl(analysisKey) {
  if (!ANALYSIS_KEY_PATTERN.test(String(analysisKey || ''))) return '';
  return `./data/analysis-${analysisKey.replace(':', '-')}.json`;
}

export function analysisResultLookupUrl(analysisKey) {
  if (!ANALYSIS_KEY_PATTERN.test(String(analysisKey || ''))) return '';
  return `/api/analyze/result?analysisKey=${encodeURIComponent(analysisKey)}`;
}

export function analysisMatchesSeries(payload, series, manifest) {
  if (!payload || !series?.slug) return false;
  const analysisKey = seriesPersistenceKey(series, manifest);
  return payload.analysisKey === analysisKey && payload.slug === series.slug;
}

// Keyed local-helper results survive series changes and browser reloads without
// setting the slug-wide static-sidecar flag. A present but invalid keyed result
// fails closed; only an unavailable keyed URL may fall back to a declared
// precomputed demo sidecar.
export async function loadPersistedSeriesAnalysis(series, manifest) {
  const analysisKey = seriesPersistenceKey(series, manifest);
  if ((HAS_LOCAL_BACKEND || viewerAiFlags().localAiActionsEnabled) && analysisKey) {
    try {
      const response = await fetch(analysisResultLookupUrl(analysisKey));
      if (response.ok) {
        let keyed;
        try {
          keyed = await response.json();
        } catch {
          return null;
        }
        if (Object.keys(keyed || {}).length) {
          return analysisMatchesSeries(keyed, series, manifest) ? keyed : null;
        }
      } else {
        return null;
      }
    } catch {
      // The local result is unavailable, so the explicit static sidecar below
      // remains an eligible compatibility source.
    }
  }
  if (!series?.hasAnalysis) return null;
  try {
    const legacy = await cachedFetchJson(`./data/${series.slug}_analysis.json`);
    if (!legacy || (legacy.slug != null && legacy.slug !== series.slug)) return null;
    return legacy;
  } catch {
    return null;
  }
}

function clearAnalysisPollTimer(request) {
  if (request.pollTimer == null) return;
  clearTimeout(request.pollTimer);
  request.pollTimer = null;
}

function scheduleAnalysisPoll(request, poll, delay) {
  if (!isCurrentAnalysisRequest(request)) return;
  clearAnalysisPollTimer(request);
  request.pollTimer = setTimeout(() => {
    request.pollTimer = null;
    return poll();
  }, delay);
}

function finishAnalysisRequest(request) {
  if (activeAnalysisRequest?.id !== request.id) return;
  clearAnalysisPollTimer(request);
  activeAnalysisRequest = null;
  setAnalysisBusy(false);
}

function showAnalysisError(message, request = null) {
  if (request && !isCurrentAnalysisRequest(request)) return;
  const st = $('gen-status');
  if (st) st.textContent = `Error: ${message}`;
  if (request) finishAnalysisRequest(request);
  else setAnalysisBusy(false);
}

// Series selection and a replacement request both cancel browser polling. This
// only stops local waiting; a launched helper process may still finish its sidecar.
export function cancelActiveAnalysis() {
  const request = activeAnalysisRequest;
  if (!request) return false;
  clearAnalysisPollTimer(request);
  activeAnalysisRequest = null;
  request.controller.abort();
  setAnalysisBusy(false);
  return true;
}

/** Wired once from viewer after controls exist. */
export function initAnalysisFindings(h) {
  if (typeof h.renderScrubTicks === 'function') _renderScrubTicks = h.renderScrubTicks;
}

export function renderFindings() {
  const host = $('findings');
  $('findings-panel').hidden = false;
  const slug = state.manifest.series[state.seriesIdx].slug;
  const a = state.analysis;
  const hasFindings = !!(a && a.findings && a.findings.length);
  const groundedCount = hasFindings ? a.findings.filter(f => !!f.contextFingerprint).length : 0;
  const legacyCount = hasFindings ? a.findings.length - groundedCount : 0;
  const aiFlags = viewerAiFlags();
  const canRunAnalysis = aiFlags.localAiActionsEnabled;

  if (!hasFindings) {
    const statusMsg = !HAS_LOCAL_BACKEND
      ? 'AI Observations (optional) describe the current slice in plain language. They run on the local server; start it with <code>npm start</code> to enable generation. Previously cached sidecars appear here when present.'
      : !aiFlags.analysisEnabled
      ? 'AI analysis is disabled in config.json. Cached AI observation sidecars still appear here when present.'
      : !aiFlags.localAiAvailable
      ? aiFlags.aiUnavailableMessage
      : state.analysisBusy
      ? 'Sending slices to the local AI runner…'
      : '';
    host.innerHTML = `
      ${canRunAnalysis ? `
        <div class="gen-actions">
          <button class="gen-btn" id="gen-current-analysis">
            ${state.analysisBusy ? '<span class="spinner"></span> Analyzing…' : `Observe slice ${state.sliceIdx + 1}`}
          </button>
          <button class="gen-btn" id="gen-analysis">
            ${state.analysisBusy ? 'Queued' : '5-slice overview'}
          </button>
        </div>
      ` : ''}
      <div class="gen-note" id="gen-status">${statusMsg || 'Not a diagnosis. Unverified AI output, cached locally.'}</div>
    `;
    if (!canRunAnalysis) return;
    const btn = $('gen-analysis');
    const cur = $('gen-current-analysis');
    if (btn && !state.analysisBusy) btn.onclick = () => startAnalysis(slug);
    if (cur && !state.analysisBusy) cur.onclick = () => startAnalysis(slug, false, [state.sliceIdx]);
    return;
  }

  const items = a.findings.map((f) => {
    const sev = f.severity || 'note';
    return `
      <div class="finding ${sev}" data-slice="${f.slice}">
        <div class="f-head">
          <span class="f-idx">slice ${f.slice + 1}</span>
          <span class="ftag ${sev}">${sev.toUpperCase()}</span>
        </div>
        <div class="f-text">${escapeHtml(f.text)}</div>
      </div>
    `;
  }).join('');
  host.innerHTML = `
    ${a.summary ? `<div class="f-summary">${escapeHtml(a.summary)}</div>` : ''}
    <div class="regen-row">
      <span class="dlg-label">
        ${a.findings.length} observations${groundedCount ? ` · ${groundedCount} grounded` : ''}
        ${legacyCount > 0 ? ` · ${legacyCount} ungrounded` : ''}
      </span>
      ${canRunAnalysis
        ? `<span class="regen-link" id="regen-analysis">${state.analysisBusy ? 'analyzing…' : 'regenerate'}</span>`
        : ''}
    </div>
    ${items}
    <div class="gen-note">Not a diagnosis. Unverified AI output.</div>
  `;
  host.querySelectorAll('.finding').forEach((el) => {
    el.addEventListener('click', () => {
      setSliceIndex(+el.dataset.slice);
    });
  });
  const regen = $('regen-analysis');
  if (regen && !state.analysisBusy) regen.onclick = () => startAnalysis(slug, true);
}

export async function startAnalysis(slug, force = false, slices = null) {
  const aiFlags = viewerAiFlags();
  if (!aiFlags.localAiActionsEnabled) {
    const st = $('gen-status');
    if (st) st.textContent = analysisUnavailableMessage(aiFlags);
    return;
  }
  const series = state.manifest?.series?.[state.seriesIdx];
  if (!series || series.slug !== slug) return;
  const analysisKey = seriesPersistenceKey(series, state.manifest);
  if (!analysisKey) {
    const st = $('gen-status');
    if (st) st.textContent = 'Analysis requires a stable source-series identity.';
    return;
  }
  cancelActiveAnalysis();
  const request = {
    id: ++analysisRequestId,
    slug,
    manifest: state.manifest,
    series,
    analysisKey,
    resultUrl: analysisResultUrl(analysisKey),
    selectionRequestId: state.selectRequestId,
    controller: new AbortController(),
    pollTimer: null,
  };
  activeAnalysisRequest = request;
  setAnalysisBusy(true);
  renderFindings();
  try {
    let url = `/api/analyze?slug=${encodeURIComponent(slug)}&analysisKey=${encodeURIComponent(analysisKey)}${force ? '&force=1' : ''}`;
    if (slices && slices.length) url += `&slices=${encodeURIComponent(slices.join(','))}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: localApiHeaders(),
      signal: request.controller.signal,
    });
    if (!isCurrentAnalysisRequest(request)) return;
    const payload = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = payload.error || payload.message || `HTTP ${r.status}`;
      showAnalysisError(msg, request);
      return;
    }
    if (payload.analysisKey !== analysisKey || payload.slug !== slug || payload.resultUrl !== request.resultUrl) {
      showAnalysisError('Analysis runner returned an unexpected result identity.', request);
      return;
    }
  } catch (e) {
    if (!isCurrentAnalysisRequest(request)) return;
    showAnalysisError(e.message, request);
    return;
  }

  const startedAt = Date.now();
  let consecutiveFailures = 0;
  let lastFailureDetail = '';

  const poll = async () => {
    if (!isCurrentAnalysisRequest(request)) return;
    if (Date.now() - startedAt >= ANALYSIS_POLL_DEADLINE_MS) {
      const detail = lastFailureDetail ? ` (last status check: ${lastFailureDetail})` : '';
      showAnalysisError(`Analysis timed out after 20 minutes${detail}`, request);
      return;
    }
    let statusPayload;
    try {
      const r = await fetch(`/api/analyze/status?analysisKey=${encodeURIComponent(request.analysisKey)}`, {
        headers: localApiHeaders(),
        signal: request.controller.signal,
      });
      if (!isCurrentAnalysisRequest(request)) return;
      if (!r.ok) {
        lastFailureDetail = `HTTP ${r.status}`;
        if (++consecutiveFailures >= MAX_CONSECUTIVE_ANALYSIS_STATUS_FAILURES) {
          throw terminalAnalysisPollError(`Analysis status check kept failing (${lastFailureDetail})`);
        }
        scheduleAnalysisPoll(request, poll, ANALYSIS_POLL_DELAY_MS);
        return;
      }
      statusPayload = await r.json();
    } catch (e) {
      if (!isCurrentAnalysisRequest(request)) return;
      if (e?.analysisTerminal) {
        showAnalysisError(e.message, request);
        return;
      }
      lastFailureDetail = e?.message || 'network error';
      if (++consecutiveFailures >= MAX_CONSECUTIVE_ANALYSIS_STATUS_FAILURES) {
        showAnalysisError(`Analysis status check kept failing (${lastFailureDetail})`, request);
        return;
      }
      scheduleAnalysisPoll(request, poll, ANALYSIS_POLL_DELAY_MS);
      return;
    }
    if (!isCurrentAnalysisRequest(request)) return;
    consecutiveFailures = 0;
    const active = statusPayload?.[request.analysisKey];
    if (!active) {
      showAnalysisError(`Analysis status missing for the current source series`, request);
      return;
    }
    if (active.analysisKey !== request.analysisKey || active.slug !== request.slug || active.resultUrl !== request.resultUrl) {
      showAnalysisError('Analysis status returned an unexpected result identity.', request);
      return;
    }
    const terminalStatus = active.status || (active.running ? 'running' : '');
    if (terminalStatus === 'running') {
      const st = $('gen-status');
      if (st) st.textContent = active.last || 'running...';
      scheduleAnalysisPoll(request, poll, ANALYSIS_POLL_DELAY_MS);
      return;
    }
    if (terminalStatus === 'error' || terminalStatus === 'terminal-failure') {
      showAnalysisError(active.error || active.last || `Analysis failed for ${slug}`, request);
      return;
    }
    if (terminalStatus !== 'done') {
      showAnalysisError(`Analysis ended with unknown status: ${terminalStatus || 'missing'}`, request);
      return;
    }
    // Drop stale cache entry before re-reading analysis JSON.
    const url = request.resultUrl;
    try { await cachedFetchResponse.invalidate(url); } catch { /* best-effort */ }
    if (!isCurrentAnalysisRequest(request)) return;
    const fresh = await cachedFetchJson(url);
    if (!isCurrentAnalysisRequest(request)) return;
    if (!fresh) {
      showAnalysisError('Analysis completed but its source-specific result was not readable', request);
      return;
    }
    if (!analysisMatchesSeries(fresh, request.series, request.manifest)) {
      showAnalysisError('Analysis completed with a mismatched source-series identity.', request);
      return;
    }
    finishAnalysisRequest(request);
    setAnalysis(fresh);
    renderFindings();
    _renderScrubTicks();
  };
  scheduleAnalysisPoll(request, poll, 1500);
}

export function renderScrubTicks() {
  const host = $('scrub-ticks');
  host.innerHTML = '';
  const total = state.manifest.series[state.seriesIdx].slices;
  const collected = [];
  const addTick = (slice, cls, title) => {
    const pct = (slice / Math.max(1, total - 1)) * 100;
    const tick = document.createElement('div');
    tick.className = 'scrub-tick ' + cls;
    tick.style.left = `${pct}%`;
    tick.title = title;
    host.appendChild(tick);
    collected.push({ slice, severity: cls, el: tick });
  };

  if (state.analysis && state.analysis.findings) {
    for (const f of state.analysis.findings) {
      if (f.severity === 'note') continue;
      addTick(f.slice, f.severity, `slice ${f.slice + 1}: ${f.text}`);
    }
  }

  if (state.stats && state.stats.microbleeds && state.stats.microbleeds.per_slice) {
    const per = state.stats.microbleeds.per_slice;
    for (let z = 0; z < per.length; z++) {
      if (per[z] > 0) {
        addTick(z, 'microbleed', `slice ${z + 1}: ${per[z]} microbleed candidate${per[z] > 1 ? 's' : ''}`);
      }
    }
  }

  setScrubMarkers(collected);
}
