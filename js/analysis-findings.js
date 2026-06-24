// Findings sidebar + /api/analyze + scrubber severity ticks. Static builds
// keep cached findings; generation requires the local backend helper APIs.
import { state, HAS_LOCAL_BACKEND } from './core/state.js';
import { $, escapeHtml } from './dom.js';
import { viewerAiFlags, localApiHeaders } from './config.js';
import { cachedFetchResponse, cachedFetchJson } from './core/cached-fetch.js';
import { setAnalysis, setAnalysisBusy, setSliceIndex } from './core/state/viewer-commands.js';
import { setScrubMarkers } from './scrubber-markers.js';

let _renderScrubTicks = () => {};
const ANALYSIS_POLL_DEADLINE_MS = 20 * 60 * 1000;
const MAX_CONSECUTIVE_ANALYSIS_STATUS_FAILURES = 12;
const ANALYSIS_POLL_DELAY_MS = 2000;

const analysisUnavailableMessage = (flags) => {
  if (flags.aiUnavailableMessage) return flags.aiUnavailableMessage;
  return '';
};

function terminalAnalysisPollError(message) {
  const error = new Error(message);
  error.analysisTerminal = true;
  return error;
}

function showAnalysisError(message) {
  const st = $('gen-status');
  if (st) st.textContent = `Error: ${message}`;
  setAnalysisBusy(false);
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
      ? 'AI Observations (optional) describe the current slice in plain language. They run on the local server — start it with <code>npm start</code> to enable.'
      : !aiFlags.analysisEnabled
      ? 'AI Observations (optional) describe the current slice in plain language. Enable them with <code>npm run setup -- --ai --provider claude</code>, then restart.'
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
  setAnalysisBusy(true);
  renderFindings();
  try {
    let url = `/api/analyze?slug=${encodeURIComponent(slug)}${force ? '&force=1' : ''}`;
    if (slices && slices.length) url += `&slices=${encodeURIComponent(slices.join(','))}`;
    const r = await fetch(url, { method: 'POST', headers: localApiHeaders() });
    if (!r.ok) {
      const payload = await r.json().catch(() => ({}));
      const msg = payload.error || payload.message || `HTTP ${r.status}`;
      showAnalysisError(msg);
      return;
    }
  } catch (e) {
    showAnalysisError(e.message);
    return;
  }

  const startedAt = Date.now();
  let consecutiveFailures = 0;
  let lastFailureDetail = '';

  const poll = async () => {
    if (Date.now() - startedAt >= ANALYSIS_POLL_DEADLINE_MS) {
      const detail = lastFailureDetail ? ` (last status check: ${lastFailureDetail})` : '';
      showAnalysisError(`Analysis timed out after 20 minutes${detail}`);
      return;
    }
    let statusPayload;
    try {
      const r = await fetch('/api/analyze/status', { headers: localApiHeaders() });
      if (!r.ok) {
        lastFailureDetail = `HTTP ${r.status}`;
        if (++consecutiveFailures >= MAX_CONSECUTIVE_ANALYSIS_STATUS_FAILURES) {
          throw terminalAnalysisPollError(`Analysis status check kept failing (${lastFailureDetail})`);
        }
        setTimeout(poll, ANALYSIS_POLL_DELAY_MS);
        return;
      }
      statusPayload = await r.json();
    } catch (e) {
      if (e?.analysisTerminal) {
        showAnalysisError(e.message);
        return;
      }
      lastFailureDetail = e?.message || 'network error';
      if (++consecutiveFailures >= MAX_CONSECUTIVE_ANALYSIS_STATUS_FAILURES) {
        showAnalysisError(`Analysis status check kept failing (${lastFailureDetail})`);
        return;
      }
      setTimeout(poll, ANALYSIS_POLL_DELAY_MS);
      return;
    }
    consecutiveFailures = 0;
    const active = statusPayload?.[slug];
    if (!active) {
      showAnalysisError(`Analysis status missing for ${slug}`);
      return;
    }
    const terminalStatus = active.status || (active.running ? 'running' : '');
    if (terminalStatus === 'running') {
      const st = $('gen-status');
      if (st) st.textContent = active.last || 'running...';
      setTimeout(poll, ANALYSIS_POLL_DELAY_MS);
      return;
    }
    if (terminalStatus === 'error' || terminalStatus === 'terminal-failure') {
      showAnalysisError(active.error || active.last || `Analysis failed for ${slug}`);
      return;
    }
    if (terminalStatus !== 'done') {
      showAnalysisError(`Analysis ended with unknown status: ${terminalStatus || 'missing'}`);
      return;
    }
    setAnalysisBusy(false);
    // Drop stale cache entry before re-reading analysis JSON.
    const url = `./data/${slug}_analysis.json`;
    try { await cachedFetchResponse.invalidate(url); } catch { /* best-effort */ }
    const fresh = await cachedFetchJson(url);
    if (!fresh) {
      showAnalysisError(`Analysis completed but ${slug}_analysis.json was not readable`);
      return;
    }
    setAnalysis(fresh);
    renderFindings();
    _renderScrubTicks();
  };
  setTimeout(poll, 1500);
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
