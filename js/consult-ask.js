// Region-scoped Ask composer (inline /api/ask chat over the viewer) + study
// consult (/api/consult) modal.
import { state, subscribe } from './core/state.js';
import { $, escapeHtml, openModal, clientToCanvasPx } from './dom.js';
import { viewerAiFlags, localApiHeaders } from './config.js';
import { drawMeasurements } from './roi/measure.js';
import { notify } from './notify.js';
import { cachedFetchResponse, cachedFetchJson } from './core/cached-fetch.js';
import { normalizeAskResult, normalizeAskSidecar, normalizeConsultResult } from './ask-envelopes.js';
import { cloudActionWorkflowLines, cloudActionWorkflowRecords } from './cloud-actions.js';
import { cloudRuntimeStatus } from './cloud.js';
import { cloudResultOutputs, openCloudResultEvidence } from './cloud-results.js';
import { getRegistrationQuality, getRegistrationRecord } from './metadata.js';
import {
  setAskHistory,
  setAskMarquee,
  setAskPen,
} from './core/state/viewer-tool-commands.js';
import { syncAskPickingUi } from './ask-mode.js';

/** Min drag size (px in slice space) each dimension — below this we nudge the user. */
const ASK_MIN_DRAG = 24;
/** At/below this drag size it's a click, not a box → ask about the whole study. */
const ASK_CLICK_EPS = 6;
const DEFAULT_ASK_PLACEHOLDER = 'What do you see in this region?';
/** Auto-grow ceiling for the prompt input (px) before it scrolls internally. */
const ASK_INPUT_MAX_H = 160;
/** Fade duration (ms) when the "Thinking" shimmer retires into the answer. */
const ASK_THINKING_FADE_MS = 200;
const MAX_CLOUD_ACTION_CONTEXT_SERIES = 8;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const localAiMessage = (flags) => {
  if (flags.aiUnavailableMessage) return flags.aiUnavailableMessage;
  return 'AI actions are unavailable in this mode.';
};

