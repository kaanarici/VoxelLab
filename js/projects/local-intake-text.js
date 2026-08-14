import { desktopFolderWarningSummaryText, desktopFolderWarningText } from '../desktop-intake-text.js';
import { appendIntakeFormatSummary, intakeFormatLabel } from '../intake-format-summary.js';
import { sidecarUnsupportedDescription } from '../sidecar-schemas.js';

const MAX_LOCAL_INTAKE_SAMPLES = 5;
const NO_LOCAL_INTAKE_MATCH_TEXT = 'No supported image, sidecar, or converter-backed files selected';
export const NO_LOCAL_INTAKE_MATCH_ADVICE = 'Try DICOM, NIfTI, OME-TIFF/ImageJ TIFF, TIFF sequences, limited OME-Zarr, matching sidecars, or converter-backed microscopy files';

export function localFilePath(file = {}) {
  return String(file.webkitRelativePath || file.path || file.name || '').replaceAll('\\', '/');
}

export function microscopyConversionErrorText(fileName, reason = '') {
  const name = String(fileName || 'microscopy file');
  const guidance = {
    converter_not_configured: 'configure VOXELLAB_BFCONVERT with an external OME-TIFF converter',
    converter_path_not_absolute: 'VOXELLAB_BFCONVERT must be an absolute executable path',
    converter_path_missing: 'VOXELLAB_BFCONVERT points to a missing executable',
    converter_path_not_executable: 'VOXELLAB_BFCONVERT must point to an executable file',
    optional_python_reader_missing: 'install the optional microscopy readers or configure VOXELLAB_BFCONVERT',
    external_process_failure: 'the external converter failed; check the local server log for details',
    unsupported_format: 'the selected microscopy format is not supported by the configured converter path',
  }[String(reason || '')] || 'the local microscopy converter could not process it';
  return `Could not convert ${name}: ${guidance}.`;
}

function localIntakeCountParts(counts, formatItems = {}) {
  const parts = [];
  if (counts.openable) parts.push(appendIntakeFormatSummary(`${counts.openable} openable file${counts.openable === 1 ? '' : 's'}`, formatItems.openable));
  if (counts.convertible) parts.push(appendIntakeFormatSummary(`${counts.convertible} converter-backed file${counts.convertible === 1 ? '' : 's'}`, formatItems.convertible));
  if (counts.sidecar) parts.push(appendIntakeFormatSummary(`${counts.sidecar} sidecar${counts.sidecar === 1 ? '' : 's'}`, formatItems.sidecar));
  return parts;
}

