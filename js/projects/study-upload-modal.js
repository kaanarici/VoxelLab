// "Open a study" modal: local DICOM/NIfTI parse or cloud pipeline.
import { state, HAS_LOCAL_BACKEND } from '../core/state.js';
import { $, escapeHtml, openModal, closeModal } from '../dom.js';
import { cloudActionWorkflowRecords } from '../cloud-actions.js';
import { cloudResultRecords } from '../cloud-results.js';
import { ensureTemplate } from '../template-loader.js';
import {
  collectDroppedFiles,
  filterLocalFiles,
  MAX_LOCAL_FILE_SELECTION_FILES,
} from '../file-drop.js';
import { isOmeZarrFile } from '../microscopy/microscopy-file-kinds.js';
import { desktopMicroscopySidecarOnlyText } from '../desktop-intake-text.js';
import { registerProjectionSet } from '../series/series-contract.js';
import {
  UNRECOGNIZED_JSON_SIDECAR_REASON,
  sidecarUnsupportedDescription,
} from '../sidecar-schemas.js';
import { cloudRuntimeStatus, uploadAndProcess } from '../cloud.js';
import { notify } from '../notify.js';
import { enableRegionsIfAvailable } from '../core/state/viewer-commands.js';
import { renderFormatCapabilityMatrix } from '../format-capability-matrix.js';
import {
  localFilePath,
  localImportErrorMessage,
  localImportFailedContext,
  localImportIntakeContext,
  localIntakeStatusText,
  mixedNativeImportBoundaryText,
  NO_LOCAL_INTAKE_MATCH_ADVICE,
} from './local-intake-text.js';
import { intakeTriageHtml } from './local-intake-triage.js';
import {
  isMicroscopyTiffFile,
  isNiftiFile,
  isVendorMicroscopyFile,
  LOCAL_VENDOR_MICROSCOPY_ACCEPT,
  LOCAL_VENDOR_MICROSCOPY_LABEL,
  summarizeLocalIntake,
} from './local-intake-summary.js';
import { convertVendorMicroscopyFile } from './vendor-microscopy-convert.js';
import { setUploadStatus, hasActionableIntake } from './upload-status.js';
import {
  applyRecipeSidecarsForActiveSeries,
  importImageJRoiSidecarsForActiveSeries,
  importRoiSidecarsForActiveSeries,
  microscopySidecarRecords,
  sidecarSkipDetailsText,
  skippedDerivedObjectsText,
  splitMicroscopySidecars,
  unsupportedImageJRoiSidecarText,
} from './microscopy-sidecars.js';
import {
  handleDicomwebImport,
  handleDicomwebSeriesDiscovery,
  handleDicomwebStudyDiscovery,
} from './dicomweb-import-modal.js';
import { handleOmeZarrStreamImport } from './ome-zarr-import-modal.js';
import {
  cloudActionProgressText,
  cloudActionText,
  cloudSourceManifestFiles,
  cloudSourceInputPreflight,
  cloudUploadEligibility,
  readCloudSourceManifest,
} from './cloud-action-preflight.js';

// Render the structured intake triage as a scannable list. The visual is a
// row-per-outcome list, but the accessible name stays the complete sentence
// localIntakeStatusText() produces so screen readers hear one summary. When
// nothing is actionable the triage shows only red Skipped/failure rows, so we
// append the supported-format guidance the old run-on status used to carry.
export function renderIntakeTriage(statusEl, intake, tone) {
  const html = intakeTriageHtml(intake);
  if (!html) {
    setUploadStatus(statusEl, localIntakeStatusText(intake), tone);
    return;
  }
  statusEl.className = `upload-status upload-triage${tone === 'muted' ? '' : ` is-${tone}`}`;
  statusEl.setAttribute('aria-label', localIntakeStatusText(intake));
  const advice = hasActionableIntake(intake)
    ? ''
    : `<p class="upload-triage-advice">${escapeHtml(NO_LOCAL_INTAKE_MATCH_ADVICE)}</p>`;
  statusEl.innerHTML = html + advice;
}

function cloudJobStageLabel(stage) {
  return {
    preparing: 'Preparing',
    uploading: 'Uploading',
    processing: 'Running',
    complete: 'Complete',
    partial: 'Partial',
    stopped: 'Stopped',
    failed: 'Failed',
  }[stage] || String(stage || 'Running');
}

const CLOUD_STOP_MESSAGE = 'Stopped waiting for cloud job. If processing already started, Modal may still finish and write results.';
const CLOUD_CLOSE_BLOCKED_MESSAGE = 'Cloud job is running. Stop waiting before closing this modal.';
let uploadSelectionSeq = 0;
let uploadModalSeq = 0;
let localImportBusy = false;

function cloudJobStopLabel(stage) {
  return stage === 'processing' ? 'Stop waiting' : 'Stop upload';
}

function clearCloudJobCard() {
  const card = $('upload-cloud-job-card');
  if (!card) return;
  card.hidden = true;
  card.innerHTML = '';
  card.classList.remove('is-error');
  card.classList.remove('is-stopped');
}