function compactAskValue(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function askSafeFilenamePart(value, fallback = 'series') {
  const text = String(value || fallback).trim().replace(/[^a-z0-9_.-]+/gi, '_');
  return text || fallback;
}

function cloudActionResultStatusDetail(action) {
  const status = compactAskValue(action?.resultStatus || '');
  return status && status.toLowerCase() !== 'complete' ? `status ${status}` : '';
}

function finiteAskNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatAskFixed(value, digits = 1) {
  const number = finiteAskNumber(value);
  return number == null ? null : number.toFixed(digits);
}

function symmetryPeak(scores) {
  if (!Array.isArray(scores) || !scores.length) return null;
  let peak = null;
  for (let z = 0; z < scores.length; z++) {
    const score = finiteAskNumber(scores[z]);
    if (score == null) continue;
    if (!peak || score > peak.score) peak = { z, score };
  }
  return peak;
}

function statsSourceForAsk(series = {}) {
  const remote = compactAskValue(series.statsUrl || '');
  if (remote) return remote;
  const slug = compactAskValue(series.slug);
  return slug ? `data/${slug}_stats.json` : '';
}

function activeQuantificationContextLines(series) {
  const stats = state.stats;
  if (!series || !stats || typeof stats !== 'object') return [];
  const facts = [];
  const regionVolumes = Array.isArray(stats.regionVolumes) ? stats.regionVolumes : [];
  for (const region of regionVolumes.slice(0, 4)) {
    const name = compactAskValue(region?.name || region?.label || region?.id || '');
    const volume = formatAskFixed(region?.volumeMl ?? region?.volume_ml ?? region?.mL, 1);
    if (name && volume != null) facts.push(`${name} region volume ${volume} mL`);
  }
  const peak = symmetryPeak(stats.symmetryScores);
  if (peak) facts.push(`asymmetry peak slice ${peak.z + 1} score ${formatAskFixed(peak.score, 1)}`);
  const csf = formatAskFixed(stats.csfTotalMl, 1);
  if (csf != null) facts.push(`CSF estimate ${csf} mL`);
  const ventricle = formatAskFixed(stats.ventricleEstimateMl, 1);
  if (ventricle != null) facts.push(`ventricle estimate ${ventricle} mL`);
  const wmh = formatAskFixed(stats.wmh?.volume_ml, 1);
  if (wmh != null) facts.push(`WMH heuristic ${wmh} mL`);
  const microbleeds = finiteAskNumber(stats.microbleeds?.count);
  if (microbleeds != null) facts.push(`microbleed candidates ${microbleeds}`);
  const adcUnit = compactAskValue(stats.adc?.display_unit || stats.adc?.units || '');
  if (adcUnit) facts.push(`ADC unit ${adcUnit}`);
  if (!facts.length) return [];
  return [
    `Active quantification sidecar: ${statsSourceForAsk(series)}; ${facts.join('; ')}; approximate research measurements, not clinical output.`,
    `Active quantification exports: Metadata panel CSV and JSON; filenames voxellab-quantification-${askSafeFilenamePart(series.slug)}.csv and voxellab-quantification-${askSafeFilenamePart(series.slug)}.json; JSON includes structured records and source-slice visual links when present.`,
  ];
}

function registrationContextLines(activeIndex = state.seriesIdx) {
  const seriesList = Array.isArray(state.manifest?.series) ? state.manifest.series : [];
  return seriesList
    .map((item, index) => {
      const record = getRegistrationRecord(item?.slug);
      const quality = record?.quality || getRegistrationQuality(item?.slug);
      if (!quality) return '';
      const facts = [`series ${compactAskValue(item?.name || item?.slug || `#${index + 1}`)}`];
      if (quality.verdict) facts.push(`verdict ${compactAskValue(quality.verdict)}`);
      else if (quality.grade && quality.grade !== 'unknown') facts.push(`grade ${compactAskValue(quality.grade)}`);
      if (Number.isFinite(quality.mm)) facts.push(`displacement ${quality.mm.toFixed(quality.mm >= 10 ? 1 : 2)} mm`);
      if (Number.isFinite(quality.dice)) facts.push(`dice ${quality.dice}`);
      if (Number.isFinite(quality.rotationDeg)) facts.push(`rotation ${quality.rotationDeg} deg`);
      const source = compactAskValue(record?.source || 'data/registration.json');
      const fixed = seriesList.find(series => matchesRegistrationRef(series, record?.referenceSlug));
      const compare = fixed && fixed.slug !== item?.slug
        ? `; inspect Metadata panel Compare opens fixed/moving compare with ${compactAskValue(fixed.name || fixed.slug)} as fixed image`
        : '';
      return `${index === activeIndex ? 'Active' : 'Other'} registration evidence: ${facts.join('; ')}; source ${source}; export Metadata panel Registration JSON filename voxellab-registration-evidence-${askSafeFilenamePart(item?.slug)}.json${compare}.`;
    })
    .filter(Boolean)
    .slice(0, MAX_CLOUD_ACTION_CONTEXT_SERIES);
}

function matchesRegistrationRef(series = {}, value = '') {
  const ref = String(value || '').trim();
  if (!ref) return false;
  return [
    series.slug,
    series.sourceSeriesSlug,
    series.sourceSeriesUID,
    series.seriesInstanceUID,
    series.uid,
  ].some(item => String(item || '').trim() === ref);
}

function registrationCompareTargetForSeries(series = {}) {
  const record = getRegistrationRecord(series?.slug);
  const seriesList = Array.isArray(state.manifest?.series) ? state.manifest.series : [];
  const fixed = seriesList.find(item => matchesRegistrationRef(item, record?.referenceSlug));
  if (!fixed || fixed.slug === series?.slug) return null;
  return { referenceSlug: fixed.slug, movingSlug: series.slug, fixedName: fixed.name || fixed.slug, movingName: series.name || series.slug };
}

function openRegistrationCompareFromAsk() {
  const seriesList = Array.isArray(state.manifest?.series) ? state.manifest.series : [];
  const active = seriesList[state.seriesIdx];
  const target = registrationCompareTargetForSeries(active)
    || seriesList.map(series => registrationCompareTargetForSeries(series)).find(Boolean);
  if (!target) {
    notify('No registration comparison is available in the loaded study', { id: 'ask-registration-compare-empty', duration: 2400 });
    return;
  }
  window.dispatchEvent(new CustomEvent('voxellab:open-registration-compare', { detail: target }));
  notify(`Opening ${target.fixedName} / ${target.movingName} comparison`, {
    id: 'ask-registration-compare-opened',
    duration: 1800,
  });
}

function cloudActionStudyLines(activeIndex = state.seriesIdx) {
  const seriesList = Array.isArray(state.manifest?.series) ? state.manifest.series : [];
  const records = seriesList
    .map((item, index) => {
      const action = item?.cloudAction && typeof item.cloudAction === 'object' ? item.cloudAction : null;
      const jobId = compactAskValue(action?.jobId || item?.sourceJobId || '');
      if (!action && !jobId) return null;
      const actionName = compactAskValue(action?.label || action?.id || 'Legacy cloud job');
      const detail = [
        `series ${compactAskValue(item?.name || item?.slug || `#${index + 1}`)}`,
        jobId ? `job ${jobId}` : '',
        cloudActionResultStatusDetail(action),
        action?.processingMode ? `mode ${compactAskValue(action.processingMode)}` : '',
        action?.inputKind ? `input ${compactAskValue(action.inputKind)}` : '',
        `outputs ${cloudResultOutputs(item, { style: 'verbose' })}`,
      ].filter(Boolean);
      return `${index === activeIndex ? 'Active' : 'Other'} completed cloud action: ${actionName}; ${detail.join('; ')}.`;
    })
    .filter(Boolean);
  if (!records.length) return ['Completed cloud actions in loaded study: 0.'];
  const shown = records.slice(0, MAX_CLOUD_ACTION_CONTEXT_SERIES);
  const hidden = records.length - shown.length;
  return [
    `Completed cloud actions in loaded study: ${records.length}.`,
    ...shown,
    ...(hidden ? [`Additional completed cloud actions omitted from Ask context: ${hidden}.`] : []),
  ];
}

function hasLoadedCloudActionCandidate(loadedState = '') {
  return loadedState.startsWith('CT/MR source volume candidates:')
    || loadedState.startsWith('calibrated projection sources:')
    || loadedState.startsWith('registration pair candidates:')
    || loadedState.startsWith('calibrated ultrasound sources:');
}

function cloudActionWorkflowSummaryLines(records = []) {
  if (!records.length) return [];
  const counts = records.reduce((acc, record) => {
    acc[record.readinessKind] = (acc[record.readinessKind] || 0) + 1;
    return acc;
  }, {});
  const ready = counts.ready || 0;
  const setup = counts['setup-required'] || 0;
  const blocked = counts.blocked || 0;
  const candidateCount = records.filter(record => hasLoadedCloudActionCandidate(record.loadedState)).length;
  return [
    `Cloud workflow operator summary: ${records.length} action slots; runtime-ready ${ready}; setup-required ${setup}; blocked ${blocked}; loaded-source candidates visible for ${candidateCount}.`,
    'Cloud workflow operator boundary: Ask can prepare prerequisites and next steps; Upload study must select files and launch jobs.',
    'Cloud workflow next steps:',
    ...records.map(record => `Cloud workflow next step: ${record.label}: ${record.nextStep}; loaded study: ${record.loadedState || 'not inspected'}.`),
  ];
}

function askCloudActionContext() {
  const series = state.manifest?.series?.[state.seriesIdx];
  if (!series) return '';
  const seriesList = Array.isArray(state.manifest?.series) ? state.manifest.series : [];
  const label = compactAskValue(series.name || series.slug || 'active series');
  const action = series.cloudAction && typeof series.cloudAction === 'object' ? series.cloudAction : null;
  const lines = [`Active viewer series: ${label}.`];
  const status = cloudRuntimeStatus();
  if (action) {
    const actionName = compactAskValue(action.label || action.id || 'Cloud action');
    const detail = [
      `provider ${compactAskValue(action.provider || 'unknown')}`,
      `job ${compactAskValue(action.jobId || series.sourceJobId || 'unknown')}`,
      cloudActionResultStatusDetail(action),
      `mode ${compactAskValue(action.processingMode || 'unknown')}`,
      `input ${compactAskValue(action.inputKind || 'unspecified')}`,
      `result ${compactAskValue(action.resultSlug || series.slug || 'unknown')}`,
    ];
    lines.push(`Completed cloud action: ${actionName}; ${detail.join('; ')}.`);
    lines.push(`Available cloud outputs: ${cloudResultOutputs(series, { style: 'verbose' })}.`);
    lines.push(`Active cloud provenance export: Metadata panel Provenance JSON; filename voxellab-cloud-provenance-${askSafeFilenamePart(series.slug)}.json; includes action, job id, output locations, engine report when present, and non-clinical disclaimer.`);
    lines.push(`Active cloud package export: Metadata panel Package JSON; filename voxellab-cloud-package-${askSafeFilenamePart(series.slug)}.json; manifest-only handoff with trusted preview/raw/overlay/sidecar asset references.`);
  } else {
    lines.push('No completed cloud action provenance is attached to the active viewer series.');
    if (series.sourceJobId) lines.push(`Legacy cloud job id on series: ${compactAskValue(series.sourceJobId)}.`);
  }
  for (const factLine of activeQuantificationContextLines(series)) lines.push(factLine);
  for (const factLine of registrationContextLines()) lines.push(factLine);
  for (const actionLine of cloudActionStudyLines()) lines.push(actionLine);
  lines.push(`Cloud GPU runtime: ${status.code}; ${status.message}`);
  lines.push('Cloud actions launch from Upload study after explicit file selection; Ask can explain or prepare the workflow, not upload files by itself.');
  const workflowContext = {
    activeIndex: state.seriesIdx,
    limit: MAX_CLOUD_ACTION_CONTEXT_SERIES,
    projectionSets: state.manifest?.projectionSets || [],
    seriesList,
  };
  const workflowRecords = cloudActionWorkflowRecords(status, workflowContext);
  for (const actionLine of cloudActionWorkflowSummaryLines(workflowRecords)) lines.push(actionLine);
  lines.push('Cloud action slots:');
  for (const actionLine of cloudActionWorkflowLines(status, workflowContext)) lines.push(actionLine);
  return `\n\nViewer cloud/action context:\n- ${lines.join('\n- ')}`;
}

// ---------------------------------------------------------------------------
// Scoped Ask composer — an inline chat anchored over the viewer. One drag-
// selected region scopes a conversation; follow-up questions stack in a thread
// above the prompt bar. Lifecycle is state-driven (see watchComposerLifecycle):
// any series/view/tool change closes the composer so a stale region can never
// outlive its slice. `_ask.seq` invalidates in-flight /api/ask responses whose
// composer was closed or re-scoped before they returned.
// ---------------------------------------------------------------------------

/**
 * Active composer scope, or null when closed.
 * @type {{ slug: string, slice: number, region: {x0:number,y0:number,x1:number,y1:number},
 *          loc: string, thumb: string, available: boolean, seq: number } | null}
 */
let _ask = null;
let _askSeq = 0;
let _composerBuilt = false;
let _lifecycleWatched = false;
/** True while a question is streaming — blocks sending another until it lands. */
let _askBusy = false;

/** Selected AI provider/model (persisted), switched from the bar's model pill. */
const ASK_MODEL_KEY = 'mri-viewer/aiModel/v1';
const ASK_MODELS = {
  'opus-4.8': { provider: 'claude', model: 'opus', label: 'Opus 4.8' },
  'gpt-5.5': { provider: 'codex', model: 'gpt-5.5', label: 'GPT-5.5' },
};
let _aiChoice = (() => {
  try { const k = localStorage.getItem(ASK_MODEL_KEY); return ASK_MODELS[k] ? k : 'opus-4.8'; }
  catch { return 'opus-4.8'; }
})();

function cropPreviewDataUrl(x0, y0, x1, y1) {
  const canvas = $('view');
  if (!canvas) return '';
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w < 1 || h < 1) return '';
  try {
    const maxSide = 1024;
    let dw = w;
    let dh = h;
    if (Math.max(dw, dh) > maxSide) {
      const s = maxSide / Math.max(dw, dh);
      dw = Math.round(dw * s);
      dh = Math.round(dh * s);
    }
    const c = document.createElement('canvas');
    c.width = dw;
    c.height = dh;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, x0, y0, w, h, 0, 0, dw, dh);
    return c.toDataURL('image/png');
  } catch {
    return '';
  }
}

