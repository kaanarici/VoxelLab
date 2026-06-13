// Presentation model for the mixed-folder intake summary. Turns the structured
// triage data summarizeLocalIntake() already produces into an ordered list of
// outcome rows so the Upload modal can render a scannable triage panel instead
// of one run-on muted sentence. This is presentation only: it does not classify
// intake, only reshapes counts/samples that local-intake-text.js also consumes.
import { desktopFolderWarningText } from '../desktop-intake-text.js';
import { escapeHtml } from '../dom.js';
import { intakeFormatLabel } from '../intake-format-summary.js';
import { sidecarUnsupportedDescription } from '../sidecar-schemas.js';
import { localFilePath } from './local-intake-text.js';

const MAX_TRIAGE_SAMPLES = 5;

function shortPath(file = {}) {
  return localFilePath(file).split('/').filter(Boolean).slice(-2).join('/') || file.name || '';
}

function moreLabel(hidden, singular = 'file', pluralText = `${singular}s`) {
  return hidden ? `+${hidden} more ${hidden === 1 ? singular : pluralText}` : '';
}

function sampleRows(items, total, toSample) {
  const list = Array.from(items || []);
  const samples = list
    .map(toSample)
    .filter(entry => entry && entry.name)
    .slice(0, MAX_TRIAGE_SAMPLES);
  const hidden = Math.max(0, Number(total ?? list.length) - samples.length);
  return { samples, more: moreLabel(hidden) };
}

function formatLabelSummary(items = []) {
  const counts = new Map();
  for (const item of items || []) {
    const label = intakeFormatLabel(item);
    if (label) counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => (count === 1 ? label : `${label} ${count}`))
    .join(', ');
}

function folderReadFailures(warnings = []) {
  return warnings.filter(item => String(item?.reason || '') === 'folder_read_failed');
}

function openedRow(intake) {
  const openable = Number(intake?.counts?.openable || 0);
  if (!openable) return null;
  const summary = formatLabelSummary(intake?.formatItems?.openable || []);
  return {
    kind: 'openable',
    tone: 'success',
    count: openable,
    label: `Opened${summary ? ` (${summary})` : ''}`,
    samples: [],
    more: '',
    note: '',
  };
}

function converterRow(intake) {
  const convertible = Number(intake?.counts?.convertible || 0);
  if (!convertible) return null;
  const items = intake?.formatItems?.convertible || [];
  const summary = formatLabelSummary(items);
  const hasOtherSelectedKind = Number(intake?.counts?.openable || 0) || Number(intake?.counts?.sidecar || 0);
  const note = hasOtherSelectedKind
    ? 'Needs configured local readers or an OME-TIFF converter; open separately.'
    : 'Needs configured local readers or an OME-TIFF converter.';
  const { samples, more } = sampleRows(items, convertible, file => ({ name: shortPath(file), reason: '' }));
  return {
    kind: 'convertible',
    tone: 'warning',
    count: convertible,
    label: `Converter-backed${summary ? ` (${summary})` : ''}`,
    samples,
    more,
    note,
  };
}

function sidecarRow(intake) {
  const sidecar = Number(intake?.counts?.sidecar || 0);
  if (!sidecar) return null;
  const summary = formatLabelSummary(intake?.formatItems?.sidecar || []);
  return {
    kind: 'sidecar',
    tone: 'muted',
    count: sidecar,
    label: `Sidecars${summary ? ` (${summary})` : ''}`,
    samples: [],
    more: '',
    note: '',
  };
}

function skippedRow(intake) {
  const skipped = intake?.skipped || [];
  const count = Number(intake?.skippedCount ?? skipped.length);
  if (!count) return null;
  const { samples, more } = sampleRows(skipped, count, file => ({
    name: shortPath(file) || 'unsupported file',
    reason: sidecarUnsupportedDescription(file),
  }));
  return {
    kind: 'skipped',
    tone: 'danger',
    count,
    label: `Skipped (unsupported)`,
    samples,
    more,
    note: '',
  };
}

