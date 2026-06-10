// "Open a study" modal: local DICOM/NIfTI parse or cloud pipeline.
import { state, HAS_LOCAL_BACKEND } from '../core/state.js';
import { localApiHeaders } from '../config.js';
import { $, escapeHtml, openModal, closeModal } from '../dom.js';
import { ensureTemplate } from '../template-loader.js';
import {
  collectDroppedFiles,
  filterLocalFiles,
  MAX_LOCAL_FILE_SELECTION_FILES,
} from '../file-drop.js';
import { isImageJRoiFile, isImageJRoiZipFile, isOmeZarrFile } from '../microscopy/microscopy-file-kinds.js';
import { desktopMicroscopySidecarOnlyText } from '../desktop-intake-text.js';
import { registerProjectionSet } from '../series/series-contract.js';
import {
  MICROSCOPY_WORKFLOW_RECIPE_SCHEMAS,
  ROI_RESULTS_BUNDLE_SCHEMA,
  UNRECOGNIZED_JSON_SIDECAR_REASON,
  sidecarUnsupportedDescription,
} from '../sidecar-schemas.js';
import { isDerivedObjectModality } from '../dicom/dicom-import-routing.js';
import { isCloudAvailable, uploadAndProcess } from '../cloud.js';
import { notify } from '../notify.js';
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
import { enableRegionsIfAvailable } from '../core/state/viewer-commands.js';
import { renderFormatCapabilityMatrix } from '../format-capability-matrix.js';
import { drawMeasurements } from '../roi/measure.js';
import {
  localFilePath,
  localImportErrorMessage,
  localImportFailedContext,
  localImportIntakeContext,
  localIntakeStatusText,
  mixedNativeImportBoundaryText,
} from './local-intake-text.js';
import {
  isMicroscopyTiffFile,
  isNiftiFile,
  isVendorMicroscopyFile,
  LOCAL_VENDOR_MICROSCOPY_ACCEPT,
  LOCAL_VENDOR_MICROSCOPY_LABEL,
  LOCAL_VENDOR_MICROSCOPY_RE,
  summarizeLocalIntake,
} from './local-intake-summary.js';

const MICROSCOPY_WORKFLOW_RECIPE_SCHEMA_SET = new Set(MICROSCOPY_WORKFLOW_RECIPE_SCHEMAS);

function setUploadStatus(statusEl, message, tone = 'muted', { html = false } = {}) {
  statusEl.className = `upload-status${tone === 'muted' ? '' : ` is-${tone}`}`;
  if (html) statusEl.innerHTML = message;
  else statusEl.textContent = message;
}

