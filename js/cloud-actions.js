import { geometryKindForSeries, reconstructionCapabilityForSeries } from './series/series-capabilities.js';

const CLOUD_ACTIONS = Object.freeze([
  Object.freeze({
    id: 'cloud-volume-segmentation',
    label: 'Cloud CT/MR segmentation',
    domain: 'segment',
    processingMode: 'standard',
    inputKind: 'dicom_volume_stack',
    noun: 'segmentation',
    upload: 'DICOM stack',
    inputSummary: 'one DICOM CT/MR volume stack',
    setupSummary: 'no source manifest required',
    resultSummary: 'derived volume overlays, labels, stats, or raw volume when returned by Modal',
    button: 'Process CT/MR on cloud GPU',
  }),
  Object.freeze({
    id: 'cloud-projection-reconstruction',
    label: 'Cloud reconstruction',
    domain: 'register-or-reconstruct',
    processingMode: 'projection_set_reconstruction',
    inputKind: 'calibrated_projection_set',
    noun: 'projection reconstruction',
    upload: 'calibrated projection set',
    inputSummary: 'single-frame projection DICOM files plus voxellab.source.json',
    setupSummary: 'requires projection calibration in voxellab.source.json',
    resultSummary: 'derived volume plus projection provenance when returned by Modal',
    button: 'Reconstruct projection set on cloud GPU',
  }),
  Object.freeze({
    id: 'cloud-rigid-registration',
    label: 'Cloud registration/alignment',
    domain: 'register-or-align',
    processingMode: 'rigid_registration',
    inputKind: 'dicom_registration_pair',
    noun: 'registration alignment',
    upload: 'fixed and moving DICOM stacks plus voxellab.source.json',
    inputSummary: 'two DICOM CT/MR volume stacks plus voxellab.source.json',
    setupSummary: 'requires explicit fixedSeriesUID and movingSeriesUID in voxellab.source.json',
    resultSummary: 'warped moving derived volume plus transform and quality provenance',
    button: 'Register DICOM pair on cloud GPU',
  }),
  Object.freeze({
    id: 'cloud-ultrasound-scan-conversion',
    label: 'Cloud ultrasound scan conversion',
    domain: 'convert-or-normalize',
    processingMode: 'ultrasound_scan_conversion',
    inputKind: 'calibrated_ultrasound_source',
    noun: 'ultrasound scan conversion',
    upload: 'calibrated ultrasound source',
    inputSummary: 'ultrasound DICOM files plus voxellab.source.json',
    setupSummary: 'requires ultrasound geometry in voxellab.source.json',
    resultSummary: 'scan-converted derived volume when returned by Modal',
    button: 'Scan-convert ultrasound on cloud GPU',
  }),
]);

const CT_MR_MODALITIES = new Set(['CT', 'MR']);

function normalizedProcessingMode(processing = {}) {
  return String(processing.processingMode || processing.processing_mode || 'standard').trim() || 'standard';
}