function formatAskLocMeta(series, loc) {
  const sl = `Slice ${loc.slice + 1}`;
  if (loc.region) {
    const r = loc.region;
    return `${series.name} · ${sl} · ${r.x0},${r.y0} — ${r.x1},${r.y1}`;
  }
  return `${series.name} · ${sl} · ${Math.round(loc.x)}, ${Math.round(loc.y)}`;
}

function autoGrowAskInput() {
  const ta = $('ask-bar-input');
  if (!ta) return;
  ta.style.height = 'auto';
  const h = ta.scrollHeight;
  ta.style.height = `${Math.min(ASK_INPUT_MAX_H, h)}px`;
  const bar = ta.closest('.ask-bar');
  if (!bar) return;
  // Past one line the textarea lifts onto its own full-width row above the
  // controls (and the pill morphs to a rounded rect). FLIP the lift so the
  // controls/textarea glide to their new spots instead of snapping.
  const tall = h > 44;
  if (bar.classList.contains('ask-bar--tall') === tall) return;
  flipBarReflow(bar, () => bar.classList.toggle('ask-bar--tall', tall));
}

/** FLIP the bar's children across the single-row ↔ stacked layout change. */
function flipBarReflow(bar, mutate) {
  const kids = [...bar.children].filter((c) => c.id !== 'ask-bar-pop');
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { mutate(); return; }
  const first = kids.map((c) => c.getBoundingClientRect());
  mutate();
  kids.forEach((c, i) => {
    const last = c.getBoundingClientRect();
    const dx = first[i].left - last.left;
    const dy = first[i].top - last.top;
    if (!dx && !dy) return;
    c.style.transition = 'none';
    c.style.transform = `translate(${dx}px, ${dy}px)`;
  });
  void bar.offsetWidth; // reflow so the inverted start position paints
  kids.forEach((c) => {
    c.style.transition = 'transform var(--resize-dur) var(--resize-ease)';
    c.style.transform = '';
  });
  setTimeout(() => kids.forEach((c) => { c.style.transition = ''; c.style.transform = ''; }), 280);
}

function syncAskSendEnabled() {
  const ta = $('ask-bar-input');
  const send = $('ask-bar-send');
  if (!ta || !send) return;
  send.disabled = _askBusy || !_ask || !_ask.available || !ta.value.trim();
}

function openCloudProcessingUploadFromAsk(action = {}) {
  const askAction = action && typeof action === 'object' && typeof action.id === 'string' ? action : {};
  const detail = compactAskValue(askAction.detail || '');
  window.dispatchEvent(new CustomEvent('voxellab:open-cloud-processing-upload', {
    detail: {
      contextTitle: 'Cloud GPU processing',
      contextBody: detail || 'Select source files for segmentation, registration/alignment, reconstruction, or ultrasound scan conversion. VoxelLab checks eligibility before any upload.',
    },
  }));
}

function openCloudResultsFromAsk() {
  const result = openCloudResultEvidence();
  if (!result.opened) {
    notify('No completed cloud results in the loaded study', { id: 'ask-cloud-results-empty', duration: 2200 });
    return;
  }
  const name = result.record?.name || 'cloud result';
  notify(result.alreadyActive ? 'Cloud result already selected' : `Opened ${name}`, {
    id: 'ask-cloud-results-opened',
    duration: 1800,
  });
}

const ASK_ACTION_SPECS = {
  'open-cloud-workflow': {
    label: 'Open Cloud GPU',
    detail: 'Select files before any upload or cloud job starts.',
    icon: 'i-upload',
    run: openCloudProcessingUploadFromAsk,
  },
  'open-cloud-results': {
    label: 'Open Cloud Results',
    detail: 'Open completed cloud-result evidence in the viewer.',
    icon: 'i-layers',
    run: openCloudResultsFromAsk,
  },
  'open-registration-compare': {
    label: 'Open Registration Compare',
    detail: 'Open fixed/moving registration comparison in the viewer.',
    icon: 'i-columns',
    run: openRegistrationCompareFromAsk,
  },
};