function fileReadFailedRow(intake) {
  const failures = intake?.failedFileSamples || [];
  const count = Number(intake?.failedFiles ?? failures.length);
  if (!count) return null;
  const { samples, more } = sampleRows(failures, count, file => ({
    name: shortPath(file) || 'file',
    reason: sidecarUnsupportedDescription(file),
  }));
  return {
    kind: 'failedFiles',
    tone: 'danger',
    count,
    label: 'File read failed',
    samples,
    more,
    note: '',
  };
}

function folderReadFailedRow(intake) {
  const failures = folderReadFailures(intake?.warnings || []);
  const count = Number(intake?.failedFolderReads ?? failures.length);
  if (!count) return null;
  const { samples, more } = sampleRows(failures, count, warning => ({
    name: desktopFolderWarningText(warning),
    reason: '',
  }));
  return {
    kind: 'failedFolders',
    tone: 'danger',
    count,
    label: 'Folder read failed',
    samples,
    more: more.replace('file', 'folder read').replace('files', 'folder reads'),
    note: '',
  };
}

function folderWarningRow(intake) {
  const failedFolderReads = Number(
    intake?.failedFolderReads ?? folderReadFailures(intake?.warnings || []).length,
  );
  const others = (intake?.warnings || []).filter(item => String(item?.reason || '') !== 'folder_read_failed');
  const count = Math.max(
    0,
    intake?.warningCount == null ? others.length : Number(intake.warningCount) - failedFolderReads,
  );
  if (!count) return null;
  const { samples, more } = sampleRows(others, count, warning => ({
    name: desktopFolderWarningText(warning),
    reason: '',
  }));
  return {
    kind: 'folderWarnings',
    tone: 'warning',
    count,
    label: 'Folder warnings',
    samples,
    more: more.replace('file', 'warning').replace('files', 'warnings'),
    note: '',
  };
}

// Ordered triage rows; zero-count categories are omitted so a clean import
// shows only the Opened row. Each row: { kind, tone, count, label, samples:[{name,reason}], more, note }.
export function localIntakeTriageModel(intake = {}) {
  return [
    openedRow(intake),
    converterRow(intake),
    sidecarRow(intake),
    skippedRow(intake),
    fileReadFailedRow(intake),
    folderReadFailedRow(intake),
    folderWarningRow(intake),
  ].filter(Boolean);
}

function triageRowMarkup(row) {
  const samples = row.samples
    .map((sample) => {
      const reason = sample.reason ? ` <span class="upload-triage-reason">(${escapeHtml(sample.reason)})</span>` : '';
      return `<li class="upload-triage-sample">${escapeHtml(sample.name)}${reason}</li>`;
    })
    .join('');
  const moreLine = row.more ? `<li class="upload-triage-more">${escapeHtml(row.more)}</li>` : '';
  const sampleList = samples || moreLine ? `<ul class="upload-triage-samples">${samples}${moreLine}</ul>` : '';
  const note = row.note ? `<div class="upload-triage-note">${escapeHtml(row.note)}</div>` : '';
  return `<li class="upload-triage-row is-${row.tone}">
    <div class="upload-triage-head">
      <span class="upload-triage-badge">${escapeHtml(String(row.count))}</span>
      <span class="upload-triage-label">${escapeHtml(row.label)}</span>
    </div>
    ${note}${sampleList}
  </li>`;
}

// Shared triage markup: the full <ul class="upload-triage-list"> string, or ''
// when the model is empty. Single source for the browser Upload modal and the
// desktop "nothing opened" dialog so both render identical tone-coded rows.
export function intakeTriageHtml(intake = {}) {
  const rows = localIntakeTriageModel(intake);
  if (!rows.length) return '';
  return `<ul class="upload-triage-list">${rows.map(triageRowMarkup).join('')}</ul>`;
}
