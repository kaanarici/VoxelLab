// Microscopy sidecar intake for the upload modal: splitting picked/dropped files
// into image files vs. VoxelLab ROI-results JSON, microscopy workflow-recipe JSON,
// and ImageJ `.roi`/ZIP sidecars, then applying each recognized sidecar kind onto
// the active microscopy series. Parser modules (imagej-roi, roi-results,
// microscopy-workflow-recipe, hyperstack controls) load lazily only when matching
// sidecars are present.
import { state } from '../core/state.js';
import { notify } from '../notify.js';
import {
  ROI_RESULTS_BUNDLE_SCHEMA,
  MICROSCOPY_WORKFLOW_RECIPE_SCHEMAS,
} from '../sidecar-schemas.js';
import { isImageJRoiFile, isImageJRoiZipFile, isOmeZarrFile } from '../microscopy/microscopy-file-kinds.js';
import {
  MAX_IMAGEJ_ROI_FILE_INPUT_BYTES,
  MAX_IMAGEJ_ROI_ZIP_INPUT_BYTES,
} from '../microscopy/imagej-roi.js';
import {
  angleEntriesForSlice,
  measurementEntriesForSlice,
  nextDrawingEntryId,
  roiEntriesForSlice,
  setAngleEntriesForSlice,
  setMeasurementEntriesForSlice,
  setRoiEntriesForSlice,
} from '../overlay/annotation-graph.js';
import { syncOverlays } from '../sync.js';
import { drawMeasurements } from '../roi/measure.js';
import { isMicroscopyTiffFile, isVendorMicroscopyFile } from './local-intake-summary.js';

const MICROSCOPY_WORKFLOW_RECIPE_SCHEMA_SET = new Set(MICROSCOPY_WORKFLOW_RECIPE_SCHEMAS);

function isJsonFile(file) {
  return /\.json$/i.test(file?.name || '');
}

const imageJRoiSidecarSkipReason = reason => ({
  unsupported_compression: 'Unsupported ZIP compression; only stored or deflated ImageJ ROI entries are supported',
  unsupported_encryption: 'Encrypted ImageJ ROI ZIP entries are not supported',
  checksum_mismatch: 'ImageJ ROI ZIP entry checksum did not match',
  unsupported_roi: 'Unsupported ImageJ ROI entry',
})[reason] || reason;

function assertImageJRoiSidecarFileSize(file, isZip) {
  const size = Number(file?.size);
  const limit = isZip ? MAX_IMAGEJ_ROI_ZIP_INPUT_BYTES : MAX_IMAGEJ_ROI_FILE_INPUT_BYTES;
  if (Number.isFinite(size) && size > limit) {
    throw new Error(`ImageJ ROI sidecar exceeds the ${limit} byte input budget.`);
  }
}

export async function splitMicroscopySidecars(files) {
  const imageFiles = Array.from(files);
  if (!imageFiles.some(file =>
    isMicroscopyTiffFile(file)
    || isOmeZarrFile(file)
    || isVendorMicroscopyFile(file)
    || isJsonFile(file)
    || isImageJRoiFile(file)
    || isImageJRoiZipFile(file))) {
    return { imageFiles, roiSidecars: [], recipeSidecars: [], imageJRoiSidecars: [], imageJRoiSidecarErrors: [] };
  }
  const roiSidecars = [];
  const recipeSidecars = [];
  const imageJRoiSidecars = [];
  const imageJRoiSidecarErrors = [];
  const kept = [];
  for (const file of imageFiles) {
    if (isJsonFile(file) && typeof file.text === 'function') {
      try {
        const bundle = JSON.parse(await file.text());
        if (bundle?.schema === ROI_RESULTS_BUNDLE_SCHEMA) {
          roiSidecars.push({ name: file.name || 'roi-results.json', bundle });
          continue;
        }
        if (MICROSCOPY_WORKFLOW_RECIPE_SCHEMA_SET.has(bundle?.schema)) {
          recipeSidecars.push({ name: file.name || 'microscopy-workflow.json', recipe: bundle });
          continue;
        }
      } catch {
        // Keep malformed or unrelated JSON in the import set so the mixed-format guard rejects it.
      }
    }
    if ((isImageJRoiFile(file) || isImageJRoiZipFile(file)) && typeof file.arrayBuffer === 'function') {
      try {
        const isZip = isImageJRoiZipFile(file);
        assertImageJRoiSidecarFileSize(file, isZip);
        const { parseImageJRoi, parseImageJRoiZipEntries } = await import('../microscopy/imagej-roi.js');
        const bytes = await file.arrayBuffer();
        if (!isZip && bytes.byteLength > MAX_IMAGEJ_ROI_FILE_INPUT_BYTES) {
          throw new Error(`ImageJ ROI sidecar exceeds the ${MAX_IMAGEJ_ROI_FILE_INPUT_BYTES} byte input budget.`);
        }
        const parsed = isZip
          ? await parseImageJRoiZipEntries(bytes)
          : { rois: [parseImageJRoi(bytes, { name: file.name })], skipped: [] };
        const rois = parsed.rois;
        for (const roi of rois) imageJRoiSidecars.push({ name: roi.name || file.name || 'imagej.roi', roi });
        for (const skipped of parsed.skipped) {
          imageJRoiSidecars.push({
            name: skipped.name || file.name || 'imagej.roi',
            reason: imageJRoiSidecarSkipReason(skipped.reason || ''),
            skipped: true,
          });
        }
        continue;
      } catch (error) {
        imageJRoiSidecarErrors.push({ name: file.name || 'imagej.roi', reason: error?.message || 'unsupported or malformed ImageJ ROI sidecar' });
        continue;
      }
    }
    kept.push(file);
  }
  return { imageFiles: kept, roiSidecars, recipeSidecars, imageJRoiSidecars, imageJRoiSidecarErrors };
}

