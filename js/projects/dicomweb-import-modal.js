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

export async function handleDicomwebStudyDiscovery(statusEl, setBusy = () => {}, dicomwebState = null) {
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

export async function handleDicomwebSeriesDiscovery(statusEl, setBusy = () => {}, dicomwebState = null) {
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

export async function handleDicomwebImport(statusEl, selectSeries, setBusy = () => {}, dicomwebState = null) {
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
