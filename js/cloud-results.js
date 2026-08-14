import { $ } from './dom.js';
import { state } from './core/state.js';
import { signalPanelReady } from './collapsible-sidebar.js';

let _selectSeries = null;

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

export function cloudResultDetailText(series = {}) {
  const action = series?.cloudAction && typeof series.cloudAction === 'object' ? series.cloudAction : {};
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
      const action = series?.cloudAction && typeof series.cloudAction === 'object' ? series.cloudAction : null;
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

export function initCloudResultsPanel({ selectSeries } = {}) {
  _selectSeries = typeof selectSeries === 'function' ? selectSeries : null;
  renderCloudResultsPanel();
}

export function openCloudResultEvidence() {
  const records = cloudResultRecords(state.manifest?.series || [], { newestFirst: true });
  if (!records.length) return { opened: false, reason: 'none' };
  const target = records.find(record => record.index !== state.seriesIdx) || records[0];
  if (target.index === state.seriesIdx) {
    signalPanelReady('cloud-results');
    return { opened: true, alreadyActive: true, record: target };
  }
  if (!_selectSeries) return { opened: false, reason: 'unavailable' };
  void _selectSeries(target.index);
  return { opened: true, record: target };
}

export function renderCloudResultsPanel() {
  const panel = $('cloud-results-panel');
  const host = $('cloud-results');
  const count = $('cloud-results-count');
  if (!panel || !host) return;
  const records = cloudResultRecords(state.manifest?.series || [], { newestFirst: true });
  if (count) {
    count.hidden = !records.length;
    count.textContent = records.length ? String(records.length) : '';
  }
  panel.hidden = !records.length;
  panel.classList.toggle('panel-init-hidden', !records.length);
  if (!records.length) {
    host.replaceChildren();
    return;
  }
  const list = document.createElement('div');
  list.className = 'cloud-results-list';
  for (const record of records) {
    const active = record.index === state.seriesIdx;
    const meta = [
      record.action,
      record.jobId ? `job ${record.jobId}` : '',
      `outputs ${record.outputs}`,
    ].filter(Boolean).join(' · ');
    const button = document.createElement('button');
    button.className = `cloud-result-row${active ? ' is-active' : ''}`;
    button.type = 'button';
    button.dataset.cloudResultIndex = String(record.index);
    if (active) button.setAttribute('aria-current', 'true');
    const name = document.createElement('span');
    name.className = 'cloud-result-name';
    name.textContent = record.name;
    const metaEl = document.createElement('span');
    metaEl.className = 'cloud-result-meta';
    metaEl.textContent = meta;
    button.append(name, metaEl);
    if (record.detail) {
      const detail = document.createElement('span');
      detail.className = 'cloud-result-detail';
      detail.textContent = record.detail;
      button.append(detail);
    }
    button.addEventListener('click', () => {
      const index = Number(button.dataset.cloudResultIndex);
      if (!Number.isInteger(index) || index === state.seriesIdx || !_selectSeries) return;
      void _selectSeries(index);
    });
    list.append(button);
  }
  host.replaceChildren(list);
  signalPanelReady('cloud-results');
}
