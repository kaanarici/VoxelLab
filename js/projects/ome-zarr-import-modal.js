import { state } from '../core/state.js';
import { $, escapeHtml, closeModal } from '../dom.js';
import { enableRegionsIfAvailable } from '../core/state/viewer-commands.js';
import { setUploadStatus } from './upload-status.js';

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

  const controller = new AbortController();
  const uploadModal = $('upload-modal');
  const observer = (globalThis.MutationObserver instanceof Function && uploadModal)
    ? new globalThis.MutationObserver(() => { if (!uploadModal.classList.contains('visible')) controller.abort(); })
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
  } catch (e) {
    if (controller.signal.aborted) return;
    const reason = e?.reason || e?.message || 'OME-Zarr streaming failed';
    setUploadStatus(statusEl, `OME-Zarr stream unavailable: ${escapeHtml(reason)}`, 'error', { html: true });
  } finally {
    observer?.disconnect();
    setBusy(false);
  }
}
