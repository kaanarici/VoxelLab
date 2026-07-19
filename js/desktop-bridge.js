// Electron desktop intake bridge: receives native open-file/folder payloads,
// triages openable images vs. convertible vendor formats vs. sidecar-only
// selections, and routes them into the shared study-upload import path.
import { state } from './core/state.js';
import { $, closeModal, escapeHtml, showDialog } from './dom.js';
import { notify } from './notify.js';
import {
  DESKTOP_UNSUPPORTED_SELECTION_ADVICE,
  desktopConversionDialogText,
  desktopIntakeNotice,
  desktopMicroscopySidecarOnlyText,
  unsupportedDesktopSelectionText,
} from './desktop-intake-text.js';
import { intakeTriageHtml } from './projects/local-intake-triage.js';

function isDesktopSidecarRecord(record = {}) {
  return /\.(json|roi|sr|zip)$/i.test(record.name || record.path || '');
}

function isDesktopMicroscopySidecarRecord(record = {}) {
  return /\.(json|roi|zip)$/i.test(record.name || record.path || '');
}

function hasActiveMicroscopySeries() {
  return state.loaded && state.manifest?.series?.[state.seriesIdx]?.imageDomain === 'microscopy';
}

function desktopOpenIntakeContext(payload = {}, supported = [], unsupported = [], convertible = []) {
  const summary = payload?.folderSummary || null;
  const unsupportedFiles = unsupported.filter(record => record?.kind !== 'folder');
  const sidecars = supported.filter(isDesktopSidecarRecord);
  const openable = supported.filter(record => !isDesktopSidecarRecord(record));
  const skippedItem = record => ({
    ...record,
    skipReason: record?.skipReason || record?.reason || '',
  });
  const skippedSamples = [
    ...unsupportedFiles.map(skippedItem),
    ...(summary?.skippedUnsupportedSamples || []).map(skippedItem),
  ];
  return {
    counts: {
      openable: openable.length,
      convertible: convertible.length,
      sidecar: sidecars.length,
    },
    formatItems: { openable, convertible, sidecar: sidecars },
    checkedFiles: Number(summary?.scannedFiles || 0) || (supported.length + unsupportedFiles.length + convertible.length),
    skipped: skippedSamples,
    skippedCount: unsupportedFiles.length + Number(summary?.skippedUnsupportedFiles || 0),
    failedFiles: Number(summary?.failedFiles || 0),
    failedFileSamples: (summary?.failedFileSamples || []).map(skippedItem),
    warnings: Array.isArray(payload?.warnings) ? payload.warnings : [],
    warningCount: Number(summary?.warningCount ?? payload?.warnings?.length ?? 0),
    failedFolderReads: Number(summary?.failedFolderReads ?? 0),
  };
}

export function createLatestDesktopIntakeDrain(processPayload) {
  let pending = null;
  let draining = false;
  let latest = null;

  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (pending) {
        const intake = pending;
        pending = null;
        await processPayload(intake.payload, () => intake === latest);
      }
    } finally {
      draining = false;
      if (pending) void drain();
    }
  };

  return (payload) => {
    latest = { payload };
    pending = latest;
    void drain();
  };
}

