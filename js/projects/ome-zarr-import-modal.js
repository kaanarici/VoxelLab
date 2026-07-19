// OME-Zarr streaming import for the upload modal: a user-provided image-group URL
// is streamed directly in the browser. The zarr stream parser loads lazily. Closing
// the upload modal mid-stream aborts the fetch/decode so no series is injected after
// the modal is gone.
import { state } from '../core/state.js';
import { $, escapeHtml, closeModal } from '../dom.js';
import { notify } from '../notify.js';
import { enableRegionsIfAvailable } from '../core/state/viewer-commands.js';
import { setUploadStatus } from './upload-status.js';

// A user-provided OME-Zarr URL is fetched directly from the browser: the user
// authorized that specific cross-origin source, the page CSP allows
// `connect-src https:`, and public OME-Zarr stores (IDR and most S3/GCS NGFF
// mirrors) send permissive CORS. Anonymous CORS is used; a host without CORS
// fails closed with a network error rather than being silently server-proxied.
function omeZarrStreamFetch() {
  return (url, options) => fetch(url, { mode: 'cors', credentials: 'omit', ...options });
}

const OME_ZARR_STREAM_PROGRESS = {
  metadata: (detail) => `OME-Zarr: ${detail}`,
  level: (detail) => `OME-Zarr: ${detail}`,
  planes: (detail) => `OME-Zarr: streaming planes ${detail}`,
};

export async function handleOmeZarrStreamImport(statusEl, modal, selectSeries, setBusy = () => {}) {
  const rawUrl = $('ome-zarr-url')?.value.trim() || '';
  if (!rawUrl) {
    setUploadStatus(statusEl, 'Enter an OME-Zarr image group URL', 'error');
    return;
  }
  if (!/^https?:\/\//i.test(rawUrl)) {
    setUploadStatus(statusEl, 'OME-Zarr URL must be an absolute http(s) address', 'error');
    return;
  }

  setBusy(true);
  // Closing the upload modal mid-stream aborts the fetch/decode so no series is
  // injected after the modal is gone. closeModal only toggles the `visible` class,
  // so observe it rather than hooking every close affordance.
  const controller = new AbortController();
  const uploadModal = $('upload-modal');
  const observer = (typeof MutationObserver !== 'undefined' && uploadModal)
    ? new MutationObserver(() => { if (!uploadModal.classList.contains('visible')) controller.abort(); })
    : null;
  observer?.observe(uploadModal, { attributes: true, attributeFilter: ['class'] });
  try {
    setUploadStatus(statusEl, 'OME-Zarr: reading metadata...', 'active');
    const { streamOmeZarrFromUrl } = await import('../microscopy/zarr/zarr-stream-import.js');
    const stream = await streamOmeZarrFromUrl(rawUrl.replace(/\/+$/, ''), {
      fetchImpl: omeZarrStreamFetch(),
      signal: controller.signal,
      onProgress: (stage, detail) => {
        const format = OME_ZARR_STREAM_PROGRESS[stage] || ((value) => `OME-Zarr: ${value}`);
        setUploadStatus(statusEl, format(detail), 'active');
      },
    });
    if (controller.signal.aborted) return;
    observer?.disconnect();
    if (!stream?.results?.length) throw new Error('OME-Zarr stream produced no image planes');
    setUploadStatus(statusEl, `OME-Zarr: ${stream.provenance} — loading into viewer...`, 'active');
    const { injectLocalSeries } = await import('../dicom/dicom-import.js');
    const indexes = stream.results.map(result =>
      injectLocalSeries(state.manifest, result.entry, result.sliceCanvases, result.rawVolume, result.localStacks, result.rawPlanes)
    );
    closeModal('upload-modal');
    const selectedIndex = indexes[0];
    if (selectedIndex >= 0) {
      enableRegionsIfAvailable(state.manifest.series[selectedIndex]);
      await selectSeries(selectedIndex);
    }
    notify(stream.provenance);
  } catch (e) {
    if (controller.signal.aborted) return;
    const reason = e?.reason || e?.message || 'OME-Zarr streaming failed';
    setUploadStatus(statusEl, `OME-Zarr stream unavailable: ${escapeHtml(reason)}`, 'error', { html: true });
  } finally {
    observer?.disconnect();
    setBusy(false);
  }
}