function compactActionValue(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function itemName(item = {}, fallback = 'source') {
  return compactActionValue(item.name || item.slug || item.id || fallback);
}

function boundedList(items = [], limit = 3) {
  const shown = items.slice(0, Math.max(1, limit));
  const hidden = items.length - shown.length;
  return `${shown.join(', ')}${hidden > 0 ? `, plus ${hidden} more` : ''}`;
}

function activeSeriesLabel(series, index, activeIndex) {
  const prefix = index === activeIndex ? 'Active ' : '';
  return `${prefix}${itemName(series, `series #${index + 1}`)}`;
}

function loadedCtMrVolumeState(seriesList = [], activeIndex = -1, limit = 3) {
  const candidates = (Array.isArray(seriesList) ? seriesList : [])
    .map((series, index) => ({ series, index }))
    .filter(({ series }) => {
      const modality = compactActionValue(series?.modality).toUpperCase();
      return CT_MR_MODALITIES.has(modality)
        && geometryKindForSeries(series) === 'volumeStack'
        && reconstructionCapabilityForSeries(series) === 'display-volume'
        && !series?.cloudAction;
    })
    .map(({ series, index }) => activeSeriesLabel(series, index, activeIndex));
  if (!candidates.length) return 'no CT/MR source volume candidate';
  return `CT/MR source volume candidates: ${boundedList(candidates, limit)}`;
}

function projectionSetReady(record = {}) {
  const status = compactActionValue(record.calibrationStatus || record.reconstructionStatus).toLowerCase();
  return status === 'calibrated'
    || Array.isArray(record.projectionMatrices)
    || !!record.projectionCalibration;
}

function loadedProjectionState(projectionSets = [], limit = 3) {
  const records = Array.isArray(projectionSets) ? projectionSets : [];
  if (!records.length) return 'no projection source candidate';
  const ready = [];
  const blocked = [];
  for (const record of records) {
    const status = compactActionValue(record.calibrationStatus || record.reconstructionStatus || 'needs calibration');
    const label = `${itemName(record, 'projection source')} (${status})`;
    if (projectionSetReady(record)) ready.push(label);
    else blocked.push(label);
  }
  return [
    ready.length ? `calibrated projection sources: ${boundedList(ready, limit)}` : '',
    blocked.length ? `projection sources blocked until calibration: ${boundedList(blocked, limit)}` : '',
  ].filter(Boolean).join('; ');
}

function loadedUltrasoundState(seriesList = [], activeIndex = -1, limit = 3) {
  const records = (Array.isArray(seriesList) ? seriesList : [])
    .map((series, index) => ({ series, index }))
    .filter(({ series }) => {
      const calibration = series?.ultrasoundCalibration;
      return compactActionValue(series?.modality).toUpperCase() === 'US'
        && calibration
        && compactActionValue(calibration.status).toLowerCase() === 'calibrated';
    })
    .map(({ series, index }) => {
      const calibration = series.ultrasoundCalibration || {};
      const facts = [
        activeSeriesLabel(series, index, activeIndex),
        compactActionValue(calibration.mode),
        compactActionValue(calibration.probeGeometry),
      ].filter(Boolean);
      return facts.join(' ');
    });
  if (!records.length) return 'no calibrated ultrasound source candidate';
  return `calibrated ultrasound sources: ${boundedList(records, limit)}`;
}

function loadedRegistrationState(seriesList = [], activeIndex = -1, limit = 3) {
  const candidates = (Array.isArray(seriesList) ? seriesList : [])
    .map((series, index) => ({ series, index }))
    .filter(({ series }) => {
      const modality = compactActionValue(series?.modality).toUpperCase();
      return CT_MR_MODALITIES.has(modality)
        && geometryKindForSeries(series) === 'volumeStack'
        && reconstructionCapabilityForSeries(series) === 'display-volume'
        && !series?.cloudAction;
    })
    .map(({ series, index }) => {
      const uid = compactActionValue(series?.sourceSeriesUID);
      const label = activeSeriesLabel(series, index, activeIndex);
      return uid ? `${label} (${uid})` : label;
    });
  if (candidates.length < 2) return 'needs two CT/MR source volume candidates plus explicit fixed/moving UIDs';
  return `registration pair candidates: ${boundedList(candidates, limit)}`;
}

export function cloudActionForProcessing(processing = {}) {
  const mode = normalizedProcessingMode(processing);
  return CLOUD_ACTIONS.find(action => action.processingMode === mode) || CLOUD_ACTIONS[0];
}

export function cloudActionForId(actionId) {
  const id = String(actionId || '').trim();
  return CLOUD_ACTIONS.find(action => action.id === id) || null;
}

export function cloudActionCatalog() {
  return CLOUD_ACTIONS;
}

export function cloudActionText(processing = {}) {
  const action = cloudActionForProcessing(processing);
  return {
    id: action.id,
    label: action.label,
    noun: action.noun,
    upload: action.upload,
    button: action.button,
    inputSummary: action.inputSummary,
    setupSummary: action.setupSummary,
    resultSummary: action.resultSummary,
  };
}

function cloudActionReadinessText(status = {}) {
  if (status.available) return 'ready from Upload study when matching files are selected';
  const message = String(status.message || 'Cloud GPU processing is not ready.').trim();
  if (status.code === 'disabled') return `blocked: ${message}`;
  if (status.code === 'setup-required' || status.code === 'storage-required') return `setup required: ${message}`;
  return `blocked: ${message}`;
}

function cloudActionReadinessKind(status = {}) {
  if (status.available) return 'ready';
  if (status.code === 'setup-required' || status.code === 'storage-required') return 'setup-required';
  return 'blocked';
}

function cloudActionLoadedState(action, context = {}) {
  const seriesList = context.seriesList;
  const activeIndex = Number.isInteger(context.activeIndex) ? context.activeIndex : -1;
  const limit = Number.isInteger(context.limit) ? context.limit : 3;
  if (!seriesList && !context.projectionSets) return '';
  if (action.id === 'cloud-volume-segmentation') return loadedCtMrVolumeState(seriesList, activeIndex, limit);
  if (action.id === 'cloud-projection-reconstruction') return loadedProjectionState(context.projectionSets, limit);
  if (action.id === 'cloud-rigid-registration') return loadedRegistrationState(seriesList, activeIndex, limit);
  if (action.id === 'cloud-ultrasound-scan-conversion') return loadedUltrasoundState(seriesList, activeIndex, limit);
  return '';
}

function cloudActionNextStep(action, readinessKind, loadedState) {
  if (readinessKind === 'setup-required') return 'finish Cloud settings setup before selecting source files';
  if (readinessKind === 'blocked') return 'resolve the Cloud GPU runtime blocker before selecting source files';
  if (loadedState.startsWith('no ') || loadedState.startsWith('needs ')) {
    return `load ${action.inputSummary} before launching ${action.button}`;
  }
  if (loadedState.includes('blocked until')) return `finish source prerequisites before launching ${action.button}`;
  return `use Upload study to select ${action.upload} and run ${action.button}`;
}

export function cloudActionWorkflowRecords(status = {}, context = {}) {
  const readiness = cloudActionReadinessText(status);
  const readinessKind = cloudActionReadinessKind(status);
  return CLOUD_ACTIONS.map((action) => {
    const loadedState = cloudActionLoadedState(action, context);
    return {
      id: action.id,
      label: action.label,
      domain: action.domain,
      processingMode: action.processingMode,
      inputKind: action.inputKind,
      readiness,
      readinessKind,
      loadedState,
      inputSummary: action.inputSummary,
      setupSummary: action.setupSummary,
      resultSummary: action.resultSummary,
      nextStep: cloudActionNextStep(action, readinessKind, loadedState),
    };
  });
}

export function cloudActionWorkflowLines(status = {}, context = {}) {
  return cloudActionWorkflowRecords(status, context).map((record) => {
    const appState = record.loadedState ? `; loaded study: ${record.loadedState}` : '';
    return `${record.label}: ${record.readiness}${appState}; input ${record.inputSummary}; ${record.setupSummary}; result ${record.resultSummary}.`;
  });
}