export function wireDesktopBridge(selectSeries) {
  const desktop = globalThis.voxellabDesktop;
  if (!desktop) return;
  let dismissDesktopIntakeDialog = null;
  const cloudJobBlocksDesktopIntake = () => {
    const uploadModal = $('upload-modal');
    if (!uploadModal?.classList.contains('visible') || uploadModal.dataset.closeBlocked !== 'true') return false;
    uploadModal.dispatchEvent(new CustomEvent('voxellab:modal-close-blocked', { bubbles: true }));
    notify('Stop the active cloud job before opening another study.', { id: 'desktop-intake', duration: 9000 });
    return true;
  };
  const showDesktopIntakeDialog = (title, body, { chooseOtherFiles = false } = {}) => {
    if (cloudJobBlocksDesktopIntake()) return;
    if ($('upload-modal')?.classList.contains('visible')) closeModal('upload-modal');
    const action = chooseOtherFiles
      ? '<div class="upload-actions upload-copy-spaced"><button class="btn upload-action" id="desktop-intake-choose-files" type="button">Choose other files</button></div>'
      : '';
    const dismiss = showDialog(title, body + action);
    dismissDesktopIntakeDialog = () => {
      if ($('confirm-title')?.textContent === title) dismiss();
    };
    $('desktop-intake-choose-files')?.addEventListener('click', async () => {
      dismiss();
      dismissDesktopIntakeDialog = null;
      try {
        const { showStudyUploadModal } = await import('./projects/study-upload-modal.js');
        await showStudyUploadModal(selectSeries);
        await desktop.openFiles();
      } catch (error) {
        showDesktopIntakeDialog(
          'File open failed',
          escapeHtml(error?.message || 'The native file picker could not be opened.'),
          { chooseOtherFiles: true },
        );
      }
    }, { once: true });
  };
  desktop.onMenuCommand(({ command } = {}) => {
    if (command === 'show-upload') $('btn-upload')?.click();
    if (command === 'export-screenshot') $('btn-shot')?.click();
    if (command === 'show-cloud-settings') {
      void import('./cloud-settings-ui.js').then(mod => mod.openCloudSettingsModal());
    }
  });
  const enqueueDesktopIntake = createLatestDesktopIntakeDrain(async (payload, isCurrentIntake) => {
    if (cloudJobBlocksDesktopIntake()) return;
    let isModalSessionActive = null;
    try {
      const unsupported = payload?.unsupported || [];
      const convertible = (payload?.convertible || []).filter(record => record.kind === 'file');
      const supported = (payload?.supported || []).filter(record => record.kind === 'file');
      const sidecars = supported.filter(isDesktopSidecarRecord);
      const openable = supported.filter(record => !isDesktopSidecarRecord(record));
      const notice = desktopIntakeNotice(payload, openable, sidecars, convertible, unsupported);
      if (notice) notify(notice, { id: 'desktop-intake', duration: 9000 });
      const microscopySidecars = sidecars.filter(isDesktopMicroscopySidecarRecord);
      if (microscopySidecars.length > 0 && microscopySidecars.length === sidecars.length && !openable.length && !convertible.length && !hasActiveMicroscopySeries()) {
        if (!isCurrentIntake()) return;
        showDesktopIntakeDialog(
          'Open microscopy image first',
          escapeHtml(desktopMicroscopySidecarOnlyText(microscopySidecars)),
          { chooseOtherFiles: true },
        );
        return;
      }
      if (convertible.length) {
        const capabilities = await desktop.getConverterCapabilities?.();
        if (!isCurrentIntake()) return;
        const started = [];
        const skipped = [];
        for (const record of convertible) {
          const ext = String(record.name || record.path || '').toLowerCase().match(/\.[^.]+$/)?.[0] || '';
          const compatibleTools = (capabilities?.tools || []).filter(item =>
            item.outputKinds?.includes('ome-tiff') && item.inputExtensions?.includes(ext));
          const tool = compatibleTools.find(item => item.available);
          if (!tool || !desktop.startConversionJob) {
            const diagnostic = compatibleTools.find(item => item.reason && item.reason !== 'converter_not_configured') || compatibleTools[0];
            skipped.push({ ...record, conversionReason: diagnostic?.reason || '', converterEnv: diagnostic?.env || '' });
            continue;
          }
          await desktop.startConversionJob({
            tool: tool.id,
            inputPaths: [record.path],
            outputKind: 'ome-tiff',
          });
          if (!isCurrentIntake()) return;
          started.push(record);
        }
        showDialog(
          started.length ? 'Converting desktop files' : 'Conversion required',
          escapeHtml(desktopConversionDialogText(started, skipped)),
        );
      }
      if (!supported.length) {
        if (unsupported.length) {
          const intake = desktopOpenIntakeContext(payload, [], unsupported, convertible);
          const triageHtml = intakeTriageHtml(intake);
          if (triageHtml) {
            const advice = `<p class="upload-triage-advice">${escapeHtml(DESKTOP_UNSUPPORTED_SELECTION_ADVICE)}</p>`;
            showDesktopIntakeDialog('Unsupported desktop selection', triageHtml + advice, { chooseOtherFiles: true });
          } else {
            showDesktopIntakeDialog(
              'Unsupported desktop selection',
              escapeHtml(unsupportedDesktopSelectionText(payload, unsupported)),
              { chooseOtherFiles: true },
            );
          }
          return;
        }
        const { showStudyUploadModal } = await import('./projects/study-upload-modal.js');
        if (!isCurrentIntake()) return;
        await showStudyUploadModal(selectSeries);
        return;
      }
      const { showStudyUploadModal, handleLocalImport } = await import('./projects/study-upload-modal.js');
      if (!isCurrentIntake()) return;
      isModalSessionActive = await showStudyUploadModal(selectSeries);
      if (!isModalSessionActive?.() || !isCurrentIntake()) return;
      const { desktopFileFromRecord } = await import('./desktop-path-file.js');
      if (!isModalSessionActive() || !isCurrentIntake()) return;
      const files = supported.map(record => desktopFileFromRecord(record, desktop));
      await handleLocalImport(files, $('upload-status'), $('upload-modal'), selectSeries, undefined, {
        intake: desktopOpenIntakeContext(payload, supported, unsupported, convertible),
        isActive: () => isCurrentIntake() && isModalSessionActive(),
      });
    } catch (e) {
      if (!isCurrentIntake() || (isModalSessionActive && !isModalSessionActive())) return;
      showDialog('Desktop open failed', escapeHtml(e.message || String(e)));
    }
  });
  desktop.onOpenPaths((payload) => {
    dismissDesktopIntakeDialog?.();
    dismissDesktopIntakeDialog = null;
    enqueueDesktopIntake(payload);
  });
  desktop.rendererReady?.().catch((e) => {
    showDialog('Desktop bridge failed', escapeHtml(e.message || String(e)));
  });
}
