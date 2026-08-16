import { state } from './core/state.js';
import { notify } from './notify.js';
import {
  markSeriesUnavailable,
  probeSeriesAvailable,
  seriesCanOpenInViewer,
  seriesHasSessionPixels,
} from './series/series-availability.js';

let _selectSeries = null;
let _openingIndex = -1;
let _openRequestId = 0;

export function cloudResultOutputs(series = {}, { style = 'short' } = {}) {
  const short = style !== 'verbose';
  const outputs = [];
  if (series?.hasRaw || series?.rawUrl) outputs.push(short ? 'raw' : 'raw volume');
  if (series?.hasSeg) outputs.push(short ? 'tissue' : 'tissue overlay');
  if (series?.hasRegions) outputs.push(short ? 'labels' : 'anatomy labels');
  if (series?.hasSym) outputs.push(short ? 'heatmap' : 'symmetry heatmap');
  if (series?.hasStats) outputs.push(short ? 'stats' : 'quantitative stats');
  if (series?.hasAnalysis) outputs.push(short ? 'analysis' : 'analysis sidecar');
  return outputs.join(', ') || (short ? 'stack' : 'rendered slice stack');
}

function compactCloudResultValue(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function cloudActionFor(series) {
  const action = series?.cloudAction;
  if (!action || Array.isArray(action)) return null;
  const prototype = Object.getPrototypeOf(action);
  return prototype === Object.prototype || prototype === null ? action : null;
}

export function cloudResultDetailText(series = {}) {
  const action = cloudActionFor(series) || {};
  const parts = [
    action.provider ? `provider ${compactCloudResultValue(action.provider)}` : '',
    action.resultStatus && action.resultStatus !== 'complete' ? `status ${compactCloudResultValue(action.resultStatus)}` : '',
    action.processingMode ? `mode ${compactCloudResultValue(action.processingMode)}` : '',
    action.inputKind ? `input ${compactCloudResultValue(action.inputKind)}` : '',
  ].filter(Boolean);
  const resultSlug = compactCloudResultValue(action.resultSlug);
  const slug = compactCloudResultValue(series.slug);
  if (resultSlug && resultSlug !== slug) parts.push(`result ${resultSlug}`);
  return parts.join(' · ');
}

export function cloudResultRecords(seriesList = [], { limit = Infinity, newestFirst = false, outputStyle = 'short' } = {}) {
  const records = (Array.isArray(seriesList) ? seriesList : [])
    .map((series, index) => {
      const action = cloudActionFor(series);
      const jobId = String(action?.jobId || series?.sourceJobId || '').trim();
      if (!action && !jobId) return null;
      return {
        index,
        slug: String(series.slug || '').trim(),
        name: String(series.name || series.slug || 'Cloud result').trim(),
        action: String(action?.label || 'Cloud result').trim(),
        jobId,
        outputs: cloudResultOutputs(series, { style: outputStyle }),
        detail: cloudResultDetailText(series),
      };
    })
    .filter(Boolean);
  const bounded = Number.isFinite(limit) ? records.slice(-Math.max(0, limit)) : records;
  return newestFirst ? [...bounded].reverse() : bounded;
}

function recordForIndex(index) {
  const series = state.manifest?.series?.[index];
  if (!series) return null;
  return cloudResultRecords(state.manifest?.series || []).find(record => record.index === index) || {
    index,
    slug: String(series.slug || '').trim(),
    name: String(series.name || series.slug || 'Cloud result').trim(),
  };
}

function notifyCloudResultUnavailable(series) {
  const name = String(series?.name || series?.slug || 'Cloud result').trim();
  if (!globalThis.document) return;
  notify(`Can't open ${name} — its image stack isn't available`, {
    id: `cloud-result-unavailable:${series?.slug || name}`,
    kind: 'error',
  });
}

export function initCloudResults({ selectSeries } = {}) {
  _selectSeries = selectSeries instanceof Function ? selectSeries : null;
}

export async function openCloudResultAtIndex(index, { probe = probeSeriesAvailable } = {}) {
  const series = state.manifest?.series?.[index];
  const record = recordForIndex(index);
  if (!series || !record) return { opened: false, reason: 'unavailable' };
  if (_openingIndex === index) return { opened: false, reason: 'pending', record };
  const requestId = ++_openRequestId;
  _openingIndex = -1;
  if (index === state.seriesIdx) {
    return { opened: true, alreadyActive: true, record };
  }
  if (!_selectSeries) return { opened: false, reason: 'unavailable', record };
  const localStacks = state._localStacks || {};
  if (seriesHasSessionPixels(series, { localStacks })) {
    void _selectSeries(index);
    return { opened: true, record };
  }
  if (!seriesCanOpenInViewer(series, { localStacks })) {
    markSeriesUnavailable(series.slug);
    notifyCloudResultUnavailable(series);
    return { opened: false, reason: 'unavailable', record };
  }
  _openingIndex = index;
  try {
    const ok = await probe(series);
    if (requestId !== _openRequestId) {
      return { opened: false, reason: 'superseded', record };
    }
    if (!ok) {
      markSeriesUnavailable(series.slug);
      notifyCloudResultUnavailable(series);
      return { opened: false, reason: 'unavailable', record };
    }
  } finally {
    if (requestId === _openRequestId) _openingIndex = -1;
  }
  void _selectSeries(index);
  return { opened: true, record };
}

export async function openCloudResultEvidence() {
  const records = cloudResultRecords(state.manifest?.series || [], { newestFirst: true });
  if (!records.length) return { opened: false, reason: 'none' };
  const target = records.find(record => record.index !== state.seriesIdx) || records[0];
  return openCloudResultAtIndex(target.index);
}