export async function importRoiSidecarsForActiveSeries(roiSidecars = [], { isActive = () => true } = {}) {
  if (!roiSidecars.length) return { applied: 0, skipped: 0 };
  const {
    activateRoiResultRow,
    importRoiResultsBundle,
    roiResultsImportFailureText,
    renderRoiResults,
    roiResultRows,
  } = await import('../roi/roi-results.js');
  if (!isActive()) return { applied: 0, skipped: 0, stale: true };
  let importedRows = 0;
  let hasPartialImport = false;
  let skipped = 0;
  const skippedMessages = [];
  const skippedDetails = [];
  for (const sidecar of roiSidecars) {
    const result = importRoiResultsBundle(sidecar.bundle, state);
    if (result.ok) {
      importedRows += result.count;
      if (result.reason === 'partial_incompatible_rows') hasPartialImport = true;
    } else {
      skipped += 1;
      const message = roiResultsImportFailureText(result.reason);
      skippedMessages.push(message);
      skippedDetails.push({ name: sidecar.name, reason: message });
    }
  }
  if (importedRows > 0) {
    await activateRoiResultRow(roiResultRows(state)[0], state, { isActive });
    if (!isActive()) return { applied: importedRows, skipped, stale: true };
    renderRoiResults(state);
    const partial = hasPartialImport ? '; skipped incompatible rows' : '';
    notify(`Imported ${importedRows} ROI result row${importedRows === 1 ? '' : 's'}${partial} from VoxelLab sidecar${roiSidecars.length === 1 ? '' : 's'}.`);
  }
  if (skipped > 0) {
    notify(`Skipped ${skipped} ROI sidecar${skipped === 1 ? '' : 's'}${sidecarSkipDetailsText(skippedDetails, skipped, ' that did not match the imported series.')}`);
  }
  return { applied: importedRows, skipped, skippedMessages, skippedDetails };
}

function sidecarSkipSampleText(item = {}) {
  const name = String(item.name || '').trim();
  const reason = String(item.reason || '').trim().replace(/[.。]+$/, '');
  if (!name) return '';
  return reason ? `${name} (${reason})` : name;
}

export function sidecarSkipDetailsText(details = [], skipped = details.length, fallback = '.') {
  const samples = details
    .map(sidecarSkipSampleText)
    .filter(Boolean)
    .slice(0, 3);
  if (!samples.length) return fallback;
  const hiddenCount = Math.max(0, skipped - samples.length);
  const more = hiddenCount ? `, plus ${hiddenCount} more file${hiddenCount === 1 ? '' : 's'}` : '';
  return `: ${samples.join(', ')}${more}.`;
}

export function microscopySidecarRecords({ roiSidecars = [], recipeSidecars = [], imageJRoiSidecars = [], imageJRoiSidecarErrors = [] } = {}) {
  return [...roiSidecars, ...recipeSidecars, ...imageJRoiSidecars, ...imageJRoiSidecarErrors]
    .map(sidecar => ({ name: sidecar.name || sidecar.roi?.name || 'microscopy sidecar' }));
}

export function unsupportedImageJRoiSidecarText(imageJRoiSidecarErrors = []) {
  const details = sidecarSkipDetailsText(imageJRoiSidecarErrors, imageJRoiSidecarErrors.length);
  return `Unsupported ImageJ ROI sidecar${imageJRoiSidecarErrors.length === 1 ? '' : 's'}${details} Supported ImageJ sidecars are rect, oval, straight-line, open PolyLine, angle, polygon/freehand, traced, and point ROI .roi files or unencrypted, checksummed stored/deflated ZIP archives.`;
}

export function skippedDerivedObjectsText(skipped = []) {
  const samples = skipped
    .map(item => `${item.modality || 'Derived object'}: ${item.reason || 'unsupported or incompatible with the loaded source series'}`)
    .slice(0, 3);
  const more = skipped.length > samples.length ? `, plus ${skipped.length - samples.length} more` : '';
  return `Skipped ${skipped.length} derived object${skipped.length === 1 ? '' : 's'}: ${samples.join('; ')}${more}.`;
}

