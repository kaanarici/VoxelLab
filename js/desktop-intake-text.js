import { appendIntakeFormatSummary } from './intake-format-summary.js';
import { sidecarUnsupportedDescription } from './sidecar-schemas.js';

const FOLDER_WARNING_LABELS = new Map([
  ['folder_depth_limit', 'Scan depth limit'],
  ['folder_file_limit', 'Scan stopped at file limit'],
  ['folder_read_failed', 'Could not read folder'],
  ['folder_empty_or_unsupported', 'No supported files found'],
]);
const FOLDER_FAILURE_REASONS = new Set(['folder_read_failed']);
export const DESKTOP_UNSUPPORTED_SELECTION_ADVICE = 'Try DICOM, NIfTI, OME-TIFF/ImageJ TIFF, TIFF sequences, limited OME-Zarr, matching sidecars, or converter-backed microscopy files.';

function plural(count, singular, pluralText = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralText}`;
}

function hiddenSampleText(hiddenCount, singular = 'more item', pluralText = `${singular}s`) {
  return hiddenCount ? `, plus ${plural(hiddenCount, singular, pluralText)}` : '';
}

function baseName(value = '') {
  return String(value || '').split(/[\\/]/).filter(Boolean).at(-1) || '';
}

function sourceFolderText(sourceFolders = []) {
  const names = sourceFolders.map(baseName).filter(Boolean);
  const samples = names.slice(0, 2);
  return samples.length
    ? ` in ${samples.join(', ')}${hiddenSampleText(Math.max(0, names.length - samples.length), 'more folder')}`
    : '';
}

export function desktopFolderWarningText(warning = {}) {
  const label = FOLDER_WARNING_LABELS.get(String(warning.reason || '')) || String(warning.reason || 'Folder warning');
  const name = baseName(warning.relativePath || warning.path || warning.name);
  return name ? `${label}: ${name}` : label;
}

export function desktopFolderWarningSummaryText(warnings = [], count = warnings.length, maxSamples = 3) {
  const warningCount = Number(count || 0);
  if (!warningCount) return '';
  const samples = warnings.map(desktopFolderWarningText).filter(Boolean).slice(0, maxSamples);
  const sampleText = samples.length
    ? ` (${samples.join(', ')}${hiddenSampleText(Math.max(0, warningCount - samples.length), 'more warning')})`
    : '';
  return `${plural(warningCount, 'folder warning')}${sampleText}`;
}

function selectedSidecarText(sidecars = []) {
  const names = sidecars
    .map(record => record.relativePath || record.name || record.path)
    .filter(Boolean)
    .slice(0, 5);
  const more = hiddenSampleText(Math.max(0, sidecars.length - names.length), 'more file');
  return names.length ? ` Selected sidecar${sidecars.length === 1 ? '' : 's'}: ${names.join(', ')}${more}.` : '';
}

function recordNameSamples(records = [], maxSamples = 3) {
  const samples = records
    .map(record => record?.name || baseName(record?.relativePath || record?.path || ''))
    .filter(Boolean)
    .slice(0, maxSamples);
  const moreCount = Math.max(0, records.length - samples.length);
  const more = moreCount ? `, plus ${plural(moreCount, 'more file')}` : '';
  return samples.length ? `${samples.join(', ')}${more}` : '';
}

export function desktopConversionDialogText(started = [], skipped = []) {
  const messages = [];
  const startedNames = recordNameSamples(started);
  const skippedNames = recordNameSamples(skipped);
  if (started.length) {
    messages.push(
      `Converting ${plural(started.length, 'desktop file')} to OME-TIFF${startedNames ? `: ${startedNames}` : ''}. Converted outputs reopen automatically.`,
    );
  }
  if (skipped.length) {
    messages.push(
      `Configure an OME-TIFF converter before opening ${plural(skipped.length, 'converter-backed file')}${skippedNames ? `: ${skippedNames}` : ''}.`,
    );
  }
  return messages.join(' ');
}

export function desktopMicroscopySidecarOnlyText(sidecars = []) {
  return `Sidecar files are not standalone images. Open the matching microscopy image first, then open the sidecar again.${selectedSidecarText(sidecars)}`;
}

export function desktopDerivedSidecarOnlyText(sidecars = []) {
  return `DICOM SR files are derived objects, not standalone images. Open the matching source DICOM series first, then open the SR file again.${selectedSidecarText(sidecars)}`;
}

function folderReadFailures(payload = {}) {
  return (payload.warnings || []).filter(item => FOLDER_FAILURE_REASONS.has(String(item?.reason || '')));
}

function otherFolderWarnings(payload = {}) {
  return (payload.warnings || []).filter(item => !FOLDER_FAILURE_REASONS.has(String(item?.reason || '')));
}

function unsupportedFileRecords(unsupported = []) {
  return unsupported.filter(item => item?.kind !== 'folder');
}

function unsupportedSampleText(item = {}) {
  const name = item.relativePath || item.name;
  if (!name) return '';
  const reason = sidecarUnsupportedDescription(item);
  return reason ? `${name} (${reason})` : name;
}

function unsupportedSamples(payload = {}, unsupported = []) {
  return [
    ...unsupportedFileRecords(unsupported).map(unsupportedSampleText).filter(Boolean),
    ...(payload.folderSummary?.skippedUnsupportedSamples || [])
      .map(unsupportedSampleText)
      .filter(Boolean),
  ];
}

function failedFileSamples(payload = {}) {
  return (payload.folderSummary?.failedFileSamples || [])
    .map(unsupportedSampleText)
    .filter(Boolean);
}

export function desktopIntakeNotice(payload = {}, openable = [], sidecars = [], convertible = [], unsupported = []) {
  const summary = payload?.folderSummary || null;
  const parts = [];
  const scannedFiles = Number(summary?.scannedFiles || 0);
  if (scannedFiles) parts.push(`scanned ${plural(scannedFiles, 'file')}`);
  if (openable.length) parts.push(appendIntakeFormatSummary(plural(openable.length, 'openable file'), openable));
  if (sidecars.length) parts.push(appendIntakeFormatSummary(plural(sidecars.length, 'sidecar'), sidecars));
  if (convertible.length) parts.push(appendIntakeFormatSummary(plural(convertible.length, 'converter-backed file'), convertible));
  const unsupportedCount = unsupportedFileRecords(unsupported).length + Number(summary?.skippedUnsupportedFiles || 0);
  const fallbackFailureCount = folderReadFailures(payload).length;
  const failedFolderReads = Number(summary?.failedFolderReads ?? fallbackFailureCount);
  const failedFiles = Number(summary?.failedFiles || 0);
  const rawWarningCount = Number(summary?.warningCount || payload?.warnings?.length || 0);
  const warningCount = Math.max(0, rawWarningCount - failedFolderReads);
  if (unsupportedCount) parts.push(`${plural(unsupportedCount, 'unsupported file')} skipped`);
  if (failedFiles) parts.push(`${plural(failedFiles, 'file read')} failed`);
  if (failedFolderReads) parts.push(`${plural(failedFolderReads, 'folder read')} failed`);
  if (warningCount) parts.push(`${plural(warningCount, 'folder warning')}`);
  if (parts.length <= 1 && !sidecars.length && !unsupportedCount && !failedFiles && !failedFolderReads && !warningCount) return '';
  const samples = [
    ...unsupportedSamples(payload, unsupported),
    ...failedFileSamples(payload),
    ...folderReadFailures(payload).map(desktopFolderWarningText).filter(Boolean),
    ...otherFolderWarnings(payload).map(desktopFolderWarningText).filter(Boolean),
  ].slice(0, 3);
  const totalSamples = unsupportedCount + failedFiles + failedFolderReads + warningCount;
  const sampleText = samples.length
    ? ` (${samples.join(', ')}${hiddenSampleText(Math.max(0, totalSamples - samples.length))})`
    : '';
  return `Desktop intake: ${parts.join(', ')}${sampleText}.`;
}

export function unsupportedDesktopSelectionText(payload = {}, unsupported = []) {
  const summary = payload?.folderSummary || null;
  const scannedFiles = Number(summary?.scannedFiles || 0);
  const skippedSamples = (summary?.skippedUnsupportedSamples || [])
    .map(unsupportedSampleText)
    .filter(Boolean);
  const failedSamples = failedFileSamples(payload);
  const skippedCount = Number(summary?.skippedUnsupportedFiles || skippedSamples.length);
  const failedFiles = Number(summary?.failedFiles || failedSamples.length);
  const readFailureRecords = folderReadFailures(payload);
  const failedFolderReads = Number(summary?.failedFolderReads ?? readFailureRecords.length);
  const rawWarningCount = Number(summary?.warningCount ?? payload?.warnings?.length ?? 0);
  const otherWarningCount = Math.max(0, rawWarningCount - failedFolderReads);
  if (skippedCount || failedFiles || failedFolderReads || otherWarningCount) {
    const visibleSkipped = skippedSamples.slice(0, 5);
    const visibleFailed = failedSamples.slice(0, 5);
    const hiddenSkipped = Math.max(0, skippedCount - visibleSkipped.length);
    const hiddenFailed = Math.max(0, failedFiles - visibleFailed.length);
    const skippedMore = hiddenSkipped ? `, plus ${plural(hiddenSkipped, 'more file')}` : '';
    const failedMore = hiddenFailed ? `, plus ${plural(hiddenFailed, 'more file read')}` : '';
    const folderText = sourceFolderText(payload?.sourceFolders || []);
    const scannedText = scannedFiles ? ` after scanning ${plural(scannedFiles, 'file')}` : '';
    const skippedText = visibleSkipped.length
      ? ` Skipped unsupported files: ${visibleSkipped.join(', ')}${skippedMore}.`
      : skippedCount
        ? ` Skipped ${plural(skippedCount, 'unsupported file')}.`
      : '';
    const failedText = visibleFailed.length
      ? ` File read failures: ${visibleFailed.join(', ')}${failedMore}.`
      : failedFiles
        ? ` File read failures: ${plural(failedFiles, 'file read')} failed.`
      : '';
    const readFailureText = readFailureRecords.map(desktopFolderWarningText).filter(Boolean);
    const otherWarningText = otherFolderWarnings(payload).map(desktopFolderWarningText).filter(Boolean);
    const visibleReadFailures = readFailureText.slice(0, 3);
    const visibleWarnings = otherWarningText.slice(0, 3);
    const readFailureTextValue = failedFolderReads
      ? visibleReadFailures.length
        ? ` Folder read failures: ${visibleReadFailures.join(', ')}${hiddenSampleText(Math.max(0, failedFolderReads - visibleReadFailures.length), 'more folder read')}.`
        : ` Folder read failures: ${plural(failedFolderReads, 'folder read')} failed.`
      : '';
    const warningTextValue = otherWarningCount
      ? visibleWarnings.length
        ? ` Folder warnings: ${visibleWarnings.join(', ')}${hiddenSampleText(Math.max(0, otherWarningCount - visibleWarnings.length), 'more warning')}.`
        : ` Folder warnings: ${plural(otherWarningCount, 'warning')} reported.`
      : '';
    return `No supported image, sidecar, or converter-backed files were found${folderText}${scannedText}. ${DESKTOP_UNSUPPORTED_SELECTION_ADVICE}${skippedText}${failedText}${readFailureTextValue}${warningTextValue}`;
  }
  const names = unsupported.map(unsupportedSampleText).filter(Boolean).slice(0, 5);
  const hiddenCount = Math.max(0, unsupported.length - names.length);
  const more = hiddenCount ? `, plus ${plural(hiddenCount, 'more file')}` : '';
  return names.length
    ? `VoxelLab cannot open: ${names.join(', ')}${more}. ${DESKTOP_UNSUPPORTED_SELECTION_ADVICE}`
    : `VoxelLab cannot open this desktop selection. ${DESKTOP_UNSUPPORTED_SELECTION_ADVICE}`;
}