export function localIntakeSummaryText(intakeOrCounts) {
  const counts = intakeOrCounts?.counts || intakeOrCounts || {};
  const formatItems = intakeOrCounts?.formatItems || {};
  const parts = localIntakeCountParts(counts, formatItems);
  if (!parts.length) return 'no supported files';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

function localIntakeSkippedSamplesText(skipped, total = skipped.length) {
  const samples = skipped
    .map((file) => {
      const name = localFilePath(file).split('/').filter(Boolean).slice(-2).join('/') || file.name || 'unsupported file';
      const reason = sidecarUnsupportedDescription(file);
      return reason ? `${name} (${reason})` : name;
    })
    .slice(0, MAX_LOCAL_INTAKE_SAMPLES);
  const moreCount = Math.max(0, total - samples.length);
  const more = moreCount ? `, plus ${moreCount} more file${moreCount === 1 ? '' : 's'}` : '';
  return samples.length ? ` (${samples.join(', ')}${more})` : '';
}

function localIntakeSampleNames(items = [], maxSamples = 3) {
  const values = Array.from(items || []);
  const samples = values
    .map(file => localFilePath(file).split('/').filter(Boolean).slice(-2).join('/') || file.name || '')
    .filter(Boolean)
    .slice(0, maxSamples);
  const moreCount = Math.max(0, values.length - samples.length);
  const more = moreCount ? `, plus ${moreCount} more file${moreCount === 1 ? '' : 's'}` : '';
  return samples.length ? samples.join(', ') + more : '';
}

function nativeImageFamily(item = {}) {
  const label = intakeFormatLabel(item);
  if (label === 'NIfTI') return 'NIfTI';
  if (label === 'OME-TIFF' || label === 'TIFF/ImageJ TIFF') return 'microscopy TIFF';
  if (label === 'OME-Zarr') return 'OME-Zarr';
  return 'DICOM or derived-object';
}

export function mixedNativeImportBoundaryText(files = []) {
  const groups = new Map();
  for (const file of files || []) {
    const family = nativeImageFamily(file);
    groups.set(family, (groups.get(family) || []).concat(file));
  }
  const parts = [...groups.entries()].map(([family, familyFiles]) => {
    const samples = localIntakeSampleNames(familyFiles);
    const sampleText = samples ? ` (${samples})` : '';
    return `${familyFiles.length} ${family} file${familyFiles.length === 1 ? '' : 's'}${sampleText}`;
  });
  const selected = parts.length > 1
    ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
    : parts[0] || 'mixed native image files';
  return `Mixed native image families need separate imports for now. Selected openable families: ${selected}. Open one family at a time so calibration, sidecars, and geometry stay tied to the right source data.`;
}

function localIntakeCheckedText(intake) {
  const checkedFiles = Number(intake?.checkedFiles || 0);
  return checkedFiles ? `checked ${checkedFiles} file${checkedFiles === 1 ? '' : 's'}` : '';
}

function localImportSelectedText(intake) {
  const counts = intake?.counts || null;
  if (!counts) return '';
  const total = Number(counts.openable || 0) + Number(counts.convertible || 0) + Number(counts.sidecar || 0);
  return total ? `selected ${localIntakeSummaryText(intake)}` : '';
}

function converterBackedAdvice(counts = {}, formatItems = {}) {
  if (!counts.convertible) return '';
  const hasOtherSelectedKind = Number(counts.openable || 0) || Number(counts.sidecar || 0);
  const advice = hasOtherSelectedKind
    ? 'converter-backed files need configured local readers or an OME-TIFF converter and should be opened separately'
    : 'converter-backed files need configured local readers or an OME-TIFF converter';
  const samples = localIntakeSampleNames(formatItems.convertible || []);
  return samples ? `${advice}: ${samples}` : advice;
}

export function localImportFileContext(files) {
  const total = Array.from(files || []).length;
  const samples = localIntakeSampleNames(files);
  return samples ? ` Selected file${total === 1 ? '' : 's'}: ${samples}.` : '';
}

export function localImportFailedContext(files) {
  const attempted = Array.from(files || []);
  const samples = attempted
    .map(file => localFilePath(file).split('/').filter(Boolean).slice(-2).join('/') || file.name || 'attempted file')
    .filter(Boolean)
    .slice(0, MAX_LOCAL_INTAKE_SAMPLES);
  if (!samples.length) return '';
  const hiddenCount = Math.max(0, attempted.length - samples.length);
  const more = hiddenCount ? `, plus ${hiddenCount} more file${hiddenCount === 1 ? '' : 's'}` : '';
  return ` Failed ${attempted.length} attempted file${attempted.length === 1 ? '' : 's'}: ${samples.join(', ')}${more}.`;
}

function folderReadFailureWarnings(warnings = []) {
  return warnings.filter(item => String(item?.reason || '') === 'folder_read_failed');
}

function localImportFolderReadFailureText(intake = {}) {
  const failures = folderReadFailureWarnings(intake.warnings || []);
  const count = Number(intake.failedFolderReads ?? failures.length);
  if (!count) return '';
  const samples = failures.map(desktopFolderWarningText).filter(Boolean).slice(0, MAX_LOCAL_INTAKE_SAMPLES);
  const hiddenCount = Math.max(0, count - samples.length);
  const more = hiddenCount ? `, plus ${hiddenCount} more folder read${hiddenCount === 1 ? '' : 's'}` : '';
  const sampleText = samples.length ? ` (${samples.join(', ')}${more})` : '';
  return `${count} folder read${count === 1 ? '' : 's'} failed${sampleText}`;
}

function localImportFileReadFailureText(intake = {}) {
  const failures = Array.from(intake.failedFileSamples || []);
  const count = Number(intake.failedFiles ?? failures.length);
  if (!count) return '';
  const samples = failures
    .map(file => {
      const name = localFilePath(file).split('/').filter(Boolean).slice(-2).join('/') || file.name || 'file';
      const reason = sidecarUnsupportedDescription(file);
      return reason ? `${name} (${reason})` : name;
    })
    .slice(0, MAX_LOCAL_INTAKE_SAMPLES);
  const hiddenCount = Math.max(0, count - samples.length);
  const more = hiddenCount ? `, plus ${hiddenCount} more file read${hiddenCount === 1 ? '' : 's'}` : '';
  const sampleText = samples.length ? ` (${samples.join(', ')}${more})` : '';
  return `${count} file read${count === 1 ? '' : 's'} failed${sampleText}`;
}

function localImportFolderWarningText(intake = {}) {
  const failedFolderReads = Number(intake.failedFolderReads ?? folderReadFailureWarnings(intake.warnings || []).length);
  const warnings = (intake.warnings || []).filter(item => String(item?.reason || '') !== 'folder_read_failed');
  const warningCount = Math.max(
    0,
    intake.warningCount == null
      ? warnings.length
      : Number(intake.warningCount) - failedFolderReads,
  );
  return desktopFolderWarningSummaryText(warnings, warningCount, MAX_LOCAL_INTAKE_SAMPLES);
}

export function localImportIntakeContext(intake) {
  if (!intake) return '';
  const checkedText = localIntakeCheckedText(intake);
  const skipped = intake.skipped || [];
  const skippedCount = Number(intake.skippedCount ?? skipped.length);
  const skippedText = skippedCount
    ? `; skipped ${skippedCount} unsupported file${skippedCount === 1 ? '' : 's'}${localIntakeSkippedSamplesText(skipped, skippedCount)}`
    : '';
  const selectedText = localImportSelectedText(intake);
  const converterText = converterBackedAdvice(intake.counts, intake.formatItems || {});
  const failedFileText = localImportFileReadFailureText(intake);
  const failedFolderText = localImportFolderReadFailureText(intake);
  const warningText = localImportFolderWarningText(intake);
  if (!checkedText && !selectedText && !skippedText && !failedFileText && !failedFolderText && !warningText) return '';
  return ` Intake: ${[checkedText, selectedText, converterText, skippedText.replace(/^; /, ''), failedFileText, failedFolderText, warningText].filter(Boolean).join('; ')}.`;
}

export function localImportErrorMessage(error, files, intake = null) {
  return `${error?.message || 'Import failed.'}${localImportFileContext(files)}${localImportIntakeContext(intake)}`;
}

export function localIntakeStatusText(intake) {
  const summary = localIntakeSummaryText(intake);
  const checkedText = localIntakeCheckedText(intake);
  const afterChecking = checkedText ? ` after ${checkedText.replace(/^checked/, 'checking')}` : '';
  const skippedCount = Number(intake.skippedCount ?? intake.skipped.length);
  const failedFileText = localImportFileReadFailureText(intake);
  const failedFolderText = localImportFolderReadFailureText(intake);
  const warningText = localImportFolderWarningText(intake);
  const issueText = [failedFileText, failedFolderText, warningText].filter(Boolean).join('; ');
  const issues = issueText ? `; ${issueText}` : '';
  if (!intake.files.length) {
    const noMatchText = `${NO_LOCAL_INTAKE_MATCH_TEXT}${afterChecking}. ${NO_LOCAL_INTAKE_MATCH_ADVICE}`;
    return skippedCount
      ? `${noMatchText}; skipped ${skippedCount} unsupported file${skippedCount === 1 ? '' : 's'}${localIntakeSkippedSamplesText(intake.skipped, skippedCount)}${issues}`
      : `${noMatchText}${issues}`;
  }
  const skippedText = skippedCount
    ? `; skipped ${skippedCount} unsupported file${skippedCount === 1 ? '' : 's'}${localIntakeSkippedSamplesText(intake.skipped, skippedCount)}`
    : '';
  const converterAdvice = converterBackedAdvice(intake.counts, intake.formatItems || {});
  const converterText = converterAdvice ? `; ${converterAdvice}` : '';
  return `${summary} selected${afterChecking}${skippedText}${converterText}${issues}`;
}

export function localIntakeNotice(counts, skipped, checkedFiles = 0, formatItems = {}, skippedCount = skipped.length) {
  const totalSkipped = Number(skippedCount || 0);
  const skippedText = totalSkipped
    ? `; skipped ${totalSkipped} unsupported file${totalSkipped === 1 ? '' : 's'}${localIntakeSkippedSamplesText(skipped, totalSkipped)}`
    : '';
  const checkedText = checkedFiles ? `; checked ${checkedFiles} file${checkedFiles === 1 ? '' : 's'}` : '';
  const converterAdvice = converterBackedAdvice(counts, formatItems);
  const converterText = converterAdvice ? ` ${converterAdvice[0].toUpperCase()}${converterAdvice.slice(1)}.` : '';
  return `Local intake: ${localIntakeSummaryText({ counts, formatItems })}${skippedText}${checkedText}.${converterText}`;
}