function renderAskActions(host, actions = []) {
  if (!host) return;
  host.replaceChildren();
  for (const action of Array.isArray(actions) ? actions : []) {
    const spec = ASK_ACTION_SPECS[action?.id];
    if (!spec) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ask-action-chip';
    button.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true"><use href="icons.svg#${escapeHtml(spec.icon || 'i-upload')}"/></svg>
      <span class="ask-action-copy">
        <span class="ask-action-label"></span>
        <span class="ask-action-detail"></span>
      </span>
    `;
    button.querySelector('.ask-action-label').textContent = action.label || spec.label;
    button.querySelector('.ask-action-detail').textContent = action.detail || spec.detail;
    button.addEventListener('click', () => spec.run(action));
    host.appendChild(button);
  }
  host.hidden = host.childElementCount === 0;
}

function buildAskComposer() {
  if (_composerBuilt) return;
  const wrap = $('canvas-wrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.id = 'ask-composer';
  el.className = 'ask-composer';
  el.hidden = true;
  el.innerHTML = `
    <div class="ask-drawer" id="ask-drawer">
      <div class="ask-scope">
        <div class="ask-stack" id="ask-stack" hidden></div>
        <div class="ask-scope-meta">
          <span class="ask-scope-title">Ask about this study</span>
          <span class="ask-scope-loc" id="ask-scope-loc"></span>
        </div>
        <button type="button" class="ask-scope-action" id="ask-open-cloud-workflow" aria-label="Open Cloud GPU processing">
          <svg viewBox="0 0 24 24" aria-hidden="true"><use href="icons.svg#i-upload"/></svg>
          <span>Cloud GPU</span>
        </button>
        <button type="button" class="ask-scope-close" id="ask-scope-close" aria-label="Close (Esc)">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="ask-thread" id="ask-thread" hidden></div>
    </div>
    <form class="ask-bar" id="ask-bar">
      <button type="button" class="ask-bar-plus" id="ask-bar-plus" aria-label="Add" aria-haspopup="true" aria-expanded="false">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
      <textarea class="ask-bar-input" id="ask-bar-input" rows="1"
        placeholder="${escapeHtml(DEFAULT_ASK_PLACEHOLDER)}" aria-label="Question for AI"></textarea>
      <button type="button" class="ask-bar-model" id="ask-bar-model" aria-haspopup="true" aria-expanded="false" aria-label="Model">
        <span id="ask-model-label">Claude</span>
        <svg class="ask-model-caret" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <button type="submit" class="ask-bar-send" id="ask-bar-send" aria-label="Send (Enter)" disabled>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
      </button>
      <div class="ask-model-menu" id="ask-model-menu" hidden>
        <button type="button" class="ask-model-opt" data-key="opus-4.8">Opus 4.8</button>
        <button type="button" class="ask-model-opt" data-key="gpt-5.5">GPT-5.5</button>
      </div>
      <div class="ask-bar-pop" id="ask-bar-pop" hidden>
        <button type="button" class="ask-bar-pop-item" id="ask-pop-pen">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          <span>Select a region</span>
        </button>
        <div class="ask-pop-sep" id="ask-pop-sep" hidden></div>
        <div class="ask-pop-head" id="ask-pop-head" hidden>Add a study as context</div>
        <div class="ask-pop-studies" id="ask-pop-studies"></div>
      </div>
    </form>
    <div class="ask-composer-note">Descriptive observations only · not a medical diagnosis · ⇧↵ for a new line</div>
  `;
  wrap.appendChild(el);
  _composerBuilt = true;

  const ta = el.querySelector('#ask-bar-input');
  el.querySelector('#ask-bar').addEventListener('submit', (e) => {
    e.preventDefault();
    submitAskQuestion();
  });
  ta.addEventListener('input', () => {
    autoGrowAskInput();
    syncAskSendEnabled();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitAskQuestion();
    }
  });
  el.querySelector('#ask-scope-close').addEventListener('click', () => closeAskComposer());
  el.querySelector('#ask-open-cloud-workflow').addEventListener('click', openCloudProcessingUploadFromAsk);

  // "+" popover: arm the pen (region select). Outside-click / Escape closes it.
  const plus = el.querySelector('#ask-bar-plus');
  const pop = el.querySelector('#ask-bar-pop');
  const setPop = (open) => { pop.hidden = !open; plus.setAttribute('aria-expanded', String(open)); };
  plus.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = pop.hidden;
    if (open) renderPopStudies();
    setPop(open);
  });
  el.querySelector('#ask-pop-pen').addEventListener('click', () => {
    setPop(false);
    setAskPen(true);
    syncAskPickingUi();
  });
  // Model selector pill: pick provider/model, persist, relabel.
  const modelBtn = el.querySelector('#ask-bar-model');
  const modelMenu = el.querySelector('#ask-model-menu');
  const modelLabel = el.querySelector('#ask-model-label');
  const setModelMenu = (open) => { modelMenu.hidden = !open; modelBtn.setAttribute('aria-expanded', String(open)); };
  const applyModel = (key) => {
    _aiChoice = ASK_MODELS[key] ? key : 'opus-4.8';
    modelLabel.textContent = ASK_MODELS[_aiChoice].label;
    try { localStorage.setItem(ASK_MODEL_KEY, _aiChoice); } catch { /* ignore */ }
  };
  applyModel(_aiChoice);
  modelBtn.addEventListener('click', (e) => { e.stopPropagation(); setPop(false); setModelMenu(modelMenu.hidden); });
  modelMenu.querySelectorAll('.ask-model-opt').forEach((opt) => {
    opt.addEventListener('click', () => { applyModel(opt.dataset.key); setModelMenu(false); });
  });

  document.addEventListener('mousedown', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !plus.contains(e.target)) setPop(false);
    if (!modelMenu.hidden && !modelMenu.contains(e.target) && !modelBtn.contains(e.target)) setModelMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!pop.hidden) { e.stopPropagation(); setPop(false); }
    if (!modelMenu.hidden) { e.stopPropagation(); setModelMenu(false); }
  }, true);
}

function watchComposerLifecycle() {
  if (_lifecycleWatched) return;
  _lifecycleWatched = true;
  // A scoped conversation is only valid for the slice/series/region it was
  // opened on, so any of these transitions tears it down.
  const closeIfOpen = () => { if (_ask) closeAskComposer(); };
  subscribe('seriesIdx', closeIfOpen);
  subscribe('mode', closeIfOpen);
  subscribe('askMode', () => { if (_ask && !state.askMode) closeAskComposer(); });
}

const ASK_STUDY_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 3 3 7.5 12 12l9-4.5L12 3z"/><path d="M3 12l9 4.5L21 12"/><path d="M3 16.5 12 21l9-4.5"/></svg>`;
const ASK_ATT_X = `<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`;

/** Render the attachment deck (region crops + context studies) in the scope row. */
function renderAttachments() {
  if (!_ask) return;
  const stack = $('ask-stack');
  if (!stack) return;
  const atts = _ask.attachments;
  stack.innerHTML = '';
  stack.hidden = atts.length === 0;
  stack.style.setProperty('--n', String(Math.max(1, atts.length)));
  atts.forEach((a, i) => {
    const card = document.createElement('div');
    card.className = 'ask-att';
    card.style.setProperty('--i', String(i));
    card.title = a.type === 'region' ? (a.loc || 'Region') : (a.name || a.slug);
    const inner = a.type === 'region'
      ? `<img class="ask-att-img" src="${a.thumb}" alt="Region"/>`
      : `<span class="ask-att-study">${ASK_STUDY_ICON}</span>`;
    card.innerHTML = `${inner}<button type="button" class="ask-att-x" aria-label="Remove">${ASK_ATT_X}</button>`;
    card.querySelector('.ask-att-x').addEventListener('click', (e) => { e.stopPropagation(); removeAttachment(i); });
    if (a.type === 'region') card.addEventListener('click', () => openAskLightbox(a.thumb));
    stack.appendChild(card);
  });
  _wireStackHover(stack);
  _syncScopeMeta();
}

function _syncScopeMeta() {
  const el = $('ask-composer');
  if (!el || !_ask) return;
  const atts = _ask.attachments;
  const regions = atts.filter((a) => a.type === 'region').length;
  const studies = atts.filter((a) => a.type === 'study').length;
  const title = el.querySelector('.ask-scope-title');
  const loc = $('ask-scope-loc');
  if (!atts.length) {
    if (title) title.textContent = 'Ask about this study';
    if (loc) loc.textContent = _ask.studyLoc || '';
    return;
  }
  const parts = [];
  if (regions) parts.push(`${regions} region${regions > 1 ? 's' : ''}`);
  if (studies) parts.push(`${studies} stud${studies > 1 ? 'ies' : 'y'} in context`);
  if (title) title.textContent = 'Ask about your selection';
  if (loc) loc.textContent = `${_ask.seriesName} · ${parts.join(' · ')}`;
}

function addAttachment(att) {
  if (!_ask) return;
  _ask.attachments.push(att);
  renderAttachments();
  syncAskSendEnabled();
}

function removeAttachment(i) {
  if (!_ask) return;
  _ask.attachments.splice(i, 1);
  renderAttachments();
}

/** Fill the "+" popover with the other uploaded studies (to add as context). */
function renderPopStudies() {
  const list = $('ask-pop-studies');
  const sep = $('ask-pop-sep');
  const head = $('ask-pop-head');
  if (!list || !_ask) return;
  const series = state.manifest?.series || [];
  const attached = new Set(_ask.attachments.filter((a) => a.type === 'study').map((a) => a.slug));
  const others = series.filter((s) => s.slug !== _ask.slug && !attached.has(s.slug));
  list.innerHTML = '';
  if (sep) sep.hidden = !others.length;
  if (head) head.hidden = !others.length;
  const icon = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3 3 7.5 12 12l9-4.5L12 3z"/><path d="M3 12l9 4.5L21 12"/><path d="M3 16.5 12 21l9-4.5"/></svg>`;
  others.forEach((s) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'ask-bar-pop-item';
    item.innerHTML = `${icon}<span>${escapeHtml(s.name || s.slug)}</span>`;
    item.addEventListener('click', () => {
      addAttachment({ type: 'study', slug: s.slug, name: s.name || s.slug });
      const pop = $('ask-bar-pop');
      if (pop) pop.hidden = true;
      $('ask-bar-plus')?.setAttribute('aria-expanded', 'false');
    });
    list.appendChild(item);
  });
}

/** Stack fan-out on hover with a bouncy spring on return (avatar-group trick). */
function _wireStackHover(stack) {
  if (stack.dataset.hoverWired) return;
  stack.dataset.hoverWired = '1';
  stack.addEventListener('mouseenter', () => {
    stack.querySelectorAll('.ask-att').forEach((c) => { c.style.transitionTimingFunction = ''; });
    stack.classList.add('ask-stack--open');
  });
  stack.addEventListener('mouseleave', () => {
    const out = getComputedStyle(document.documentElement).getPropertyValue('--avatar-ease-out').trim() || 'cubic-bezier(0.34, 3.85, 0.64, 1)';
    stack.querySelectorAll('.ask-att').forEach((c) => { c.style.transitionTimingFunction = out; });
    stack.classList.remove('ask-stack--open');
  });
}

function openAskComposer(ctx) {
  buildAskComposer();
  watchComposerLifecycle();
  const el = $('ask-composer');
  if (!el) return;
  _ask = {
    slug: ctx.slug,
    slice: ctx.slice,
    seriesName: ctx.seriesName || '',
    studyLoc: ctx.studyLoc || '',
    available: ctx.available,
    unavailableMessage: ctx.unavailableMessage || '',
    attachments: Array.isArray(ctx.attachments) ? [...ctx.attachments] : [],
    seq: ++_askSeq,
  };

  const thread = $('ask-thread');
  thread.innerHTML = '';
  thread.hidden = true;

  const ta = $('ask-bar-input');
  ta.value = '';
  ta.style.height = 'auto';
  ta.disabled = !_ask.available;
  ta.placeholder = _ask.available ? 'Ask anything about this study…' : 'AI is unavailable';
  if (!_ask.available && _ask.unavailableMessage) {
    appendThreadNotice(_ask.unavailableMessage);
  }

  renderAttachments();

  // A region is now selected, so the slice is no longer a selection target:
  // drop the crosshair cursor (class sources + the inline one the canvas
  // mousemove handler last set) and the drag hint while the composer is open.
  $('canvas-wrap')?.classList.remove('ask-picking');
  $('view-xform')?.classList.remove('measuring');
  const view = $('view');
  if (view) view.style.cursor = '';
  const hint = $('ask-mode-hint');
  if (hint) hint.hidden = true;

  // Show first, then size + animate: a hidden textarea reports scrollHeight 0,
  // which previously left the empty input mis-sized until the first keystroke.
  el.hidden = false;
  const drawer = $('ask-drawer');
  drawer.classList.remove('ask-drawer-in');
  void drawer.offsetWidth; // restart the slide-up-from-behind animation
  drawer.classList.add('ask-drawer-in');
  syncAskSendEnabled();
  requestAnimationFrame(() => {
    autoGrowAskInput();
    if (ctx.available) ta.focus();
  });
}

export function closeAskComposer() {
  _ask = null;
  _askSeq++; // any in-flight response now resolves against a dead seq
  _askBusy = false;
  closeAskLightbox();
  const el = $('ask-composer');
  if (el) el.hidden = true;
  setAskPen(false);
  // Pen retired with the composer; the viewer is a normal pannable viewer again.
  syncAskPickingUi();
}

// --- Region quick-look: click the attachment to preview the crop large ---
let _lightboxKeyHandler = null;

function openAskLightbox(src) {
  if (!src) return;
  let lb = $('ask-lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'ask-lightbox';
    lb.className = 'ask-lightbox';
    lb.innerHTML = '<img alt="Selected region (enlarged)" />';
    lb.addEventListener('click', closeAskLightbox);
    document.body.appendChild(lb);
  }
  lb.querySelector('img').src = src;
  lb.hidden = false;
  lb.classList.remove('ask-lightbox-in');
  void lb.offsetWidth;
  lb.classList.add('ask-lightbox-in');
  // Capture-phase so Escape closes the preview before the composer/global handler.
  _lightboxKeyHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeAskLightbox();
    }
  };
  document.addEventListener('keydown', _lightboxKeyHandler, true);
}

