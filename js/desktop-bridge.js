// Electron desktop intake bridge: receives native open-file/folder payloads,
// triages openable images vs. convertible vendor formats vs. sidecar-only
// selections, and routes them into the shared study-upload import path.
import { state } from './core/state.js';
import { $, escapeHtml, showDialog } from './dom.js';
import { notify } from './notify.js';
import {
  DESKTOP_UNSUPPORTED_SELECTION_ADVICE,
  desktopConversionDialogText,
  desktopDerivedSidecarOnlyText,
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

function isDesktopDerivedSidecarRecord(record = {}) {
  return /\.sr$/i.test(record.name || record.path || '');
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

export function wireDesktopBridge(selectSeries) {
  const desktop = globalThis.voxellabDesktop;
  if (!desktop) return;
  desktop.onMenuCommand(({ command } = {}) => {
    if (command === 'show-upload') $('btn-upload')?.click();
    if (command === 'export-screenshot') $('btn-shot')?.click();
  });
  desktop.onOpenPaths(async (payload) => {
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
        showDialog('Open microscopy image first', escapeHtml(desktopMicroscopySidecarOnlyText(microscopySidecars)));
        const { showStudyUploadModal } = await import('./projects/study-upload-modal.js');
        await showStudyUploadModal(selectSeries);
        return;
      }
      const derivedSidecars = sidecars.filter(isDesktopDerivedSidecarRecord);
      if (derivedSidecars.length > 0 && derivedSidecars.length === sidecars.length && !openable.length && !convertible.length && !state.loaded) {
        showDialog('Open source series first', escapeHtml(desktopDerivedSidecarOnlyText(derivedSidecars)));
        const { showStudyUploadModal } = await import('./projects/study-upload-modal.js');
        await showStudyUploadModal(selectSeries);
        return;
      }
      if (convertible.length) {
        const capabilities = await desktop.getConverterCapabilities?.();
        const started = [];
        for (const record of convertible) {
          const ext = String(record.name || record.path || '').toLowerCase().match(/\.[^.]+$/)?.[0] || '';
          const tool = (capabilities?.tools || []).find(item =>
            item.available
            && item.outputKinds?.includes('ome-tiff')
            && item.inputExtensions?.includes(ext));
          if (!tool || !desktop.startConversionJob) continue;
          await desktop.startConversionJob({
            tool: tool.id,
            inputPaths: [record.path],
            outputKind: 'ome-tiff',
          });
          started.push(record);
        }
        const skipped = convertible.filter(record => !started.includes(record));
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
            showDialog('Unsupported desktop selection', triageHtml + advice);
          } else {
            showDialog(
              'Unsupported desktop selection',
              escapeHtml(unsupportedDesktopSelectionText(payload, unsupported)),
            );
          }
        }
        const { showStudyUploadModal } = await import('./projects/study-upload-modal.js');
        await showStudyUploadModal(selectSeries);
        return;
      }
      const { showStudyUploadModal, handleLocalImport } = await import('./projects/study-upload-modal.js');
      await showStudyUploadModal(selectSeries);
      const { desktopFileFromRecord } = await import('./desktop-path-file.js');
      const files = supported.map(record => desktopFileFromRecord(record, desktop));
      await handleLocalImport(files, $('upload-status'), $('upload-modal'), selectSeries, undefined, {
        intake: desktopOpenIntakeContext(payload, supported, unsupported, convertible),
      });
    } catch (e) {
      showDialog('Desktop open failed', escapeHtml(e.message || String(e)));
    }
  });
  desktop.rendererReady?.().catch((e) => {
    showDialog('Desktop bridge failed', escapeHtml(e.message || String(e)));
  });
}