function renderCloudJobCard(stage, detail = '', processing = {}, meta = {}) {
  const card = $('upload-cloud-job-card');
  if (!card) return;
  const jobId = String(meta?.jobId || '').trim();
  if (!jobId) {
    clearCloudJobCard();
    return;
  }
  const action = cloudActionText(processing);
  const stageText = cloudJobStageLabel(stage);
  const detailText = stage === 'failed'
    ? `Error: ${String(detail || 'Cloud job failed').trim()}`
    : cloudActionProgressText(stage, detail, processing);
  const stopHtml = meta?.abortable && !['complete', 'partial', 'failed', 'stopped'].includes(stage)
    ? `<div class="upload-cloud-job-actions"><button class="btn upload-cloud-job-stop" type="button" data-cloud-job-stop>${escapeHtml(cloudJobStopLabel(stage))}</button></div>`
    : '';
  card.hidden = false;
  card.classList.toggle('is-error', stage === 'failed');
  card.classList.toggle('is-stopped', stage === 'stopped');
  card.innerHTML = `
    <div class="upload-cloud-job-head">
      <span class="upload-cloud-job-stage">${escapeHtml(stageText)}</span>
      <span class="upload-cloud-job-action">${escapeHtml(action.label || action.noun || 'Cloud action')}</span>
    </div>
    <div class="upload-cloud-job-row"><span>Job</span><b>${escapeHtml(jobId)}</b></div>
    <div class="upload-cloud-job-detail">${escapeHtml(detailText)}</div>
    ${stopHtml}
  `;
}

function cloudResultHistoryHtml() {
  const records = cloudResultRecords(state.manifest?.series || [], { limit: 5, newestFirst: true });
  if (!records.length) return '';
  const rows = records.map(record => `
    <button class="upload-cloud-result" type="button" data-cloud-result-slug="${escapeHtml(record.slug)}">
      <span class="upload-cloud-result-name">${escapeHtml(record.name)}</span>
      <span class="upload-cloud-result-meta">${escapeHtml(`${record.action}${record.jobId ? ` · job ${record.jobId}` : ''} · outputs ${record.outputs}`)}</span>
      ${record.detail ? `<span class="upload-cloud-result-detail">${escapeHtml(record.detail)}</span>` : ''}
    </button>
  `).join('');
  return `
    <div class="upload-section" id="upload-cloud-history">
      <div class="upload-section-title">Cloud results in this study</div>
      <div class="upload-cloud-history-list">${rows}</div>
    </div>
  `;
}

function cloudActionStatusLabel(status = {}) {
  if (status.available) return 'Ready';
  if (status.code === 'disabled') return 'Disabled';
  if (status.code === 'setup-required' || status.code === 'storage-required') return 'Setup required';
  return 'Blocked';
}

function cloudActionRecordStatus(record = {}, status = {}) {
  if (!status.available) {
    return {
      label: cloudActionStatusLabel(status),
      tone: 'is-warning',
    };
  }
  const loadedState = String(record.loadedState || '');
  if (loadedState.startsWith('no ') || loadedState.startsWith('needs ')) {
    return { label: 'Needs source', tone: 'is-warning' };
  }
  if (loadedState.includes('blocked until')) {
    return { label: 'Needs calibration', tone: 'is-warning' };
  }
  return { label: 'Source ready', tone: 'is-ready' };
}

function cloudActionCatalogHtml(status = {}, context = {}) {
  const rows = cloudActionWorkflowRecords(status, context).map((record) => {
    const badge = cloudActionRecordStatus(record, status);
    return `
      <div class="upload-cloud-action-card">
        <div class="upload-cloud-action-head">
          <span class="upload-cloud-action-status ${badge.tone}">${escapeHtml(badge.label)}</span>
          <b>${escapeHtml(record.label)}</b>
        </div>
        <div class="upload-cloud-action-copy">${escapeHtml(record.inputSummary)}; ${escapeHtml(record.setupSummary)}.</div>
        <div class="upload-cloud-action-copy">${escapeHtml(record.resultSummary)}.</div>
        <div class="upload-cloud-action-copy">Loaded study: ${escapeHtml(record.loadedState || 'open source data to evaluate candidates')}.</div>
        <div class="upload-cloud-action-copy">Next: ${escapeHtml(record.nextStep)}.</div>
      </div>
    `;
  }).join('');
  return `
    <div class="upload-section" id="upload-cloud-actions">
      <div class="upload-section-title">Cloud GPU actions</div>
      <div class="upload-cloud-action-list">${rows}</div>
    </div>
  `;
}