async function convertVendorMicroscopyFile(file) {
  let res;
  try {
    res = await fetch(`/api/microscopy/convert?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: localApiHeaders(),
      body: file,
    });
  } catch (error) {
    throw new Error(`Could not convert ${file.name}: ${error?.message || 'converter request failed'}`);
  }
  if (!res.ok) {
    let message = `Could not convert ${file.name}.`;
    try {
      const err = await res.json();
      if (err?.error) message = `Could not convert ${file.name}: ${err.error}`;
    } catch {
      // non-JSON error body
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const baseName = (file.name || 'image').replace(LOCAL_VENDOR_MICROSCOPY_RE, '');
  return new File([blob], `${baseName}.ome.tiff`, { type: 'image/tiff' });
}

function fileSampleNames(files = [], maxSamples = 3) {
  const samples = Array.from(files || [])
    .map(file => localFilePath(file).split('/').filter(Boolean).slice(-2).join('/') || file?.name || '')
    .filter(Boolean)
    .slice(0, maxSamples);
  const hiddenCount = Math.max(0, files.length - samples.length);
  const more = hiddenCount ? `, plus ${hiddenCount} more file${hiddenCount === 1 ? '' : 's'}` : '';
  return samples.length ? `${samples.join(', ')}${more}` : '';
}

function isJsonFile(file) {
  return /\.json$/i.test(file?.name || '');
}

function isDicomSrFile(file) {
  return /\.sr$/i.test(file?.name || '');
}

function blockingMicroscopyJsonSidecars(intake = {}) {
  return (intake.skipped || []).filter(file =>
    file?.skipReason === UNRECOGNIZED_JSON_SIDECAR_REASON && file?.schema
  );
}

function blockingMicroscopyJsonSidecarText(sidecars = []) {
  const samples = sidecars
    .map((file) => {
      const name = localFilePath(file).split('/').filter(Boolean).slice(-2).join('/') || file?.name || 'JSON sidecar';
      const reason = sidecarUnsupportedDescription(file);
      return reason ? `${name} (${reason})` : name;
    })
    .slice(0, 3);
  const hiddenCount = Math.max(0, sidecars.length - samples.length);
  const more = hiddenCount ? `, plus ${hiddenCount} more file${hiddenCount === 1 ? '' : 's'}` : '';
  return `Remove unsupported JSON sidecar${sidecars.length === 1 ? '' : 's'} before importing microscopy TIFF: ${samples.join(', ')}${more}. VoxelLab only applies recognized ROI-results or workflow-recipe JSON sidecars.`;
}

const imageJRoiSidecarSkipReason = reason => ({ unsupported_compression: 'Unsupported ZIP compression; only stored or deflated ImageJ ROI entries are supported', unsupported_roi: 'Unsupported ImageJ ROI entry' })[reason] || reason;

async function splitMicroscopySidecars(files) {
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
        const { parseImageJRoi, parseImageJRoiZipEntries } = await import('../microscopy/imagej-roi.js');
        const bytes = await file.arrayBuffer();
        const parsed = isImageJRoiZipFile(file)
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

async function importRoiSidecarsForActiveSeries(roiSidecars = []) {
  if (!roiSidecars.length) return { applied: 0, skipped: 0 };
  const {
    activateRoiResultRow,
    importRoiResultsBundle,
    roiResultsImportFailureText,
    renderRoiResults,
    roiResultRows,
  } = await import('../roi/roi-results.js');
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
    await activateRoiResultRow(roiResultRows(state)[0], state);
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

function sidecarSkipDetailsText(details = [], skipped = details.length, fallback = '.') {
  const samples = details
    .map(sidecarSkipSampleText)
    .filter(Boolean)
    .slice(0, 3);
  if (!samples.length) return fallback;
  const hiddenCount = Math.max(0, skipped - samples.length);
  const more = hiddenCount ? `, plus ${hiddenCount} more file${hiddenCount === 1 ? '' : 's'}` : '';
  return `: ${samples.join(', ')}${more}.`;
}

function microscopySidecarRecords({ roiSidecars = [], recipeSidecars = [], imageJRoiSidecars = [], imageJRoiSidecarErrors = [] } = {}) {
  return [...roiSidecars, ...recipeSidecars, ...imageJRoiSidecars, ...imageJRoiSidecarErrors]
    .map(sidecar => ({ name: sidecar.name || sidecar.roi?.name || 'microscopy sidecar' }));
}

function unsupportedImageJRoiSidecarText(imageJRoiSidecarErrors = []) {
  const details = sidecarSkipDetailsText(imageJRoiSidecarErrors, imageJRoiSidecarErrors.length);
  return `Unsupported ImageJ ROI sidecar${imageJRoiSidecarErrors.length === 1 ? '' : 's'}${details} Supported ImageJ sidecars are rect, oval, straight-line, angle, polygon/freehand, traced, and point ROI .roi files or stored/deflated ZIP archives.`;
}

function skippedDerivedObjectsText(skipped = []) {
  const samples = skipped
    .map(item => `${item.modality || 'Derived object'}: ${item.reason || 'unsupported or incompatible with the loaded source series'}`)
    .slice(0, 3);
  const more = skipped.length > samples.length ? `, plus ${skipped.length - samples.length} more` : '';
  return `Skipped ${skipped.length} derived object${skipped.length === 1 ? '' : 's'}: ${samples.join('; ')}${more}.`;
}

async function importImageJRoiSidecarsForActiveSeries(imageJRoiSidecars = []) {
  if (!imageJRoiSidecars.length) return { applied: 0, skipped: 0 };
  const { imageJRoiToAnnotation } = await import('../microscopy/imagej-roi.js');
  const { renderRoiResults } = await import('../roi/roi-results.js');
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
      const list = measurementEntriesForSlice(state, series.slug, converted.sliceIdx);
      converted.entry.id = nextDrawingEntryId(list);
      setMeasurementEntriesForSlice(state, series.slug, converted.sliceIdx, list.concat(converted.entry));
    } else if (converted.kind === 'angle') {
      const list = angleEntriesForSlice(state, series.slug, converted.sliceIdx);
      converted.entry.id = nextDrawingEntryId(list);
      setAngleEntriesForSlice(state, series.slug, converted.sliceIdx, list.concat(converted.entry));
    } else {
      const list = roiEntriesForSlice(series.slug, converted.sliceIdx);
      converted.entry.id = nextDrawingEntryId(list);
      setRoiEntriesForSlice(series.slug, converted.sliceIdx, list.concat(converted.entry));
      importedRoi += 1;
    }
    imported += 1;
    if (converted.sliceIdx === state.sliceIdx) touchedCurrentSlice.add(converted.sliceIdx);
  }
  if (touchedCurrentSlice.size && importedRoi > 0) {
    const { refreshROIStatsHere } = await import('../roi.js');
    refreshROIStatsHere();
  }
  renderRoiResults(state);
  drawMeasurements();
  syncOverlays();
  if (imported > 0) notify(`Imported ${imported} ImageJ ROI${imported === 1 ? '' : 's'} onto the active microscopy series.`);
  if (skipped > 0) {
    notify(`Skipped ${skipped} ImageJ ROI ${skipped === 1 ? 'entry' : 'entries'}${sidecarSkipDetailsText(skippedDetails, skipped, ' that were unsupported or did not fit the active series.')}`);
  }
  return { applied: imported, skipped, skippedDetails };
}

async function applyRecipeSidecarsForActiveSeries(recipeSidecars = []) {
  if (!recipeSidecars.length) return { applied: 0, skipped: 0 };
  const {
    renderMicroscopyHyperstackControls,
    setMicroscopyWorkflowStatus,
  } = await import('../microscopy/microscopy-hyperstack-controls.js');
  const { applyMicroscopyWorkflowRecipe } = await import('../microscopy/microscopy-workflow-recipe.js');
  const { renderRoiResults } = await import('../roi/roi-results.js');
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

export async function showStudyUploadModal(selectSeries) {
  await ensureTemplate('./templates/upload-modal.html', 'modal-root', 'upload-modal');
  const modal = $('upload-modal');
  const body = $('upload-body');
  openModal('upload-modal');

  const cloudAvail = isCloudAvailable();
  body.innerHTML = `
    <div class="ask-a">
      <label class="upload-zone" id="upload-zone">
        <input type="file" id="upload-file-input" multiple
          accept=".dcm,.sr,.nii,.nii.gz,.tif,.tiff,.ome.tif,.ome.tiff,${LOCAL_VENDOR_MICROSCOPY_ACCEPT},.zattrs,.zarray,.zgroup,.zmetadata,.json,.roi,.zip,application/dicom,image/tiff,application/json" class="upload-file-input" />
        <input type="file" id="upload-folder-input" multiple webkitdirectory class="upload-file-input" />
        <svg class="upload-zone-icon"><use href="icons.svg#i-upload"/></svg>
        <span class="upload-zone-title">Drop images, sidecars, or converter-backed files here</span>
        <span class="upload-zone-subtitle">or click to browse files</span>
      </label>
      <div class="upload-actions upload-copy-spaced">
        <button class="btn upload-action" id="upload-folder-btn" type="button">Browse folder</button>
      </div>
      <div id="upload-status" class="upload-status"></div>
      <div class="upload-section">
        <div class="upload-section-title">Open from DICOMweb (WADO-RS)</div>
        <div class="upload-grid">
          <input id="dicomweb-base" class="select-like upload-field" placeholder="WADO-RS base URL" />
          <input id="dicomweb-query" class="select-like upload-field" placeholder="QIDO query (optional, e.g. DOE*)" />
          <input id="dicomweb-study" class="select-like upload-field" placeholder="Study UID" />
          <input id="dicomweb-series" class="select-like upload-field" placeholder="Series UID" />
          <input id="dicomweb-token" class="select-like upload-field" placeholder="Bearer token (optional)" />
          <div class="upload-actions">
            <button class="btn upload-action" id="dicomweb-find-studies-btn">Find studies</button>
            <button class="btn upload-action" id="dicomweb-find-series-btn">Find series</button>
          </div>
          <button class="btn" id="upload-dicomweb-btn">Import DICOMweb series</button>
          <div class="upload-copy">
            Uses the same geometry and capability checks as local import. SEG, RTSTRUCT, and lightweight SR series bind to an already loaded source series in this session. DICOMweb session cache is in-memory and reused while this modal stays open.
          </div>
        </div>
      </div>
      ${cloudAvail ? `
        <div class="upload-actions upload-copy-spaced">
          <button class="btn upload-action" id="upload-local-btn">View locally</button>
          <button class="btn upload-action" id="upload-cloud-btn">Process CT/MR on cloud GPU</button>
        </div>
        <div class="upload-copy upload-copy-tight">
          <b>View locally</b>: instant preview in your browser, no upload needed.<br>
          Calibrated OME-TIFF/ImageJ stacks use micrometer measurements; generic TIFF sequences stay uncalibrated.<br>
          <b>Cloud GPU</b>: uploads supported CT/MR volume stacks to R2, then runs segmentation + parcellation.<br>
          Projection sets stay 2D until a calibrated reconstruction engine emits a derived volume.
        </div>
      ` : `
        <div class="upload-copy upload-copy-spaced">
          Files are parsed entirely in your browser. Nothing is uploaded.
          Calibrated OME-TIFF/ImageJ stacks use micrometer measurements; generic TIFF sequences stay uncalibrated.
          Projection sets stay 2D until a calibrated reconstruction engine emits a derived volume.
        </div>
      `}
      ${renderFormatCapabilityMatrix()}
    </div>
  `;

  const zone = $('upload-zone');
  const input = $('upload-file-input');
  const folderInput = $('upload-folder-input');
  const folderBtn = $('upload-folder-btn');
  const statusEl = $('upload-status');
  const dicomwebState = { sessionId: '', studies: [], series: [] };
  let selectedFiles = null;
  let selectedIntake = null;
  let busy = false;

  const setBusy = (nextBusy) => {
    busy = nextBusy;
    zone.style.pointerEvents = nextBusy ? 'none' : '';
    if (input) input.disabled = nextBusy;
    if (folderInput) folderInput.disabled = nextBusy;
    if (folderBtn) folderBtn.disabled = nextBusy;
    if (localBtn) localBtn.disabled = nextBusy;
    if (cloudBtn) cloudBtn.disabled = nextBusy;
    if (dicomwebBtn) dicomwebBtn.disabled = nextBusy;
    if (findStudiesBtn) findStudiesBtn.disabled = nextBusy;
    if (findSeriesBtn) findSeriesBtn.disabled = nextBusy;
  };

  zone.addEventListener('click', (e) => {
    if (busy) return;
    if (e.target === input) return;
    input.click();
  });
  folderBtn?.addEventListener('click', () => {
    if (!busy) folderInput?.click();
  });
  const useSelectedFiles = async (files) => {
    let intake;
    try {
      intake = await summarizeLocalIntake(filterLocalFiles(files, { maxFiles: MAX_LOCAL_FILE_SELECTION_FILES }));
      selectedFiles = intake.files;
      selectedIntake = intake;
      if (intake.message) notify(intake.message, { id: 'local-intake', duration: 9000 });
    } catch (error) {
      selectedFiles = null;
      selectedIntake = null;
      setUploadStatus(statusEl, `Error: ${escapeHtml(error.message)}`, 'error', { html: true });
      return;
    }
    const count = selectedFiles.length;
    setUploadStatus(statusEl, localIntakeStatusText(intake), count ? 'active' : 'error');
    if (!cloudAvail && count) handleLocalImport(selectedFiles, statusEl, modal, selectSeries, setBusy, { intake });
  };
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', async (e) => {
    if (busy) return;
    e.preventDefault();
    zone.classList.remove('drag');
    try {
      await useSelectedFiles(await collectDroppedFiles(e.dataTransfer));
    } catch (error) {
      setUploadStatus(statusEl, `Error: ${escapeHtml(error.message)}`, 'error', { html: true });
    }
  });
  input.addEventListener('change', async () => {
    if (busy) return;
    await useSelectedFiles(input.files);
  });
  folderInput?.addEventListener('change', async () => {
    if (busy) return;
    await useSelectedFiles(folderInput.files);
  });

  const localBtn = $('upload-local-btn');
  const cloudBtn = $('upload-cloud-btn');
  const dicomwebBtn = $('upload-dicomweb-btn');
  const findStudiesBtn = $('dicomweb-find-studies-btn');
  const findSeriesBtn = $('dicomweb-find-series-btn');
  if (localBtn) {
    localBtn.onclick = () => {
      if (!selectedFiles || !selectedFiles.length) {
        setUploadStatus(statusEl, 'Select files first');
        return;
      }
      handleLocalImport(selectedFiles, statusEl, modal, selectSeries, setBusy, { intake: selectedIntake });
    };
  }
  if (cloudBtn) {
    cloudBtn.onclick = () => {
      if (busy) return;
      if (!selectedFiles || !selectedFiles.length) {
        setUploadStatus(statusEl, 'Select files first');
        return;
      }
      handleCloudUpload(selectedFiles, statusEl, selectSeries, setBusy);
    };
  }
  if (dicomwebBtn) {
    dicomwebBtn.onclick = () => handleDicomwebImport(statusEl, selectSeries, setBusy, dicomwebState);
  }
  if (findStudiesBtn) {
    findStudiesBtn.onclick = () => handleDicomwebStudyDiscovery(statusEl, setBusy, dicomwebState);
  }
  if (findSeriesBtn) {
    findSeriesBtn.onclick = () => handleDicomwebSeriesDiscovery(statusEl, setBusy, dicomwebState);
  }
}

export async function handleLocalImport(files, statusEl, modal, selectSeries, setBusy = () => {}, opts = {}) {
  setBusy(true);
  try {
    let {
      imageFiles: fileList,
      roiSidecars,
      recipeSidecars,
      imageJRoiSidecars,
      imageJRoiSidecarErrors,
    } = await splitMicroscopySidecars(files);
    if (!fileList.length) {
      const activeSeries = state.loaded ? state.manifest?.series?.[state.seriesIdx] : null;
      if (activeSeries?.imageDomain !== 'microscopy') {
        throw new Error(desktopMicroscopySidecarOnlyText(microscopySidecarRecords({ roiSidecars, recipeSidecars, imageJRoiSidecars, imageJRoiSidecarErrors })));
      }
      if (imageJRoiSidecarErrors.length) {
        throw new Error(unsupportedImageJRoiSidecarText(imageJRoiSidecarErrors));
      }
      const imageJResult = await importImageJRoiSidecarsForActiveSeries(imageJRoiSidecars);
      const recipeResult = await applyRecipeSidecarsForActiveSeries(recipeSidecars);
      const roiResult = await importRoiSidecarsForActiveSeries(roiSidecars);
      if (imageJResult.applied + recipeResult.applied + roiResult.applied <= 0) {
        const details = [
          ...(imageJResult.skippedDetails || []),
          ...(recipeResult.skippedDetails || []),
          ...(roiResult.skippedDetails || []),
        ];
        const fallbackReason = recipeResult.skippedMessages?.[0] || roiResult.skippedMessages?.[0] || '';
        const reason = sidecarSkipDetailsText(details, details.length, fallbackReason ? `: ${fallbackReason}` : '.');
        throw new Error(`No sidecars matched the active microscopy series${reason}`);
      }
      closeModal('upload-modal');
      return;
    }
    const imageJRoiSidecarsForImport = imageJRoiSidecars.concat(imageJRoiSidecarErrors.map(sidecar => ({ name: sidecar.name || 'imagej.roi', reason: sidecar.reason || 'unsupported or malformed ImageJ ROI sidecar', skipped: true })));
    // Vendor formats convert server-side into OME-TIFF, then take the shared
    // microscopy path. Requires the local backend plus optional readers or a converter.
    const vendorFiles = fileList.filter(isVendorMicroscopyFile);
    if (vendorFiles.length && vendorFiles.length !== fileList.length) {
      fileList = fileList.filter(file => !isVendorMicroscopyFile(file));
      const samples = fileSampleNames(vendorFiles);
      notify(`Skipped ${vendorFiles.length} converter-backed file${vendorFiles.length === 1 ? '' : 's'}${samples ? `: ${samples}` : ''}; open them separately with configured local readers or an OME-TIFF converter after loading supported files.`);
    } else if (vendorFiles.length) {
      if (!HAS_LOCAL_BACKEND) {
        throw new Error(`Converter-backed ${LOCAL_VENDOR_MICROSCOPY_LABEL} need the local VoxelLab backend (run "npm start") with optional microscopy readers or VOXELLAB_BFCONVERT set to an OME-TIFF converter.`);
      }
      for (let i = 0; i < fileList.length; i += 1) {
        setUploadStatus(statusEl, `Converting ${fileList[i].name}...`, 'active');
        fileList[i] = await convertVendorMicroscopyFile(fileList[i]);
      }
    }
    const niftiFiles = fileList.filter(isNiftiFile);
    const microscopyFiles = fileList.filter(isMicroscopyTiffFile);
    const omeZarrFiles = fileList.filter(isOmeZarrFile);
    if (!state.loaded && fileList.length > 0 && fileList.every(isDicomSrFile)) {
      throw new Error('DICOM SR files are derived objects, not standalone images. Open the matching source DICOM series first, then open the SR file again.');
    }
    let results;
    if (microscopyFiles.length) {
      const blockedJsonSidecars = blockingMicroscopyJsonSidecars(opts.intake);
      if (blockedJsonSidecars.length) throw new Error(blockingMicroscopyJsonSidecarText(blockedJsonSidecars));
    }
    if (omeZarrFiles.length) {
      if (omeZarrFiles.length !== fileList.length) {
        throw new Error(mixedNativeImportBoundaryText(fileList));
      }
      setUploadStatus(statusEl, 'Parsing OME-Zarr metadata...', 'active');
      const { omeZarrStatusText, parseOmeZarrFiles } = await import('../microscopy/microscopy-zarr-import.js');
      const zarr = await parseOmeZarrFiles(fileList, (stage, detail) => setUploadStatus(statusEl, `${stage}: ${detail}`, 'active'));
      if (!zarr) throw new Error('OME-Zarr metadata was not found in the selected .zattrs, .zarray, .zmetadata, or zarr.json files.');
      if (!zarr.results.length) {
        setUploadStatus(statusEl, zarr.status || omeZarrStatusText(zarr), 'warning');
        return;
      }
      results = zarr.results;
    }
    if (microscopyFiles.length && microscopyFiles.length !== fileList.length) {
      throw new Error(mixedNativeImportBoundaryText(fileList));
    }
    if (niftiFiles.length && fileList.length !== 1) {
      throw new Error(mixedNativeImportBoundaryText(fileList));
    }
    const first = fileList[0];
    const isNifti = niftiFiles.length === 1;
    const isMicroscopy = microscopyFiles.length > 0 || omeZarrFiles.length > 0;

    if (results) {
      // OME-Zarr already populated results above.
    } else if (isNifti) {
      setUploadStatus(statusEl, 'Parsing NIfTI...', 'active');
      const { parseNIfTI } = await import('../dicom/dicom-import.js');
      const result = await parseNIfTI(first, (stage, detail) => {
        setUploadStatus(statusEl, `${stage}: ${detail}`, 'active');
      });
      results = result ? [result] : null;
    } else if (isMicroscopy) {
      setUploadStatus(statusEl, 'Parsing microscopy TIFF...', 'active');
      const { parseMicroscopyFiles } = await import('../microscopy/microscopy-import.js');
      results = await parseMicroscopyFiles(fileList, (stage, detail) => {
        setUploadStatus(statusEl, `${stage}: ${detail}`, 'active');
      });
    } else {
      setUploadStatus(statusEl, 'Parsing DICOM...', 'active');
      const { parseDICOMFileGroups } = await import('../dicom/dicom-import.js');
      results = await parseDICOMFileGroups(fileList, (stage, detail) => {
        setUploadStatus(statusEl, `${stage}: ${detail}`, 'active');
      });
    }

    const imageResults = results || [];
    setUploadStatus(statusEl, imageResults.length ? 'Loading into viewer...' : 'Applying derived objects...', 'active');
    const projectionSetCount = imageResults.filter(result => result.entry?.isProjectionSet).length;
    let indexes = [];
    if (imageResults.length) {
      const { injectLocalSeries } = await import('../dicom/dicom-import.js');
      indexes = imageResults.map(result =>
        injectLocalSeries(state.manifest, result.entry, result.sliceCanvases, result.rawVolume, result.localStacks, result.rawPlanes)
      );
    }
    let derived = [];
    if (!isNifti && !isMicroscopy) {
      const { importLocalDerivedObjects } = await import('../dicom/dicom-derived-import.js');
      derived = await importLocalDerivedObjects(fileList, state.manifest, (stage, detail) => {
        setUploadStatus(statusEl, `${stage}: ${detail}`, 'active');
      });
    }
    const affectedSlug = derived.find((item) => item.sourceSlug)?.sourceSlug || null;
    const affectedIndex = affectedSlug
      ? state.manifest.series.findIndex((series) => series.slug === affectedSlug)
      : -1;

    if (!indexes.length && affectedIndex < 0) {
      setUploadStatus(statusEl, `Could not parse selected files.${localImportFailedContext(fileList)}${localImportIntakeContext(opts.intake)} Check format or open the full source folder.`, 'error');
      return;
    }

    closeModal('upload-modal');
    const selectedIndex = indexes[0] ?? affectedIndex;
    if (selectedIndex >= 0) {
      const selectedSeries = state.manifest.series[selectedIndex];
      enableRegionsIfAvailable(selectedSeries);
      await selectSeries(selectedIndex);
      await importImageJRoiSidecarsForActiveSeries(imageJRoiSidecarsForImport);
      await applyRecipeSidecarsForActiveSeries(recipeSidecars);
      await importRoiSidecarsForActiveSeries(roiSidecars);
    }
    if (projectionSetCount > 0) {
      notify(`${projectionSetCount} projection set${projectionSetCount > 1 ? 's' : ''} registered for calibrated reconstruction; source images stay 2D until a derived volume exists.`);
    }
    const imported = derived.filter((item) => !item.skipped);
    if (imported.length) {
      const byKind = imported.reduce((acc, item) => {
        acc[item.kind] = (acc[item.kind] || 0) + 1;
        return acc;
      }, {});
      const parts = [];
      if (byKind.seg) parts.push(`${byKind.seg} SEG overlay${byKind.seg > 1 ? 's' : ''}`);
      if (byKind.rtstruct) parts.push(`${byKind.rtstruct} RTSTRUCT import${byKind.rtstruct > 1 ? 's' : ''}`);
      if (byKind.sr) parts.push(`${byKind.sr} SR note set${byKind.sr > 1 ? 's' : ''}`);
      notify(`Imported ${parts.join(', ')} onto the referenced source series.`);
    }
    const skippedDerived = derived.filter((item) => item.skipped);
    if (skippedDerived.length) {
      notify(skippedDerivedObjectsText(skippedDerived));
    }
  } catch (e) {
    setUploadStatus(statusEl, `Error: ${escapeHtml(localImportErrorMessage(e, files, opts.intake))}`, 'error', { html: true });
  } finally {
    setBusy(false);
  }
}

async function handleCloudUpload(files, statusEl, selectSeries, setBusy = () => {}) {
  setBusy(true);
  try {
    setUploadStatus(statusEl, 'Preparing upload...', 'active');
    const result = await uploadAndProcess(files, (stage, detail) => {
      setUploadStatus(statusEl, `${stage}: ${detail}`, 'active');
    });
    if (result.seriesEntry) {
      if (result.projectionSetEntry) {
        registerProjectionSet(state.manifest, {
          ...result.projectionSetEntry,
          slug: result.projectionSetEntry.slug || result.projectionSetEntry.id,
          isProjectionSet: true,
        });
      }
      const { injectManifestSeries } = await import('../dicom/dicom-import.js');
      const idx = injectManifestSeries(state.manifest, result.seriesEntry);
      closeModal('upload-modal');
      await selectSeries(idx);
      return;
    }
    setUploadStatus(statusEl, `Complete! Series <b>${escapeHtml(result.slug)}</b> is ready on R2.`, 'success', { html: true });
  } catch (e) {
    setUploadStatus(statusEl, `Error: ${escapeHtml(e.message)}`, 'error', { html: true });
  } finally {
    setBusy(false);
  }
}

function dicomwebRequestHeaders(bearerToken = '') {
  return bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {};
}

async function handleDicomwebStudyDiscovery(statusEl, setBusy = () => {}, dicomwebState = null) {
  const wadoBase = $('dicomweb-base')?.value.trim() || '';
  const bearerToken = $('dicomweb-token')?.value || '';
  const qidoQuery = $('dicomweb-query')?.value.trim() || '';
  if (!wadoBase) {
    setUploadStatus(statusEl, 'Enter WADO-RS base URL', 'error');
    return;
  }

  setBusy(true);
  try {
    setUploadStatus(statusEl, 'dicomweb: discovering studies', 'active');
    const { discoverQidoStudies, resolveDicomwebImportSession } = await import('../dicom/dicomweb-import.js');
    const headers = dicomwebRequestHeaders(bearerToken);
    const session = resolveDicomwebImportSession({
      sessionId: dicomwebState?.sessionId || '',
      wadoBase,
      headers,
    });
    if (dicomwebState) dicomwebState.sessionId = session.id;
    const studies = await discoverQidoStudies({
      wadoBase,
      headers,
      sessionId: session.id,
      query: qidoQuery ? { PatientName: qidoQuery } : {},
    });
    if (dicomwebState) dicomwebState.studies = studies;
    if (!studies.length) {
      setUploadStatus(statusEl, 'No studies matched this QIDO query');
      return;
    }
    const picked = studies[0];
    $('dicomweb-study').value = picked.studyUID || '';
    setUploadStatus(statusEl, `dicomweb: found ${studies.length} stud${studies.length === 1 ? 'y' : 'ies'}, selected ${picked.studyUID}`, 'active');
  } catch (e) {
    setUploadStatus(statusEl, `Error: ${escapeHtml(e.message)}`, 'error', { html: true });
  } finally {
    setBusy(false);
  }
}

async function handleDicomwebSeriesDiscovery(statusEl, setBusy = () => {}, dicomwebState = null) {
  const wadoBase = $('dicomweb-base')?.value.trim() || '';
  const bearerToken = $('dicomweb-token')?.value || '';
  const studyUID = $('dicomweb-study')?.value.trim() || '';
  if (!wadoBase) {
    setUploadStatus(statusEl, 'Enter WADO-RS base URL', 'error');
    return;
  }
  if (!studyUID) {
    setUploadStatus(statusEl, 'Set Study UID first (or click Find studies)', 'error');
    return;
  }

  setBusy(true);
  try {
    setUploadStatus(statusEl, 'dicomweb: discovering series', 'active');
    const { discoverQidoSeries, resolveDicomwebImportSession } = await import('../dicom/dicomweb-import.js');
    const headers = dicomwebRequestHeaders(bearerToken);
    const session = resolveDicomwebImportSession({
      sessionId: dicomwebState?.sessionId || '',
      wadoBase,
      headers,
    });
    if (dicomwebState) dicomwebState.sessionId = session.id;
    const series = await discoverQidoSeries({
      wadoBase,
      studyUID,
      headers,
      sessionId: session.id,
    });
    if (dicomwebState) dicomwebState.series = series;
    if (!series.length) {
      setUploadStatus(statusEl, 'No series found for this study');
      return;
    }
    const preferred = series.find((item) => !isDerivedObjectModality(item.modality)) || series[0];
    $('dicomweb-series').value = preferred.seriesUID || '';
    setUploadStatus(statusEl, `dicomweb: found ${series.length} series, selected ${preferred.seriesUID}`, 'active');
  } catch (e) {
    setUploadStatus(statusEl, `Error: ${escapeHtml(e.message)}`, 'error', { html: true });
  } finally {
    setBusy(false);
  }
}

async function handleDicomwebImport(statusEl, selectSeries, setBusy = () => {}, dicomwebState = null) {
  const wadoBase = $('dicomweb-base')?.value.trim() || '';
  const studyUID = $('dicomweb-study')?.value.trim() || '';
  const seriesUID = $('dicomweb-series')?.value.trim() || '';
  const bearerToken = $('dicomweb-token')?.value || '';
  if (!wadoBase || !studyUID || !seriesUID) {
    setUploadStatus(statusEl, 'Enter WADO-RS base URL, Study UID, and Series UID', 'error');
    return;
  }

  setBusy(true);
  try {
    setUploadStatus(statusEl, 'dicomweb: fetching metadata', 'active');
    const {
      fetchSeriesMetadata,
      importDicomwebSeries,
      resolveDicomwebImportSession,
    } = await import('../dicom/dicomweb-import.js');
    const headers = dicomwebRequestHeaders(bearerToken);
    const session = resolveDicomwebImportSession({
      sessionId: dicomwebState?.sessionId || '',
      wadoBase,
      headers,
    });
    if (dicomwebState) dicomwebState.sessionId = session.id;
    const metadata = await fetchSeriesMetadata({
      wadoBase,
      studyUID,
      seriesUID,
      headers,
      sessionId: session.id,
    });
    const modality = metadata?.[0]?.Modality || '';
    if (isDerivedObjectModality(modality)) {
      const { importDicomwebDerivedObject } = await import('../dicom/dicomweb-derived-import.js');
      const result = await importDicomwebDerivedObject({
        wadoBase,
        studyUID,
        seriesUID,
        headers,
        manifest: state.manifest,
      });
      if (result.sourceSlug) {
        const idx = state.manifest.series.findIndex((series) => series.slug === result.sourceSlug);
        if (idx >= 0) {
          enableRegionsIfAvailable(state.manifest.series[idx]);
          closeModal('upload-modal');
          await selectSeries(idx);
        }
      }
      if (result.skipped) throw new Error(result.reason || 'Could not import DICOMweb derived object');
      notify(`Imported ${result.modality} onto ${result.sourceSlug}.`);
      return;
    }
    const result = await importDicomwebSeries({
      wadoBase,
      studyUID,
      seriesUID,
      bearerToken,
      sessionId: session.id,
      metadata,
      onProgress: (stage, detail) => {
        setUploadStatus(statusEl, `${stage}: ${detail}`, 'active');
      },
    });
    if (!result) throw new Error('DICOMweb series could not be parsed');
    setUploadStatus(statusEl, 'Loading DICOMweb series into viewer...', 'active');
    const { injectLocalSeries } = await import('../dicom/dicom-import.js');
    const idx = injectLocalSeries(state.manifest, result.entry, result.sliceCanvases, result.rawVolume);
    closeModal('upload-modal');
    await selectSeries(idx);
  } catch (e) {
    setUploadStatus(statusEl, `Error: ${escapeHtml(e.message)}`, 'error', { html: true });
  } finally {
    setBusy(false);
  }
}
