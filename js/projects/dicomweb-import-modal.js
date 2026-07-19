// DICOMweb (QIDO/WADO-RS) discovery and import for the upload modal: find studies,
// find series, then import a chosen series. Derived modalities (SEG/RTSTRUCT/SR)
// bind to an already loaded source series. The dicomweb parser modules load lazily
// only when one of these actions runs. The in-memory session is reused across calls
// via the shared dicomwebState the modal owns.
import { state } from '../core/state.js';
import { $, escapeHtml, closeModal } from '../dom.js';
import { isDerivedObjectModality } from '../dicom/dicom-import-routing.js';
import { notify } from '../notify.js';
import { enableRegionsIfAvailable } from '../core/state/viewer-commands.js';
import { setUploadStatus } from './upload-status.js';

function dicomwebRequestHeaders(bearerToken = '') {
  return bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {};
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

// DICOMweb work can outlive a modal render: QIDO/WADO requests and pixel
// decoding are asynchronous. Give each button action one owner so closing the
// modal, or starting another action, cancels its work rather than allowing a
// previous session to update the next modal instance.
function beginDicomwebOperation(dicomwebState, isModalActive) {
  const controller = new AbortController();
  const operation = {};
  const state = dicomwebState || {};
  state.activeAbortController?.abort();
  state.activeOperation = operation;
  state.activeAbortController = controller;

  const uploadModal = $('upload-modal');
  const observationRoot = uploadModal?.parentElement || uploadModal;
  const observer = (typeof MutationObserver !== 'undefined' && observationRoot)
    ? new MutationObserver(() => {
      if (!isModalActive()) controller.abort();
    })
    : null;
  observer?.observe(observationRoot, {
    attributes: true,
    attributeFilter: ['class'],
    childList: true,
    subtree: true,
  });

  const isActive = () => !controller.signal.aborted
    && state.activeOperation === operation
    && isModalActive();
  return {
    signal: controller.signal,
    isActive,
    finish() {
      observer?.disconnect();
      if (state.activeOperation !== operation) return;
      state.activeOperation = null;
      state.activeAbortController = null;
    },
  };
}

export async function handleDicomwebStudyDiscovery(statusEl, setBusy = () => {}, dicomwebState = null, isActive = () => true) {
  const operation = beginDicomwebOperation(dicomwebState, isActive);
  const updateStatus = (...args) => { if (operation.isActive()) setUploadStatus(statusEl, ...args); };
  if (!operation.isActive()) {
    operation.finish();
    return;
  }
  const wadoBase = $('dicomweb-base')?.value.trim() || '';
  const bearerToken = $('dicomweb-token')?.value || '';
  const qidoQuery = $('dicomweb-query')?.value.trim() || '';
  if (!wadoBase) {
    updateStatus('Enter WADO-RS base URL', 'error');
    operation.finish();
    return;
  }

  setBusy(true);
  try {
    updateStatus('dicomweb: discovering studies', 'active');
    const { discoverQidoStudies, resolveDicomwebImportSession } = await import('../dicom/dicomweb-import.js');
    if (!operation.isActive()) return;
    const headers = dicomwebRequestHeaders(bearerToken);
    const session = resolveDicomwebImportSession({
      sessionId: dicomwebState?.sessionId || '',
      wadoBase,
      headers,
    });
    if (!operation.isActive()) return;
    if (dicomwebState) dicomwebState.sessionId = session.id;
    const studies = await discoverQidoStudies({
      wadoBase,
      headers,
      sessionId: session.id,
      query: qidoQuery ? { PatientName: qidoQuery } : {},
      signal: operation.signal,
    });
    if (!operation.isActive()) return;
    if (dicomwebState) dicomwebState.studies = studies;
    if (!studies.length) {
      updateStatus('No studies matched this QIDO query');
      return;
    }
    const picked = studies[0];
    $('dicomweb-study').value = picked.studyUID || '';
    updateStatus(`dicomweb: found ${studies.length} stud${studies.length === 1 ? 'y' : 'ies'}, selected ${picked.studyUID}`, 'active');
  } catch (e) {
    if (isAbortError(e) || !operation.isActive()) return;
    updateStatus(`Error: ${escapeHtml(e.message)}`, 'error', { html: true });
  } finally {
    if (operation.isActive()) setBusy(false);
    operation.finish();
  }
}

export async function handleDicomwebSeriesDiscovery(statusEl, setBusy = () => {}, dicomwebState = null, isActive = () => true) {
  const operation = beginDicomwebOperation(dicomwebState, isActive);
  const updateStatus = (...args) => { if (operation.isActive()) setUploadStatus(statusEl, ...args); };
  if (!operation.isActive()) {
    operation.finish();
    return;
  }
  const wadoBase = $('dicomweb-base')?.value.trim() || '';
  const bearerToken = $('dicomweb-token')?.value || '';
  const studyUID = $('dicomweb-study')?.value.trim() || '';
  if (!wadoBase) {
    updateStatus('Enter WADO-RS base URL', 'error');
    operation.finish();
    return;
  }
  if (!studyUID) {
    updateStatus('Set Study UID first (or click Find studies)', 'error');
    operation.finish();
    return;
  }

  setBusy(true);
  try {
    updateStatus('dicomweb: discovering series', 'active');
    const { discoverQidoSeries, resolveDicomwebImportSession } = await import('../dicom/dicomweb-import.js');
    if (!operation.isActive()) return;
    const headers = dicomwebRequestHeaders(bearerToken);
    const session = resolveDicomwebImportSession({
      sessionId: dicomwebState?.sessionId || '',
      wadoBase,
      headers,
    });
    if (!operation.isActive()) return;
    if (dicomwebState) dicomwebState.sessionId = session.id;
    const series = await discoverQidoSeries({
      wadoBase,
      studyUID,
      headers,
      sessionId: session.id,
      signal: operation.signal,
    });
    if (!operation.isActive()) return;
    if (dicomwebState) dicomwebState.series = series;
    if (!series.length) {
      updateStatus('No series found for this study');
      return;
    }
    const preferred = series.find((item) => !isDerivedObjectModality(item.modality)) || series[0];
    $('dicomweb-series').value = preferred.seriesUID || '';
    updateStatus(`dicomweb: found ${series.length} series, selected ${preferred.seriesUID}`, 'active');
  } catch (e) {
    if (isAbortError(e) || !operation.isActive()) return;
    updateStatus(`Error: ${escapeHtml(e.message)}`, 'error', { html: true });
  } finally {
    if (operation.isActive()) setBusy(false);
    operation.finish();
  }
}

export async function handleDicomwebImport(statusEl, selectSeries, setBusy = () => {}, dicomwebState = null, isActive = () => true) {
  const operation = beginDicomwebOperation(dicomwebState, isActive);
  const updateStatus = (...args) => { if (operation.isActive()) setUploadStatus(statusEl, ...args); };
  if (!operation.isActive()) {
    operation.finish();
    return;
  }
  const wadoBase = $('dicomweb-base')?.value.trim() || '';
  const studyUID = $('dicomweb-study')?.value.trim() || '';
  const seriesUID = $('dicomweb-series')?.value.trim() || '';
  const bearerToken = $('dicomweb-token')?.value || '';
  if (!wadoBase || !studyUID || !seriesUID) {
    updateStatus('Enter WADO-RS base URL, Study UID, and Series UID', 'error');
    operation.finish();
    return;
  }

  setBusy(true);
  try {
    updateStatus('dicomweb: fetching metadata', 'active');
    const {
      fetchSeriesMetadata,
      importDicomwebSeries,
      resolveDicomwebImportSession,
    } = await import('../dicom/dicomweb-import.js');
    if (!operation.isActive()) return;
    const headers = dicomwebRequestHeaders(bearerToken);
    const session = resolveDicomwebImportSession({
      sessionId: dicomwebState?.sessionId || '',
      wadoBase,
      headers,
    });
    if (!operation.isActive()) return;
    if (dicomwebState) dicomwebState.sessionId = session.id;
    const metadata = await fetchSeriesMetadata({
      wadoBase,
      studyUID,
      seriesUID,
      headers,
      sessionId: session.id,
      signal: operation.signal,
    });
    if (!operation.isActive()) return;
    const modality = metadata?.[0]?.Modality || '';
    if (isDerivedObjectModality(modality)) {
      const { importDicomwebDerivedObject } = await import('../dicom/dicomweb-derived-import.js');
      if (!operation.isActive()) return;
      const result = await importDicomwebDerivedObject({
        wadoBase,
        studyUID,
        seriesUID,
        headers,
        manifest: state.manifest,
        isActive: operation.isActive,
        signal: operation.signal,
      });
      if (!operation.isActive()) return;
      if (result.skipped) throw new Error(result.reason || 'Could not import DICOMweb derived object');
      if (result.sourceSlug) {
        const idx = state.manifest.series.findIndex((series) => series.slug === result.sourceSlug);
        if (idx >= 0) {
          enableRegionsIfAvailable(state.manifest.series[idx]);
          closeModal('upload-modal');
          await selectSeries(idx);
        }
      }
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
      signal: operation.signal,
      onProgress: (stage, detail) => {
        updateStatus(`${stage}: ${detail}`, 'active');
      },
    });
    if (!operation.isActive()) return;
    if (!result) throw new Error('DICOMweb series could not be parsed');
    updateStatus('Loading DICOMweb series into viewer...', 'active');
    const { injectLocalSeries } = await import('../dicom/dicom-import.js');
    if (!operation.isActive()) return;
    const idx = injectLocalSeries(state.manifest, result.entry, result.sliceCanvases, result.rawVolume);
    closeModal('upload-modal');
    await selectSeries(idx);
  } catch (e) {
    if (isAbortError(e) || !operation.isActive()) return;
    updateStatus(`Error: ${escapeHtml(e.message)}`, 'error', { html: true });
  } finally {
    if (operation.isActive()) setBusy(false);
    operation.finish();
  }
}
