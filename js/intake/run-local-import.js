// Staged local import pipeline. The upload modal is Collect UI only.
import { state } from '../core/state.js';
import { HAS_LOCAL_BACKEND } from '../core/local-backend.js';
import { escapeHtml, closeModal } from '../dom.js';
import { UNRECOGNIZED_JSON_SIDECAR_REASON, sidecarUnsupportedDescription } from '../sidecar-schemas.js';
import { notify } from '../notify.js';
import { enableRegionsIfAvailable, setSeriesDesktopImportId } from '../core/state/viewer-commands.js';
import {
  localFilePath,
  localImportErrorMessage,
  localImportFailedContext,
  localImportIntakeContext,
  mixedNativeImportBoundaryText,
} from '../projects/local-intake-text.js';
import {
  isMicroscopyTiffFile,
  isNiftiFile,
  isVendorMicroscopyFile,
  LOCAL_VENDOR_MICROSCOPY_LABEL,
} from '../projects/local-intake-summary.js';
import { convertVendorMicroscopyFile } from '../projects/vendor-microscopy-convert.js';
import { setUploadStatus } from '../projects/upload-status.js';
import { isOmeZarrFile } from '../microscopy/microscopy-file-kinds.js';
import { desktopMicroscopySidecarOnlyText } from '../desktop-intake-text.js';
import {
  applyRecipeSidecarsForActiveSeries,
  importImageJRoiSidecarsForActiveSeries,
  importRoiSidecarsForActiveSeries,
  microscopySidecarRecords,
  notifyLocalImportOutcome,
  sidecarSkipDetailsText,
  skippedDerivedObjectsText,
  splitMicroscopySidecars,
  unsupportedImageJRoiSidecarText,
} from '../projects/microscopy-sidecars.js';

let localImportBusy = false;

function desktopPathsForImportResult(result, files, { onlyResult = false, associatedPaths = [] } = {}) {
  const explicit = Array.from(result?.desktopSourcePaths || []).map(String).filter(Boolean);
  const associated = Array.from(associatedPaths || []).map(String).filter(Boolean);
  if (explicit.length || associated.length) return [...new Set([...explicit, ...associated])];
  const desktopFiles = Array.from(files || []).filter(file => file?.path);
  const declaredSources = result?.entry?.sourceFiles;
  const sourceFiles = new Set((Array.isArray(declaredSources) ? declaredSources : declaredSources ? [declaredSources] : [])
    .map(value => String(value).replaceAll('\\', '/')));
  const matched = desktopFiles.filter((file) => {
    const relative = localFilePath(file);
    return sourceFiles.has(relative) || sourceFiles.has(file.name) || [...sourceFiles].some(source => relative.endsWith(`/${source}`));
  });
  if (matched.length) return matched.map(file => file.path);
  return onlyResult ? desktopFiles.map(file => file.path) : [];
}