function closeAskLightbox() {
  const lb = $('ask-lightbox');
  if (lb) lb.hidden = true;
  if (_lightboxKeyHandler) {
    document.removeEventListener('keydown', _lightboxKeyHandler, true);
    _lightboxKeyHandler = null;
  }
}

/** Close the composer if it owns the current Escape (handled before exit-ask-mode). */
export function cancelAskQuestionIfOpen() {
  const el = $('ask-composer');
  if (!_ask || !el || el.hidden) return false;
  closeAskComposer();
  return true;
}

// Reveal the answer word by word with a soft blur-fade. Whitespace tokens are
// kept as text nodes so wrapping and newlines are preserved exactly; the stagger
// caps so very long answers don't trail on forever. Pure opacity/blur, so the
// effect is identical in light and dark themes (the text keeps var(--text)).
function renderAnswerWithFade(el, text) {
  el.textContent = '';
  const cell = document.createElement('div');
  cell.className = 'ask-a-cell';
  let wi = 0;
  for (const tok of String(text).split(/(\s+)/)) {
    if (tok === '') continue;
    if (/^\s+$/.test(tok)) {
      cell.appendChild(document.createTextNode(tok));
    } else {
      const span = document.createElement('span');
      span.className = 'ask-word';
      span.textContent = tok;
      span.style.animationDelay = `${Math.min(wi, 160) * 24}ms`;
      cell.appendChild(span);
      wi++;
    }
  }
  el.appendChild(cell);
  // Grow the answer's height in (grid-rows) as the words fade, so the drawer
  // expands smoothly rather than jumping to the full height.
  el.classList.add('ask-a-reveal');
  requestAnimationFrame(() => el.classList.add('ask-a-in'));
}