function uploadContextHintHtml(options = {}) {
  const title = String(options.contextTitle || '').trim();
  const body = String(options.contextBody || '').trim();
  if (!title && !body) return '';
  return `
    <div class="upload-section upload-context-hint" id="upload-context-hint">
      ${title ? `<div class="upload-section-title">${escapeHtml(title)}</div>` : ''}
      ${body ? `<div class="upload-copy upload-copy-tight">${escapeHtml(body)}</div>` : ''}
    </div>
  `;
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

function cloudFilesForUpload(localFiles = [], rawFiles = []) {
  const list = Array.from(localFiles || []);
  for (const file of cloudSourceManifestFiles(rawFiles)) {
    if (!list.includes(file)) list.push(file);
  }
  return list;
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

export async function showStudyUploadModal(selectSeries, options = {}) {
  // A cloud operation owns its visible upload session until the user stops
  // waiting. Do not rebuild the modal underneath it: callers such as desktop
  // open can arrive again while the request is still polling.
  const openUploadModal = $('upload-modal');
  if (openUploadModal?.classList.contains('visible') && openUploadModal.dataset.closeBlocked === 'true') {
    openUploadModal.dispatchEvent(new CustomEvent('voxellab:modal-close-blocked', { bubbles: true }));
    return () => false;
  }
  const modalSeq = ++uploadModalSeq;
  ++uploadSelectionSeq;
  await ensureTemplate('./templates/upload-modal.html', 'modal-root', 'upload-modal');
  if (modalSeq !== uploadModalSeq) return;
  const modal = $('upload-modal');
  const body = $('upload-body');
  openModal('upload-modal');
  const isModalSessionCurrent = () => modalSeq === uploadModalSeq;
  const isModalSessionActive = () => isModalSessionCurrent() && modal.classList.contains('visible');

  const desktop = globalThis.voxellabDesktop;
  // Desktop swaps the web <input webkitdirectory> for the native dialog, which
  // can multi-select sibling series folders and reads slices by range instead of
  // buffering every file in memory. The payload returns through the desktop
  // bridge's onOpenPaths → handleLocalImport, so the import path stays shared.
  const isDesktopHost = typeof desktop?.openFolder === 'function';
  const cloudSettingsWritable = HAS_LOCAL_BACKEND || !!(desktop?.getCloudSettings && desktop?.saveCloudSettings);
  const cloudStatus = cloudRuntimeStatus();
  const cloudAvail = cloudStatus.available;
  const cloudSetupGuidance = cloudSettingsWritable
    ? 'Use Cloud settings to enable Modal GPU segmentation, registration/alignment, reconstruction, and scan conversion actions.'
    : 'Open the desktop app or run npm start to configure Modal GPU segmentation, registration/alignment, reconstruction, and scan conversion actions.';
  const cloudWorkflowContext = {
    activeIndex: state.seriesIdx,
    projectionSets: state.manifest?.projectionSets || [],
    seriesList: state.manifest?.series || [],
  };
  const showAdvancedByDefault = !!(
    String(options.contextTitle || '').trim()
    || String(options.contextBody || '').trim()
  );
  body.innerHTML = `
    <div class="ask-a">
      <label class="upload-zone" id="upload-zone" aria-label="Open study files">
        <input type="file" id="upload-file-input" multiple
          accept=".dcm,.sr,.nii,.nii.gz,.tif,.tiff,.ome.tif,.ome.tiff,${LOCAL_VENDOR_MICROSCOPY_ACCEPT},.zattrs,.zarray,.zgroup,.zmetadata,.json,.roi,.zip,application/dicom,image/tiff,application/json" class="upload-file-input" />
        <input type="file" id="upload-folder-input" multiple webkitdirectory class="upload-file-input" />
        <svg class="upload-zone-icon"><use href="icons.svg#i-upload"/></svg>
        <span class="upload-zone-title">Drop study files or folders here</span>
        <span class="upload-zone-subtitle">or click to open files</span>
      </label>
      <div class="upload-actions upload-copy-spaced">
        <button class="btn upload-action" id="upload-folder-btn" type="button">${isDesktopHost ? 'Open study folders' : 'Open study folder'}</button>
      </div>
      <div class="upload-copy upload-copy-tight">
        Open a whole study folder: each sub-folder (e.g. Series 1, Series 2…) imports as its own series under one study.${isDesktopHost ? ' Select multiple sibling folders at once.' : ' Drag several sibling folders together, or pick the parent folder.'}
      </div>
      <div id="upload-status" class="upload-status" role="status" aria-live="polite"></div>
      ${cloudAvail ? `
        <div class="upload-actions upload-copy-spaced">
          <button class="btn upload-action" id="upload-local-btn">Open selected files</button>
        </div>
        <div class="upload-copy upload-copy-tight">
          Opens locally in your browser; no upload needed. Calibrated OME-TIFF/ImageJ stacks use micrometer measurements; generic TIFF sequences stay uncalibrated.
        </div>
      ` : `
        <div class="upload-copy upload-copy-spaced">
          Files open locally in your browser. Nothing is uploaded. Calibrated OME-TIFF/ImageJ stacks use micrometer measurements; generic TIFF sequences stay uncalibrated.
        </div>
      `}
      <details class="upload-advanced" id="upload-advanced-options"${showAdvancedByDefault ? ' open' : ''}>
        <summary class="upload-advanced-summary">Advanced options</summary>
        <div class="upload-advanced-body">
          ${uploadContextHintHtml(options)}
          <div id="upload-cloud-job-card" class="upload-cloud-job-card" hidden></div>
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
          <div class="upload-section">
            <div class="upload-section-title">Open OME-Zarr by URL (streaming)</div>
            <div class="upload-grid">
              <input id="ome-zarr-url" class="select-like upload-field" placeholder="OME-Zarr image group URL (…/image.zarr)" />
              <button class="btn" id="upload-ome-zarr-btn">Stream OME-Zarr</button>
              <div class="upload-copy">
                Streams a public multiscale OME-Zarr in your browser, no install. Opens a downsampled pyramid level fast; calibration and provenance reflect the loaded level, not full resolution. Compressed Blosc/LZ4/shuffle, zstd, and zlib chunks decode locally; unsupported codecs fail closed with a named reason. The store is read directly from your browser, so it must allow cross-origin reads (CORS); hosts that do not fail closed.
              </div>
            </div>
          </div>
          ${cloudAvail ? `
            <div class="upload-actions upload-copy-spaced">
              <button class="btn upload-action" id="upload-cloud-btn">Process CT/MR on cloud GPU</button>
            </div>
            <div class="upload-copy upload-copy-tight" id="upload-cloud-action-state" hidden></div>
            <div class="upload-copy upload-copy-tight">
              <b>Cloud GPU</b>: ${escapeHtml(cloudStatus.message)} Uploads supported CT/MR stacks for segmentation, two-series registration/alignment, or DICOM projection/ultrasound sources with voxellab.source.json for reconstruction/scan conversion.<br>
              Projection and ultrasound sources stay 2D until a calibrated engine emits a derived volume.
            </div>
          ` : `
            ${cloudSettingsWritable ? `
              <div class="upload-actions upload-copy-spaced">
                <button class="btn upload-action" id="upload-cloud-settings-btn" type="button">Cloud settings</button>
              </div>
            ` : ''}
            <div class="upload-copy upload-copy-spaced">
              <b>Cloud GPU</b>: ${escapeHtml(cloudStatus.message)} ${escapeHtml(cloudSetupGuidance)} Projection and ultrasound sources stay 2D until a calibrated engine emits a derived volume.
            </div>
          `}
          ${cloudActionCatalogHtml(cloudStatus, cloudWorkflowContext)}
          ${cloudResultHistoryHtml()}
          ${renderFormatCapabilityMatrix()}
        </div>
      </details>
    </div>
  `;

  const zone = $('upload-zone');
  const input = $('upload-file-input');
  const folderInput = $('upload-folder-input');
  const folderBtn = $('upload-folder-btn');
  const statusEl = $('upload-status');
  const dicomwebState = { sessionId: '', studies: [], series: [] };
  let selectedFiles = null;
  let selectedCloudFiles = null;
  let selectedIntake = null;
  let selectedCloudManifest = { payload: null, error: '' };
  let selectedCloudPreflight = { error: '' };
  let selectedCloud = cloudUploadEligibility();
  let isSelectedFilesCurrent = () => false;
  let cloudSelectionPending = false;
  let busy = false;
  let activeCloudAbortController = null;
  let activeCloudOperation = null;

  function setUploadCloseBlocked(blocked) {
    if (!isModalSessionCurrent()) return;
    if (blocked) modal.dataset.closeBlocked = 'true';
    else delete modal.dataset.closeBlocked;
  }

  if (modal._voxellabUploadCloseBlockedHandler) {
    modal.removeEventListener('voxellab:modal-close-blocked', modal._voxellabUploadCloseBlockedHandler);
  }
  modal._voxellabUploadCloseBlockedHandler = () => {
    setUploadStatus(statusEl, CLOUD_CLOSE_BLOCKED_MESSAGE, 'warning');
  };
  modal.addEventListener('voxellab:modal-close-blocked', modal._voxellabUploadCloseBlockedHandler);

  function syncCloudActionState() {
    selectedCloud = cloudUploadEligibility(selectedCloudFiles, selectedCloudManifest, selectedCloudPreflight);
    if (localBtn) localBtn.disabled = busy || cloudSelectionPending;
    if (cloudBtn) {
      const blockedSelection = !!selectedCloudFiles?.length && !selectedCloud.eligible;
      cloudBtn.disabled = busy || cloudSelectionPending || blockedSelection;
      cloudBtn.textContent = selectedCloud.buttonLabel || cloudActionText().button;
      if (blockedSelection) cloudBtn.title = selectedCloud.reason;
      else cloudBtn.removeAttribute('title');
    }
    if (cloudActionState) {
      const hasSelection = !!selectedCloudFiles?.length;
      cloudActionState.hidden = !hasSelection;
      cloudActionState.textContent = hasSelection ? selectedCloud.reason : '';
      cloudActionState.classList.toggle('is-warning', hasSelection && !selectedCloud.eligible);
    }
  }

  const setBusy = (nextBusy) => {
    busy = nextBusy;
    zone.style.pointerEvents = nextBusy ? 'none' : '';
    if (input) input.disabled = nextBusy;
    if (folderInput) folderInput.disabled = nextBusy;
    if (folderBtn) folderBtn.disabled = nextBusy;
    if (localBtn) localBtn.disabled = nextBusy;
    syncCloudActionState();
    if (dicomwebBtn) dicomwebBtn.disabled = nextBusy;
    if (findStudiesBtn) findStudiesBtn.disabled = nextBusy;
    if (findSeriesBtn) findSeriesBtn.disabled = nextBusy;
    if (omeZarrBtn) omeZarrBtn.disabled = nextBusy;
  };

  zone.addEventListener('click', (e) => {
    if (busy) return;
    if (e.target === input) return;
    if (isDesktopHost && typeof desktop.openFiles === 'function') {
      void desktop.openFiles().catch((error) => {
        setUploadStatus(statusEl, `Error: ${escapeHtml(error?.message || 'File open failed')}`, 'error', { html: true });
      });
      return;
    }
    input.click();
  });
  folderBtn?.addEventListener('click', async () => {
    if (busy) return;
    if (isDesktopHost) {
      try {
        await desktop.openFolder();
      } catch (error) {
        setUploadStatus(statusEl, `Error: ${escapeHtml(error?.message || 'Folder open failed')}`, 'error', { html: true });
      }
      return;
    }
    folderInput?.click();
  });
  const beginSelection = () => {
    const selectionSeq = ++uploadSelectionSeq;
    return () => isModalSessionActive() && selectionSeq === uploadSelectionSeq;
  };
  const useSelectedFiles = async (files, isCurrent = beginSelection()) => {
    const isStaleSelection = () => !isCurrent();
    let intake;
    cloudSelectionPending = true;
    syncCloudActionState();
    try {
      const filteredFiles = filterLocalFiles(files, { maxFiles: MAX_LOCAL_FILE_SELECTION_FILES });
      intake = await summarizeLocalIntake(filteredFiles);
      if (isStaleSelection()) return;
      const nextSelectedFiles = intake.files;
      const nextCloudFiles = cloudFilesForUpload(nextSelectedFiles, filteredFiles);
      const nextManifest = await readCloudSourceManifest(filteredFiles);
      if (isStaleSelection()) return;
      const nextPreflight = cloudAvail && !nextManifest.error
        ? await cloudSourceInputPreflight(nextCloudFiles, nextManifest.payload)
        : { error: '' };
      if (isStaleSelection()) return;
      selectedFiles = nextSelectedFiles;
      selectedCloudFiles = nextCloudFiles;
      selectedIntake = intake;
      selectedCloudManifest = nextManifest;
      selectedCloudPreflight = nextPreflight;
      isSelectedFilesCurrent = isCurrent;
      if (intake.message) notify(intake.message, { id: 'local-intake', duration: 9000 });
    } catch (error) {
      if (isStaleSelection()) return;
      selectedFiles = null;
      selectedCloudFiles = null;
      selectedIntake = null;
      selectedCloudManifest = { payload: null, error: '' };
      selectedCloudPreflight = { error: '' };
      isSelectedFilesCurrent = () => false;
      cloudSelectionPending = false;
      syncCloudActionState();
      setUploadStatus(statusEl, `Error: ${escapeHtml(error.message)}`, 'error', { html: true });
      return;
    }
    if (isStaleSelection()) return;
    clearCloudJobCard();
    const count = selectedFiles.length;
    renderIntakeTriage(statusEl, intake, count ? 'active' : 'error');
    cloudSelectionPending = false;
    syncCloudActionState();
    if (!cloudAvail && count) {
      handleLocalImport(selectedFiles, statusEl, modal, selectSeries, setBusy, {
        intake,
        isActive: isCurrent,
      });
    }
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
    const isCurrent = beginSelection();
    try {
      const files = await collectDroppedFiles(e.dataTransfer);
      if (!isCurrent()) return;
      await useSelectedFiles(files, isCurrent);
    } catch (error) {
      if (!isCurrent()) return;
      setUploadStatus(statusEl, `Error: ${escapeHtml(error.message)}`, 'error', { html: true });
    }
  });
  input.addEventListener('change', async () => {
    if (busy) return;
    await useSelectedFiles(input.files, beginSelection());
  });
  folderInput?.addEventListener('change', async () => {
    if (busy) return;
    await useSelectedFiles(folderInput.files, beginSelection());
  });

  const localBtn = $('upload-local-btn');
  const cloudBtn = $('upload-cloud-btn');
  const cloudActionState = $('upload-cloud-action-state');
  const cloudSettingsBtn = $('upload-cloud-settings-btn');

  $('upload-cloud-history')?.addEventListener('click', async (event) => {
    const row = event.target.closest('[data-cloud-result-slug]');
    if (!row) return;
    if (busy || activeCloudOperation || modal.dataset.closeBlocked === 'true') {
      setUploadStatus(statusEl, CLOUD_CLOSE_BLOCKED_MESSAGE, 'warning');
      return;
    }
    const slug = row.getAttribute('data-cloud-result-slug') || '';
    const index = (state.manifest?.series || []).findIndex(series => series.slug === slug);
    if (index < 0) return;
    closeModal('upload-modal');
    await selectSeries(index);
  });
  const dicomwebBtn = $('upload-dicomweb-btn');
  const findStudiesBtn = $('dicomweb-find-studies-btn');
  const findSeriesBtn = $('dicomweb-find-series-btn');
  const omeZarrBtn = $('upload-ome-zarr-btn');
  if (localBtn) {
    localBtn.onclick = () => {
      if (!selectedFiles || !selectedFiles.length) {
        setUploadStatus(statusEl, 'Select files first');
        return;
      }
      handleLocalImport(selectedFiles, statusEl, modal, selectSeries, setBusy, {
        intake: selectedIntake,
        isActive: isSelectedFilesCurrent,
      });
    };
  }
  if (cloudBtn) {
    cloudBtn.onclick = () => {
      if (busy) return;
      if (!selectedCloudFiles || !selectedCloudFiles.length) {
        setUploadStatus(statusEl, 'Select files first');
        return;
      }
      if (!selectedCloud.eligible) {
        syncCloudActionState();
        setUploadStatus(statusEl, selectedCloud.reason, 'warning');
        return;
      }
      const operation = {};
      activeCloudOperation = operation;
      handleCloudUpload(selectedCloudFiles, statusEl, selectSeries, setBusy, selectedCloud.processing, {
        isActive: () => isModalSessionActive() && activeCloudOperation === operation,
        setActiveAbortController(controller) {
          if (activeCloudOperation === operation) activeCloudAbortController = controller;
        },
        setCloseBlocked: setUploadCloseBlocked,
        releaseOperation() {
          if (activeCloudOperation !== operation) return;
          activeCloudOperation = null;
          activeCloudAbortController = null;
        },
      });
    };
  }
  $('upload-cloud-job-card')?.addEventListener('click', (event) => {
    if (!event.target.closest('[data-cloud-job-stop]')) return;
    activeCloudAbortController?.abort(CLOUD_STOP_MESSAGE);
  });
  if (cloudSettingsBtn) {
    cloudSettingsBtn.onclick = async () => {
      const settings = await import('../cloud-settings-ui.js');
      await settings.openCloudSettingsModal();
    };
  }
  if (dicomwebBtn) {
    dicomwebBtn.onclick = () => handleDicomwebImport(statusEl, selectSeries, setBusy, dicomwebState, isModalSessionActive);
  }
  if (findStudiesBtn) {
    findStudiesBtn.onclick = () => handleDicomwebStudyDiscovery(statusEl, setBusy, dicomwebState, isModalSessionActive);
  }
  if (findSeriesBtn) {
    findSeriesBtn.onclick = () => handleDicomwebSeriesDiscovery(statusEl, setBusy, dicomwebState, isModalSessionActive);
  }
  if (omeZarrBtn) {
    omeZarrBtn.onclick = () => handleOmeZarrStreamImport(statusEl, modal, selectSeries, setBusy);
  }
  syncCloudActionState();
  return isModalSessionActive;
}

export async function handleLocalImport(files, statusEl, modal, selectSeries, setBusy = () => {}, opts = {}) {
  const isActive = typeof opts.isActive === 'function' ? opts.isActive : () => true;
  const updateStatus = (...args) => {
    if (isActive()) setUploadStatus(statusEl, ...args);
  };
  if (!isActive()) return;
  if (localImportBusy) {
    updateStatus('An import is already in progress.', 'warning');
    return;
  }
  localImportBusy = true;
  try {
    setBusy(true);
    let {
      imageFiles: fileList,
      roiSidecars,
      recipeSidecars,
      imageJRoiSidecars,
      imageJRoiSidecarErrors,
    } = await splitMicroscopySidecars(files);
    if (!isActive()) return;
    if (!fileList.length) {
      const activeSeries = state.loaded ? state.manifest?.series?.[state.seriesIdx] : null;
      if (activeSeries?.imageDomain !== 'microscopy') {
        throw new Error(desktopMicroscopySidecarOnlyText(microscopySidecarRecords({ roiSidecars, recipeSidecars, imageJRoiSidecars, imageJRoiSidecarErrors })));
      }
      if (imageJRoiSidecarErrors.length) {
        throw new Error(unsupportedImageJRoiSidecarText(imageJRoiSidecarErrors));
      }
      const imageJResult = await importImageJRoiSidecarsForActiveSeries(imageJRoiSidecars);
      if (!isActive()) return;
      const recipeResult = await applyRecipeSidecarsForActiveSeries(recipeSidecars);
      if (!isActive()) return;
      const roiResult = await importRoiSidecarsForActiveSeries(roiSidecars);
      if (!isActive()) return;
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
    let parseConvertedMicroscopyIndividually = false;
    if (vendorFiles.length && vendorFiles.length !== fileList.length) {
      fileList = fileList.filter(file => !isVendorMicroscopyFile(file));
      const samples = fileSampleNames(vendorFiles);
      notify(`Skipped ${vendorFiles.length} converter-backed file${vendorFiles.length === 1 ? '' : 's'}${samples ? `: ${samples}` : ''}; open them separately with configured local readers or an OME-TIFF converter after loading supported files.`);
    } else if (vendorFiles.length) {
      if (!HAS_LOCAL_BACKEND) {
        throw new Error(`Converter-backed ${LOCAL_VENDOR_MICROSCOPY_LABEL} need the local VoxelLab backend (run "npm start") with optional microscopy readers or VOXELLAB_BFCONVERT set to an OME-TIFF converter.`);
      }
      const convertedFiles = [];
      for (const original of fileList) {
        updateStatus(`Converting ${original.name}...`, 'active');
        const convertedParts = await convertVendorMicroscopyFile(original);
        if (!isActive()) return;
        convertedFiles.push(...convertedParts);
        for (const part of convertedParts) {
          for (const warning of part._voxellabConvertWarnings || []) {
            notify(`${original.name}: ${warning}`, { duration: 9000 });
          }
        }
      }
      fileList = convertedFiles;
      parseConvertedMicroscopyIndividually = true;
    }
    const niftiFiles = fileList.filter(isNiftiFile);
    const microscopyFiles = fileList.filter(isMicroscopyTiffFile);
    const omeZarrFiles = fileList.filter(isOmeZarrFile);
    let results;
    if (microscopyFiles.length) {
      const blockedJsonSidecars = blockingMicroscopyJsonSidecars(opts.intake);
      if (blockedJsonSidecars.length) throw new Error(blockingMicroscopyJsonSidecarText(blockedJsonSidecars));
    }
    if (omeZarrFiles.length) {
      if (omeZarrFiles.length !== fileList.length) {
        throw new Error(mixedNativeImportBoundaryText(fileList));
      }
      updateStatus('Parsing OME-Zarr metadata...', 'active');
      const { omeZarrStatusText, parseOmeZarrFiles } = await import('../microscopy/microscopy-zarr-import.js');
      if (!isActive()) return;
      const zarr = await parseOmeZarrFiles(fileList, (stage, detail) => updateStatus(`${stage}: ${detail}`, 'active'));
      if (!isActive()) return;
      if (!zarr) throw new Error('OME-Zarr metadata was not found in the selected .zattrs, .zarray, .zmetadata, or zarr.json files.');
      if (!zarr.results.length) {
        updateStatus(zarr.status || omeZarrStatusText(zarr), 'warning');
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
      updateStatus('Parsing NIfTI...', 'active');
      const { parseNIfTISeries } = await import('../dicom/dicom-import.js');
      if (!isActive()) return;
      const parsed = await parseNIfTISeries(first, (stage, detail) => {
        updateStatus(`${stage}: ${detail}`, 'active');
      });
      if (!isActive()) return;
      results = parsed?.length ? parsed : null;
    } else if (isMicroscopy) {
      updateStatus('Parsing microscopy TIFF...', 'active');
      const { parseMicroscopyFiles } = await import('../microscopy/microscopy-import.js');
      if (!isActive()) return;
      if (parseConvertedMicroscopyIndividually) {
        results = [];
        for (const convertedFile of fileList) {
          const parsed = await parseMicroscopyFiles([convertedFile], (stage, detail) => {
            updateStatus(`${stage}: ${detail}`, 'active');
          });
          if (!isActive()) return;
          if (parsed?.length) results.push(...parsed);
        }
        if (!results.length) results = null;
      } else {
        results = await parseMicroscopyFiles(fileList, (stage, detail) => {
          updateStatus(`${stage}: ${detail}`, 'active');
        });
      }
      if (!isActive()) return;
    } else {
      updateStatus('Parsing DICOM...', 'active');
      const { parseDICOMFileGroups } = await import('../dicom/dicom-import.js');
      if (!isActive()) return;
      results = await parseDICOMFileGroups(fileList, (stage, detail) => {
        updateStatus(`${stage}: ${detail}`, 'active');
      });
      if (!isActive()) return;
    }

    const imageResults = results || [];
    updateStatus(imageResults.length ? 'Loading into viewer...' : 'Applying derived objects...', 'active');
    const projectionSetCount = imageResults.filter(result => result.entry?.isProjectionSet).length;
    let indexes = [];
    if (imageResults.length) {
      const { injectLocalSeries } = await import('../dicom/dicom-import.js');
      if (!isActive()) return;
      indexes = imageResults.map(result =>
        injectLocalSeries(state.manifest, result.entry, result.sliceCanvases, result.rawVolume, result.localStacks, result.rawPlanes)
      );
    }
    let derived = [];
    if (!isNifti && !isMicroscopy) {
      const { importLocalDerivedObjects } = await import('../dicom/dicom-derived-import.js');
      if (!isActive()) return;
      derived = await importLocalDerivedObjects(fileList, state.manifest, (stage, detail) => {
        updateStatus(`${stage}: ${detail}`, 'active');
      });
      if (!isActive()) return;
    }
    const affectedSlug = derived.find((item) => item.sourceSlug)?.sourceSlug || null;
    const affectedIndex = affectedSlug
      ? state.manifest.series.findIndex((series) => series.slug === affectedSlug)
      : -1;
    const pendingDerived = derived.filter(item => item.pending);

    if (!indexes.length && affectedIndex < 0 && !pendingDerived.length) {
      updateStatus(`Could not parse selected files.${localImportFailedContext(fileList)}${localImportIntakeContext(opts.intake)} Check format or open the full source folder.`, 'error');
      return;
    }

    closeModal('upload-modal');
    const selectedIndex = indexes[0] ?? affectedIndex;
    if (selectedIndex >= 0) {
      const selectedSeries = state.manifest.series[selectedIndex];
      const isSelectedSeriesActive = () => (
        state.seriesIdx === selectedIndex
        && state.manifest.series[state.seriesIdx]?.slug === selectedSeries.slug
      );
      enableRegionsIfAvailable(selectedSeries);
      await selectSeries(selectedIndex);
      if (!isSelectedSeriesActive()) return;
      await importImageJRoiSidecarsForActiveSeries(imageJRoiSidecarsForImport, { isActive: isSelectedSeriesActive });
      if (!isSelectedSeriesActive()) return;
      await applyRecipeSidecarsForActiveSeries(recipeSidecars, { isActive: isSelectedSeriesActive });
      if (!isSelectedSeriesActive()) return;
      await importRoiSidecarsForActiveSeries(roiSidecars, { isActive: isSelectedSeriesActive });
      if (!isSelectedSeriesActive()) return;
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
    if (pendingDerived.length) {
      notify(`Holding ${pendingDerived.length} derived object${pendingDerived.length === 1 ? '' : 's'} in this session. They will attach automatically when the matching source series is loaded.`);
    }
    const skippedDerived = derived.filter((item) => item.skipped && !item.pending);
    if (skippedDerived.length) {
      notify(skippedDerivedObjectsText(skippedDerived));
    }
  } catch (e) {
    if (!isActive()) return;
    updateStatus(`Error: ${escapeHtml(localImportErrorMessage(e, files, opts.intake))}`, 'error', { html: true });
  } finally {
    localImportBusy = false;
    if (isActive()) setBusy(false);
  }
}

async function handleCloudUpload(files, statusEl, selectSeries, setBusy = () => {}, processing = {}, lifecycle = {}) {
  const isActive = typeof lifecycle.isActive === 'function' ? lifecycle.isActive : () => true;
  const updateStatus = (...args) => {
    if (isActive()) setUploadStatus(statusEl, ...args);
  };
  const updateJobCard = (...args) => {
    if (isActive()) renderCloudJobCard(...args);
  };
  if (!isActive()) return;
  setBusy(true);
  let lastProgressMeta = null;
  let lastProgressKey = '';
  const controller = new AbortController();
  lifecycle.setActiveAbortController?.(controller);
  lifecycle.setCloseBlocked?.(true);
  try {
    if (!isActive()) return;
    clearCloudJobCard();
    updateStatus(cloudActionProgressText('preparing', '', processing), 'active');
    const result = await uploadAndProcess(files, (stage, detail, meta = {}) => {
      if (!isActive()) return;
      lastProgressMeta = meta;
      const progressKey = `${stage}\u0000${detail || ''}`;
      if (progressKey === lastProgressKey) return;
      lastProgressKey = progressKey;
      updateJobCard(stage, detail, processing, meta);
      updateStatus(cloudActionProgressText(stage, detail, processing), 'active');
    }, processing, { signal: controller.signal });
    if (!isActive()) return;
    if (result.seriesEntry) {
      const resultStage = result.status === 'partial' ? 'partial' : 'complete';
      updateStatus(cloudActionProgressText(resultStage, result.seriesEntry.name || result.seriesEntry.slug || result.slug, processing), resultStage === 'partial' ? 'warning' : 'active');
      if (result.projectionSetEntry) {
        registerProjectionSet(state.manifest, {
          ...result.projectionSetEntry,
          slug: result.projectionSetEntry.slug || result.projectionSetEntry.id,
          isProjectionSet: true,
        });
      }
      const { injectManifestSeries } = await import('../dicom/dicom-import.js');
      if (!isActive()) return;
      const idx = injectManifestSeries(state.manifest, result.seriesEntry);
      if (!isActive()) return;
      closeModal('upload-modal');
      await selectSeries(idx);
      return;
    }
    throw new Error(
      `Cloud job ${result.jobId || result.slug || 'completed'} finished but did not return an importable series entry. `
      + 'Configure an R2 public URL or have the Modal status response include series_entry.',
    );
  } catch (e) {
    if (!isActive()) return;
    const stopped = !!e?.cloudStopped;
    updateJobCard(stopped ? 'stopped' : 'failed', e.message, processing, lastProgressMeta || {});
    updateStatus(stopped ? escapeHtml(e.message) : `Error: ${escapeHtml(e.message)}`, stopped ? 'warning' : 'error', { html: true });
  } finally {
    lifecycle.setActiveAbortController?.(null);
    lifecycle.setCloseBlocked?.(false);
    if (isActive()) setBusy(false);
    lifecycle.releaseOperation?.();
  }
}
