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
import { isOmeZarrFile } from '../microscopy/microscopy-file-kinds.js';
import { desktopMicroscopySidecarOnlyText } from '../desktop-intake-text.js';
import { registerProjectionSet } from '../series/series-contract.js';
import {
  UNRECOGNIZED_JSON_SIDECAR_REASON,
  sidecarUnsupportedDescription,
} from '../sidecar-schemas.js';
import { isCloudAvailable, uploadAndProcess } from '../cloud.js';
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
  LOCAL_VENDOR_MICROSCOPY_RE,
  summarizeLocalIntake,
} from './local-intake-summary.js';
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
      <div id="upload-status" class="upload-status" role="status" aria-live="polite"></div>
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
    if (omeZarrBtn) omeZarrBtn.disabled = nextBusy;
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
    renderIntakeTriage(statusEl, intake, count ? 'active' : 'error');
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
  const omeZarrBtn = $('upload-ome-zarr-btn');
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
  if (omeZarrBtn) {
    omeZarrBtn.onclick = () => handleOmeZarrStreamImport(statusEl, modal, selectSeries, setBusy);
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