export async function importImageJRoiSidecarsForActiveSeries(imageJRoiSidecars = [], { isActive = () => true } = {}) {
  if (!imageJRoiSidecars.length) return { applied: 0, skipped: 0 };
  const { imageJRoiToAnnotation } = await import('../microscopy/imagej-roi.js');
  const { renderRoiResults } = await import('../roi/roi-results.js');
  if (!isActive()) return { applied: 0, skipped: 0, stale: true };
  const series = state.manifest?.series?.[state.seriesIdx];
  if (!series?.slug) return { applied: 0, skipped: imageJRoiSidecars.length };
  let imported = 0;
  let skipped = 0;
  const skippedDetails = [];
  const touchedCurrentSlice = new Set();
  let importedRoi = 0;
  for (const sidecar of imageJRoiSidecars) {
    if (sidecar.skipped) {
      skipped += 1;
      skippedDetails.push({ name: sidecar.name, reason: sidecar.reason });
      continue;
    }
    const converted = imageJRoiToAnnotation(sidecar.roi, series, state.sliceIdx);
    if (!converted) {
      skipped += 1;
      skippedDetails.push({ name: sidecar.roi?.name || sidecar.name, reason: 'did not fit active series' });
      continue;
    }
    if (converted.kind === 'line') {
      const list = measurementEntriesForSlice(state, series, converted.sliceIdx);
      converted.entry.id = nextDrawingEntryId(list);
      setMeasurementEntriesForSlice(state, series, converted.sliceIdx, list.concat(converted.entry));
    } else if (converted.kind === 'angle') {
      const list = angleEntriesForSlice(state, series, converted.sliceIdx);
      converted.entry.id = nextDrawingEntryId(list);
      setAngleEntriesForSlice(state, series, converted.sliceIdx, list.concat(converted.entry));
    } else {
      const list = roiEntriesForSlice(state, series, converted.sliceIdx);
      converted.entry.id = nextDrawingEntryId(list);
      setRoiEntriesForSlice(state, series, converted.sliceIdx, list.concat(converted.entry));
      importedRoi += 1;
    }
    imported += 1;
    if (converted.sliceIdx === state.sliceIdx) touchedCurrentSlice.add(converted.sliceIdx);
  }
  if (touchedCurrentSlice.size && importedRoi > 0) {
    const { refreshROIStatsHere } = await import('../roi.js');
    if (!isActive()) return { applied: imported, skipped, skippedDetails, stale: true };
    refreshROIStatsHere();
  }
  if (!isActive()) return { applied: imported, skipped, skippedDetails, stale: true };
  renderRoiResults(state);
  drawMeasurements();
  syncOverlays();
  if (imported > 0) notify(`Imported ${imported} ImageJ ROI${imported === 1 ? '' : 's'} onto the active microscopy series.`);
  if (skipped > 0) {
    notify(`Skipped ${skipped} ImageJ ROI ${skipped === 1 ? 'entry' : 'entries'}${sidecarSkipDetailsText(skippedDetails, skipped, ' that were unsupported or did not fit the active series.')}`);
  }
  return { applied: imported, skipped, skippedDetails };
}

export async function applyRecipeSidecarsForActiveSeries(recipeSidecars = [], { isActive = () => true } = {}) {
  if (!recipeSidecars.length) return { applied: 0, skipped: 0 };
  const {
    renderMicroscopyHyperstackControls,
    setMicroscopyWorkflowStatus,
  } = await import('../microscopy/microscopy-hyperstack-controls.js');
  const { applyMicroscopyWorkflowRecipe } = await import('../microscopy/microscopy-workflow-recipe.js');
  const { renderRoiResults } = await import('../roi/roi-results.js');
  if (!isActive()) return { applied: 0, skipped: 0, stale: true };
  let replayed = 0;
  let skipped = 0;
  const skippedMessages = [];
  const skippedDetails = [];
  for (const sidecar of recipeSidecars) {
    const result = applyMicroscopyWorkflowRecipe(sidecar.recipe, state);
    if (result.ok) replayed += 1;
    else {
      skipped += 1;
      if (result.message) {
        skippedMessages.push(result.message);
        skippedDetails.push({ name: sidecar.name, reason: result.message });
      }
    }
  }
  const firstSkippedReason = skippedMessages[0] || '';
  if (replayed > 0 && skipped > 0) {
    setMicroscopyWorkflowStatus(`Workflow recipe replayed; skipped ${skipped}${firstSkippedReason ? `: ${firstSkippedReason}` : ''}`);
  } else if (replayed > 0) {
    setMicroscopyWorkflowStatus('Workflow recipe replayed');
  } else if (skipped > 0) {
    setMicroscopyWorkflowStatus(firstSkippedReason || 'Workflow recipe did not match the active microscopy series');
  }
  renderMicroscopyHyperstackControls(state);
  renderRoiResults(state);
  drawMeasurements();
  syncOverlays();
  if (replayed > 0) {
    notify(`Replayed ${replayed} microscopy workflow recipe${replayed === 1 ? '' : 's'} from VoxelLab sidecar${recipeSidecars.length === 1 ? '' : 's'}.`);
  }
  if (skipped > 0) {
    notify(`Skipped ${skipped} microscopy workflow recipe${skipped === 1 ? '' : 's'}${sidecarSkipDetailsText(skippedDetails, skipped, ' that did not match the imported series.')}`);
  }
  return { applied: replayed, skipped, skippedMessages, skippedDetails };
}