function renderAnswerPlain(el, text) {
  el.textContent = '';
  const cell = document.createElement('div');
  cell.className = 'ask-a-cell';
  cell.textContent = text || '';
  el.appendChild(cell);
}

function appendLiveAnswer(el, text) {
  let cell = el.querySelector('.ask-a-cell');
  if (!cell) {
    el.className = 'ask-qa-a';
    el.style.opacity = '';
    renderAnswerPlain(el, '');
    cell = el.querySelector('.ask-a-cell');
  }
  cell.textContent += text || '';
}

// The steps timeline (prompt-kit "Steps"): a continuous line on the left with the
// kind icon spaced from it per call, grouped under a collapsible trigger. Live
// calls stream in via upsertToolChip; cached results render as a collapsed group.
const _svgIcon = (inner, size = 14) =>
  `<svg class="ask-step-ico-svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

const ASK_KIND = {
  read:    { icon: _svgIcon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>') },
  inspect: { icon: _svgIcon('<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>') },
  measure: { icon: _svgIcon('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>') },
  voxel:   { icon: _svgIcon('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.27 6.96 8.73 5.04 8.73-5.04"/><path d="M12 22.08V12"/>') },
  other:   { icon: _svgIcon('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>') },
};
const ASK_TOOL_CHEVRON = `<svg class="ask-tool-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
const ASK_STEPS_CHEVRON = `<svg class="ask-steps-chev" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;

function _buildToolChip(host, { id, kind, label, detail }) {
  const hasDetail = !!(detail && detail.trim());
  const k = ASK_KIND[kind] || ASK_KIND.other;
  const step = document.createElement('div');
  step.className = `ask-step ask-step--${ASK_KIND[kind] ? kind : 'other'}`;
  if (id) step.dataset.toolId = id;
  step.innerHTML = `
    <div class="ask-step-cell">
      <button type="button" class="ask-step-head"${hasDetail ? ' aria-expanded="false"' : ' tabindex="-1" aria-disabled="true"'}>
        <span class="ask-step-ico">${k.icon}</span>
        <span class="ask-step-name">${escapeHtml(label || 'Tool')}</span>
        ${hasDetail ? ASK_TOOL_CHEVRON : ''}
      </button>
      ${hasDetail ? `<div class="ask-step-detailwrap"><div class="ask-step-detail">${escapeHtml(detail)}</div></div>` : ''}
    </div>
  `;
  if (hasDetail) {
    const head = step.querySelector('.ask-step-head');
    head.addEventListener('click', () => {
      const opening = step.classList.toggle('open');
      head.setAttribute('aria-expanded', String(opening));
      // Keep the toggled header fixed; only the content below it moves (one
      // direction), instead of the drawer-up + reveal-down dual motion.
      if (opening) requestAnimationFrame(() => step.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    });
  }
  host.appendChild(step);
  // Grow + fade the row in (a frame later so the 0fr→1fr transition fires).
  requestAnimationFrame(() => step.classList.add('ask-step-in'));
  return step;
}

/** The kind icon stays put; running pulses it, error tints it red. */
function _setChipState(step, state) {
  step.classList.toggle('ask-step--running', state === 'running');
  step.classList.toggle('ask-step--error', state === 'error');
}

/** Lazily create the collapsible steps group (chevron-left trigger + timeline). */
function _ensureStepsGroup(host) {
  let group = host.querySelector('.ask-steps');
  if (group) return group;
  group = document.createElement('div');
  group.className = 'ask-steps';
  group.dataset.open = 'true';
  group.innerHTML = `
    <button type="button" class="ask-steps-trigger" aria-expanded="true">
      ${ASK_STEPS_CHEVRON}
      <span class="ask-steps-label ask-shimmer-text">Working…</span>
    </button>
    <div class="ask-steps-content"><div class="ask-steps-timeline"></div></div>
  `;
  group.querySelector('.ask-steps-trigger').addEventListener('click', (e) => {
    const open = group.dataset.open !== 'true';
    group.dataset.open = open ? 'true' : 'false';
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });
  host.appendChild(group);
  host.hidden = false;
  return group;
}

/** Live: create a step when a tool starts; flip its node on its result. */
function upsertToolChip(host, ev) {
  if (!host || !ev.id) return;
  const timeline = _ensureStepsGroup(host).querySelector('.ask-steps-timeline');
  let step = timeline.querySelector(`[data-tool-id="${(window.CSS && CSS.escape) ? CSS.escape(ev.id) : ev.id}"]`);
  if (!step) {
    if (ev.state !== 'running') return;
    step = _buildToolChip(timeline, ev);
  }
  _setChipState(step, ev.state);
}

function appendToolOutput(host, ev) {
  if (!host || !ev.id || !ev.text) return;
  const timeline = _ensureStepsGroup(host).querySelector('.ask-steps-timeline');
  const step = timeline.querySelector(`[data-tool-id="${(window.CSS && CSS.escape) ? CSS.escape(ev.id) : ev.id}"]`);
  const detail = step?.querySelector('.ask-step-detail');
  if (!detail) return;
  const prefix = step.dataset.hasOutput ? '' : '\n\n';
  step.dataset.hasOutput = 'true';
  detail.textContent = `${detail.textContent || ''}${prefix}${ev.text}`.slice(-5000);
}

/** Tools done: collapse the timeline to a clean summary line you can re-expand
 *  (or drop an empty group if no real tools ran). */
function collapseStepsGroup(host) {
  const group = host?.querySelector('.ask-steps');
  if (!group) return;
  const n = group.querySelectorAll('.ask-step').length;
  if (!n) { group.remove(); return; }
  group.dataset.open = 'false';
  group.querySelector('.ask-steps-trigger')?.setAttribute('aria-expanded', 'false');
  const lbl = group.querySelector('.ask-steps-label');
  if (lbl) {
    lbl.classList.remove('ask-shimmer-text');
    lbl.textContent = `Worked through ${n} step${n > 1 ? 's' : ''}`;
  }
}

/** Post-hoc (cached results have no live stream): build the group collapsed. */
function renderToolSteps(host, steps) {
  if (!host || !Array.isArray(steps) || !steps.length) return;
  host.innerHTML = '';
  const timeline = _ensureStepsGroup(host).querySelector('.ask-steps-timeline');
  steps.forEach((step) => _setChipState(_buildToolChip(timeline, step), 'done'));
  collapseStepsGroup(host);
}

function appendThreadNotice(msg) {
  const thread = $('ask-thread');
  if (!thread) return;
  thread.hidden = false;
  const div = document.createElement('div');
  div.className = 'ask-qa';
  div.innerHTML = `<div class="ask-qa-cell"><div class="ask-qa-a err">${escapeHtml(msg)}</div></div>`;
  thread.appendChild(div);
  requestAnimationFrame(() => { div.classList.add('ask-qa-in'); thread.scrollTop = thread.scrollHeight; });
}

async function submitAskQuestion() {
  if (_askBusy || !_ask || !_ask.available) return;
  const ta = $('ask-bar-input');
  const question = ta.value.trim();
  if (!question) {
    ta.focus();
    return;
  }
  const ctx = _ask;
  _askBusy = true;
  syncAskSendEnabled();
  const seq = ctx.seq;
  const stale = () => _ask?.seq !== seq;

  const thread = $('ask-thread');
  thread.hidden = false;
  // Only the latest turn reserves the breathing room below "Thinking"; older
  // turns collapse to their natural height.
  thread.querySelectorAll('.ask-qa--active').forEach((el) => el.classList.remove('ask-qa--active'));
  const block = document.createElement('div');
  block.className = 'ask-qa ask-qa--active';
  block.innerHTML = `
    <div class="ask-qa-cell">
      <div class="ask-qa-q">${escapeHtml(question)}</div>
      <div class="ask-qa-tools" hidden></div>
      <div class="ask-qa-a pending ask-shimmer-text">Thinking</div>
      <div class="ask-qa-actions" hidden></div>
    </div>
  `;
  thread.appendChild(block);
  thread.scrollTop = thread.scrollHeight;
  // Grow + fade the whole turn in (a frame later so the 0fr→1fr transition fires).
  requestAnimationFrame(() => { block.classList.add('ask-qa-in'); thread.scrollTop = thread.scrollHeight; });
  const ansEl = block.querySelector('.ask-qa-a');

  ta.value = '';
  autoGrowAskInput();
  syncAskSendEnabled();
  ta.focus();

  const toolsHost = block.querySelector('.ask-qa-tools');
  const actionsHost = block.querySelector('.ask-qa-actions');
  let liveTools = 0;
  let composed = false;
  let liveAnswer = '';
  let liveAnswerStarted = false;

  // Errors can arrive after a tool ran (ansEl hidden, group mid-"Working…"), so
  // fail() must settle the timeline and restore the answer slot, not just write text.
  const fail = (msg) => {
    collapseStepsGroup(toolsHost);
    ansEl.hidden = false;
    ansEl.style.opacity = '';
    ansEl.className = 'ask-qa-a err';
    ansEl.textContent = `Error: ${msg}`;
    thread.scrollTop = thread.scrollHeight;
  };

  // One region with no extra context → the single-region fast path. Otherwise
  // the app sends attachment notes as viewerContext so the visible question
  // stays exactly what the user typed.
  const regions = (ctx.attachments || []).filter((a) => a.type === 'region');
  const studies = (ctx.attachments || []).filter((a) => a.type === 'study');
  let region = null;
  const viewerContext = [];
  const cloudContext = askCloudActionContext();
  if (cloudContext) viewerContext.push(cloudContext);
  if (regions.length === 1 && !studies.length) {
    region = regions[0].region;
  } else if (regions.length || studies.length) {
    const notes = [];
    if (regions.length) {
      notes.push('Focus on these selected regions: ' + regions
        .map((r) => `slice ${r.slice + 1} [${r.region.x0},${r.region.y0} to ${r.region.x1},${r.region.y1}]`).join('; '));
    }
    if (studies.length) {
      notes.push('Also use these other studies as context (read their slices under data/<slug>/): ' + studies.map((s) => s.slug).join(', '));
    }
    viewerContext.push(`Attachment context: ${notes.join('. ')}.`);
  }
  try {
    const r = await fetch('/api/ask/stream', {
      method: 'POST',
      headers: localApiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        slug: ctx.slug,
        slice: ctx.slice,
        region,
        question,
        viewerContext: viewerContext.join('\n\n') || undefined,
        provider: ASK_MODELS[_aiChoice].provider, model: ASK_MODELS[_aiChoice].model || undefined,
      }),
    });
    if (!r.ok || !r.body) {
      const err = await r.json().catch(() => ({}));
      if (!stale()) fail(err.error || `HTTP ${r.status}`);
      return;
    }
    // Read the SSE body progressively: tool chips appear/flip live, then the
    // final result fades the shimmer into the answer.
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let result = null;
    let streamError = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (stale()) { try { await reader.cancel(); } catch { /* ignore */ } return; }
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        let ev;
        try { ev = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
        if (ev.type === 'tool') {
          // The agent is working: hide "Thinking" the moment the first tool runs.
          if (ev.state === 'running' && liveTools++ === 0) ansEl.hidden = true;
          upsertToolChip(toolsHost, ev);
          thread.scrollTop = thread.scrollHeight;
        } else if (ev.type === 'phase') {
          // Tools are done; the model is composing the answer. Collapse the
          // timeline and bring "Thinking" back for the compose phase. (Driven by
          // the StructuredOutput finalizer, so it is interleave-safe.)
          if (ev.value === 'composing') {
            composed = true;
            collapseStepsGroup(toolsHost);
            ansEl.hidden = false;
            thread.scrollTop = thread.scrollHeight;
          }
        } else if (ev.type === 'delta') {
          if (!ev.text) continue;
          if (!liveAnswerStarted) {
            liveAnswerStarted = true;
            composed = true;
            collapseStepsGroup(toolsHost);
            ansEl.hidden = false;
            ansEl.className = 'ask-qa-a';
            ansEl.style.opacity = '';
            renderAnswerPlain(ansEl, '');
          }
          liveAnswer += ev.text;
          appendLiveAnswer(ansEl, ev.text);
          thread.scrollTop = thread.scrollHeight;
        } else if (ev.type === 'tool_output') {
          appendToolOutput(toolsHost, ev);
        } else if (ev.type === 'result') {
          result = ev.result;
        } else if (ev.type === 'error') {
          streamError = ev.error;
        }
      }
    }
    if (stale()) return;
    if (streamError || !result) { fail(streamError || 'no answer'); return; }
    result = normalizeAskResult(result);
    // Refresh the cached ask sidecar (the server just rewrote it).
    const asksUrl = `./data/${ctx.slug}_asks.json`;
    try { await cachedFetchResponse.invalidate(asksUrl); } catch { /* best-effort */ }
    const askData = await cachedFetchJson(asksUrl);
    if (stale()) return;
    if (askData) setAskHistory(normalizeAskSidecar(askData).entries);
    // Cached results stream no live tools — fall back to the reported steps;
    // otherwise the group was collapsed by the 'composing' phase (fallback here).
    if (!liveTools) renderToolSteps(toolsHost, result.steps || []);
    else if (!composed) collapseStepsGroup(toolsHost);
    if (liveAnswerStarted) {
      ansEl.hidden = false;
      ansEl.className = 'ask-qa-a';
      ansEl.style.opacity = '';
      renderAnswerPlain(ansEl, result.answer || liveAnswer);
      renderAskActions(actionsHost, result.actions || []);
      thread.scrollTop = thread.scrollHeight;
      return;
    }
    ansEl.hidden = false; // ensure "Thinking" is back before it fades to the answer
    // Fade the "Thinking" shimmer out, then stream the answer in from the same
    // left edge (the pending element and the answer share .ask-qa-a metrics).
    ansEl.style.opacity = '0';
    await delay(ASK_THINKING_FADE_MS);
    if (stale()) return;
    ansEl.className = 'ask-qa-a';
    ansEl.style.opacity = '';
    renderAnswerWithFade(ansEl, result.answer || '');
    if (result.cached) {
      const tag = document.createElement('span');
      tag.className = 'ask-qa-cached';
      tag.textContent = 'cached';
      (ansEl.querySelector('.ask-a-cell') || ansEl).appendChild(tag);
    }
    renderAskActions(actionsHost, result.actions || []);
    thread.scrollTop = thread.scrollHeight;
  } catch (e) {
    if (stale()) return;
    fail(e.message);
  } finally {
    // Re-enable sending once this turn settles (unless a newer turn now owns it).
    if (!stale()) { _askBusy = false; syncAskSendEnabled(); }
  }
}

/**
 * Drag a rectangle on the slice (like a screengrab), then ask about it inline.
 * @param {MouseEvent} ev
 */
/** Open the composer in whole-study scope; the pen (+) adds a region on top. */
export function openStudyAsk() {
  if (state.mode !== '2d' || !state.loaded) return;
  const series = state.manifest?.series?.[state.seriesIdx];
  if (!series) return;
  const flags = viewerAiFlags();
  openAskComposer({
    slug: series.slug,
    slice: state.sliceIdx,
    seriesName: series.name,
    studyLoc: `${series.name} · Slice ${state.sliceIdx + 1} · whole study`,
    available: flags.localAiActionsEnabled,
    unavailableMessage: flags.localAiActionsEnabled ? '' : localAiMessage(flags),
    attachments: [],
  });
}

export function handleAskPointerDown(ev) {
  if (state.mode !== '2d' || !state.loaded) return;
  ev.preventDefault();
  const [px, py] = clientToCanvasPx($('view'), ev.clientX, ev.clientY);
  setAskMarquee({ x0: px, y0: py, x1: px, y1: py });

  const onMove = (e) => {
    const [qx, qy] = clientToCanvasPx($('view'), e.clientX, e.clientY);
    if (!state.askMarquee) return;
    setAskMarquee({ ...state.askMarquee, x1: qx, y1: qy });
    drawMeasurements();
  };

  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    const series = state.manifest.series[state.seriesIdx];
    const W = series.width;
    const H = series.height;
    const raw = state.askMarquee;
    setAskMarquee(null);
    drawMeasurements();
    // One-shot: after a drag the pen retires and the cursor returns to pan.
    setAskPen(false);
    syncAskPickingUi();

    if (!raw) return;
    let x0 = Math.round(Math.min(raw.x0, raw.x1));
    let y0 = Math.round(Math.min(raw.y0, raw.y1));
    let x1 = Math.round(Math.max(raw.x0, raw.x1));
    let y1 = Math.round(Math.max(raw.y0, raw.y1));
    x0 = Math.max(0, Math.min(x0, W - 1));
    x1 = Math.max(0, Math.min(x1, W - 1));
    y0 = Math.max(0, Math.min(y0, H - 1));
    y1 = Math.max(0, Math.min(y1, H - 1));
    const rw = x1 - x0 + 1;
    const rh = y1 - y0 + 1;
    const flags = viewerAiFlags();
    // A click (no real box) in pen mode adds nothing — the composer is already open.
    if (rw <= ASK_CLICK_EPS && rh <= ASK_CLICK_EPS) return;
    if (rw < ASK_MIN_DRAG || rh < ASK_MIN_DRAG) {
      notify(`Drag a larger box (at least ${ASK_MIN_DRAG}×${ASK_MIN_DRAG} px on each side).`, { duration: 3400 });
      return;
    }

    const region = { x0, y0, x1, y1 };
    const att = {
      type: 'region',
      region,
      slice: state.sliceIdx,
      thumb: cropPreviewDataUrl(x0, y0, x1, y1),
      loc: formatAskLocMeta(series, { slice: state.sliceIdx, region }),
    };
    if (_ask) {
      addAttachment(att);
    } else {
      openAskComposer({
        slug: series.slug,
        slice: state.sliceIdx,
        seriesName: series.name,
        studyLoc: `${series.name} · Slice ${state.sliceIdx + 1} · whole study`,
        available: flags.localAiActionsEnabled,
        unavailableMessage: flags.localAiActionsEnabled ? '' : localAiMessage(flags),
        attachments: [att],
      });
    }
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  drawMeasurements();
}

export async function runConsult(force = false) {
  const body = $('consult-body');
  openModal('consult-modal');
  const flags = viewerAiFlags();
  if (!flags.localAiActionsEnabled) {
    body.innerHTML = `<div class="ask-a err">${escapeHtml(localAiMessage(flags))}</div>`;
    return;
  }
  body.innerHTML = `<div class="ask-a"><span class="spinner"></span> ${force ? 'Re-running consult…' : 'Synthesizing findings…'}</div>`;
  try {
    let result;
    if (!force) {
      const r = await fetch('/api/consult', { headers: localApiHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      result = await r.json();
      if (result && Object.keys(result).length > 0) result = normalizeConsultResult(result);
    }
    if (force || !result || Object.keys(result).length === 0) {
      const r2 = await fetch('/api/consult?force=1', { method: 'POST', headers: localApiHeaders() });
      const rawResult = await r2.json();
      if (!r2.ok) throw new Error(rawResult.error || `HTTP ${r2.status}`);
      result = normalizeConsultResult(rawResult);
    }
    renderConsultBody(body, result);
  } catch (e) {
    body.innerHTML = `<div class="ask-a err">Error: ${escapeHtml(e.message)}</div>`;
  }
}

export function renderConsultBody(body, result) {
  const bullets = (result.ask_radiologist || []).map((b) => `<li>${escapeHtml(b)}</li>`).join('');
  body.innerHTML = `
    <div class="ask-section-title">Impression${result.cached ? ' · cached' : ''}</div>
    <div class="ask-a">${escapeHtml(result.impression || '')}</div>
    ${bullets ? `
      <div class="ask-section-title">Things worth asking a radiologist</div>
      <ul class="ask-list">${bullets}</ul>
    ` : ''}
    ${result.limitations ? `
      <div class="ask-section-title">What this study cannot assess</div>
      <div class="ask-a">${escapeHtml(result.limitations)}</div>
    ` : ''}
    <div class="ask-foot">
      <span>${escapeHtml(result.disclaimer || 'Generated by a general-purpose AI, not a medical imaging model. May contain errors. Always consult a qualified radiologist.')}</span>
      <span class="rerun" id="consult-rerun">re-run</span>
    </div>
  `;
  const rerun = $('consult-rerun');
  if (rerun) rerun.onclick = () => runConsult(true);
}