async function persistDesktopImportResult(result, files, opts = {}) {
  const desktop = globalThis.voxellabDesktop;
  if (!desktop?.saveImportedSeries || !result?.entry) return;
  const paths = desktopPathsForImportResult(result, files, opts);
  if (!paths.length) return;
  try {
    const saved = await desktop.saveImportedSeries(paths);
    if (saved?.id) result.entry._desktopImportId = saved.id;
  } catch (error) {
    notify(`Opened ${result.entry.name || 'the series'} for this session, but could not save it for restart: ${error?.message || error}`, {
      id: 'desktop-import-persistence',
      kind: 'warning',
    });
  }
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

export async function handleLocalImport(files, statusEl, modal, selectSeries, setBusy = () => {}, opts = {}) {
  const isActive = opts.isActive instanceof Function ? opts.isActive : () => true;
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
      notifyLocalImportOutcome([
        ...(imageJResult.messages || []),
        ...(recipeResult.messages || []),
        ...(roiResult.messages || []),
      ]);
      return;
    }
    const imageJRoiSidecarsForImport = imageJRoiSidecars.concat(imageJRoiSidecarErrors.map(sidecar => ({ name: sidecar.name || 'imagej.roi', reason: sidecar.reason || 'unsupported or malformed ImageJ ROI sidecar', skipped: true })));
    // Vendor formats convert server-side into OME-TIFF, then take the shared
    // microscopy path. Requires the local backend plus optional readers or a converter.
    const vendorFiles = fileList.filter(isVendorMicroscopyFile);
    let parseConvertedMicroscopyIndividually = false;
    const importOutcome = [];
    if (vendorFiles.length && vendorFiles.length !== fileList.length) {
      fileList = fileList.filter(file => !isVendorMicroscopyFile(file));
      const samples = fileSampleNames(vendorFiles);
      importOutcome.push(`Skipped ${vendorFiles.length} converter-backed file${vendorFiles.length === 1 ? '' : 's'}${samples ? `: ${samples}` : ''}; open them separately with configured local readers or an OME-TIFF converter after loading supported files.`);
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
            importOutcome.push(`${original.name}: ${warning}`);
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
    const streamedIndexes = [];
    const streamedDesktopImports = [];
    let streamedProjectionSetCount = 0;
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
      const { injectLocalSeries, iterateDICOMFileGroups } = await import('../dicom/dicom-import.js');
      if (!isActive()) return;
      const groups = iterateDICOMFileGroups(fileList, (stage, detail) => {
        updateStatus(`${stage}: ${detail}`, 'active');
      });
      for await (const result of groups) {
        if (!isActive()) return;
        updateStatus(`Loading ${result.entry?.name || 'DICOM series'} into viewer...`, 'active');
        const importedIndex = injectLocalSeries(
          state.manifest,
          result.entry,
          result.sliceBytes,
          result.rawVolume,
        );
        streamedIndexes.push(importedIndex);
        streamedDesktopImports.push({
          entry: result.entry,
          desktopSourcePaths: Array.from(result.desktopSourcePaths || []),
          importedIndex,
        });
        if (result.entry?.isProjectionSet) streamedProjectionSetCount += 1;
      }
    }

    const imageResults = results || [];
    updateStatus(imageResults.length || streamedIndexes.length ? 'Loading into viewer...' : 'Applying derived objects...', 'active');
    const projectionSetCount = streamedProjectionSetCount
      + imageResults.filter(result => result.entry?.isProjectionSet).length;
    const indexes = streamedIndexes;
    if (imageResults.length) {
      const { injectLocalSeries } = await import('../dicom/dicom-import.js');
      if (!isActive()) return;
      for (const result of imageResults) {
        const importedIndex = injectLocalSeries(
          state.manifest,
          result.entry,
          result.sliceBytes || result.sliceCanvases,
          result.rawVolume,
          result.localStacks,
          result.rawPlanes,
        );
        indexes.push(importedIndex);
        await persistDesktopImportResult(result, fileList, { onlyResult: imageResults.length === 1 });
        if (result.entry?._desktopImportId) {
          setSeriesDesktopImportId(importedIndex, result.entry._desktopImportId);
        }
      }
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
    const sidecarPathsBySlug = new Map();
    for (const item of derived) {
      if (item.skipped || !item.sourceSlug || !item.desktopSourcePath) continue;
      const paths = sidecarPathsBySlug.get(item.sourceSlug) || [];
      paths.push(item.desktopSourcePath);
      sidecarPathsBySlug.set(item.sourceSlug, paths);
    }
    for (const record of streamedDesktopImports) {
      await persistDesktopImportResult(record, fileList, {
        associatedPaths: sidecarPathsBySlug.get(record.entry.slug) || [],
      });
      if (record.entry._desktopImportId) {
        setSeriesDesktopImportId(record.importedIndex, record.entry._desktopImportId);
      }
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
      const imageJResult = await importImageJRoiSidecarsForActiveSeries(imageJRoiSidecarsForImport, { isActive: isSelectedSeriesActive });
      if (!isSelectedSeriesActive()) return;
      const recipeResult = await applyRecipeSidecarsForActiveSeries(recipeSidecars, { isActive: isSelectedSeriesActive });
      if (!isSelectedSeriesActive()) return;
      const roiResult = await importRoiSidecarsForActiveSeries(roiSidecars, { isActive: isSelectedSeriesActive });
      if (!isSelectedSeriesActive()) return;
      importOutcome.push(...(imageJResult.messages || []), ...(recipeResult.messages || []), ...(roiResult.messages || []));
    }
    if (projectionSetCount > 0) {
      importOutcome.push(`${projectionSetCount} projection set${projectionSetCount > 1 ? 's' : ''} registered for calibrated reconstruction; source images stay 2D until a derived volume exists.`);
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
      importOutcome.push(`Imported ${parts.join(', ')} onto the referenced source series.`);
    }
    if (pendingDerived.length) {
      importOutcome.push(`Holding ${pendingDerived.length} derived object${pendingDerived.length === 1 ? '' : 's'} in this session. They will attach automatically when the matching source series is loaded.`);
    }
    const skippedDerived = derived.filter((item) => item.skipped && !item.pending);
    if (skippedDerived.length) {
      importOutcome.push(skippedDerivedObjectsText(skippedDerived));
    }
    notifyLocalImportOutcome(importOutcome);
  } catch (e) {
    if (!isActive()) return;
    updateStatus(`Error: ${escapeHtml(localImportErrorMessage(e, files, opts.intake))}`, 'error', { html: true });
  } finally {
    localImportBusy = false;
    if (isActive()) setBusy(false);
  }
}
