import { DCMJS_IMPORT_URL } from '../core/dependencies.js';
import { cloudActionCatalog, cloudActionText } from '../cloud-actions.js';

export { cloudActionCatalog, cloudActionText };

const SOURCE_MANIFEST_NAMES = new Set(['voxellab.source.json', 'voxellab-source.json']);
const PROJECTION_MODALITIES = new Set(['CR', 'DX', 'IO', 'MG', 'PX', 'RF', 'XA']);
const PROJECTION_IMAGE_TYPE_TOKENS = new Set(['LOCALIZER', 'SCOUT', 'PROJECTION']);
const PROJECTION_GEOMETRIES = new Set(['parallel-beam-stack', 'circular-cbct', 'limited-angle-tomo']);
const ULTRASOUND_MODES = new Set(['stacked-sector', 'tracked-freehand-sector']);
const ULTRASOUND_PROBE_GEOMETRIES = new Set(['sector', 'curvilinear', 'linear']);
const REGISTRATION_TRANSFORMS = new Set(['rigid', 'translation']);
const MAX_OUTPUT_SHAPE_DIM = 4096;
const MAX_OUTPUT_VOXELS = 256 * 1024 * 1024;

function isCloudSourceManifestFile(file = {}) {
  return SOURCE_MANIFEST_NAMES.has(String(file.name || '').toLowerCase());
}

export function cloudSourceManifestFiles(files = []) {
  return Array.from(files || []).filter(isCloudSourceManifestFile);
}

function cloudDicomFiles(files = []) {
  return Array.from(files || []).filter(file => !isCloudSourceManifestFile(file));
}

function cloudFileSampleNames(files = [], maxSamples = 3) {
  const samples = Array.from(files || [])
    .map(file => String(file.webkitRelativePath || file.path || file.name || '').split('/').filter(Boolean).slice(-2).join('/') || file?.name || '')
    .filter(Boolean)
    .slice(0, maxSamples);
  const hiddenCount = Math.max(0, files.length - samples.length);
  const more = hiddenCount ? `, plus ${hiddenCount} more file${hiddenCount === 1 ? '' : 's'}` : '';
  return samples.length ? `${samples.join(', ')}${more}` : '';
}

function isCloudDicomFile(file = {}) {
  const name = String(file.name || '').toLowerCase();
  const type = String(file.type || '').toLowerCase();
  if (type === 'application/dicom') return true;
  if (/\.(dcm|dicom|ima)$/i.test(name)) return true;
  return !!name && !name.includes('.');
}

function totalFileBytes(files = []) {
  return Array.from(files || []).reduce((sum, file) => sum + Math.max(0, Number(file?.size) || 0), 0);
}

function formatFileBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let scaled = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && scaled >= 1024; index += 1) {
    scaled /= 1024;
    unit = units[index];
  }
  return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)} ${unit}`;
}

export async function readCloudSourceManifest(files = []) {
  const sourceFiles = cloudSourceManifestFiles(files);
  if (!sourceFiles.length) return { payload: null, error: '' };
  if (sourceFiles.length > 1) {
    return { payload: null, error: 'Select exactly one voxellab.source.json calibration manifest for a cloud reconstruction action.' };
  }
  const file = sourceFiles[0];
  if (typeof file.text !== 'function') {
    return { payload: null, error: `${file.name || 'voxellab.source.json'} could not be read.` };
  }
  try {
    const payload = JSON.parse(await file.text());
    if (payload?.sourceKind !== 'projection' && payload?.sourceKind !== 'ultrasound' && payload?.sourceKind !== 'registration') {
      return { payload: null, error: 'voxellab.source.json must declare sourceKind "projection", "ultrasound", or "registration".' };
    }
    return { payload, error: '' };
  } catch {
    return { payload: null, error: 'voxellab.source.json is not valid JSON.' };
  }
}

function dicomValue(meta = {}, key) {
  const value = meta?.[key];
  return Array.isArray(value) ? value[0] : value;
}

function dicomString(meta = {}, key) {
  return String(dicomValue(meta, key) || '').trim();
}

function dicomNumber(meta = {}, key, fallback = 0) {
  const value = Number(dicomValue(meta, key));
  return Number.isFinite(value) ? value : fallback;
}

function dicomImageType(meta = {}) {
  const value = meta?.ImageType;
  return Array.isArray(value) ? value : String(value || '').split('\\');
}

function numberList(value, length) {
  if (!Array.isArray(value) || value.length < length) return [];
  const parsed = value.slice(0, length).map(Number);
  return parsed.every(Number.isFinite) ? parsed : [];
}

function numberArray(value) {
  if (!Array.isArray(value)) return [];
  const parsed = value.map(Number);
  return parsed.every(Number.isFinite) ? parsed : [];
}

function outputShapeOk(value) {
  if (!Array.isArray(value) || value.length !== 3) return false;
  if (!value.every(item => Number.isInteger(item) && item > 0 && item <= MAX_OUTPUT_SHAPE_DIM)) return false;
  return value.reduce((product, item) => product * item, 1) <= MAX_OUTPUT_VOXELS;
}

function matrix4Ok(value) {
  return Array.isArray(value)
    && value.length === 4
    && value.every(row => numberList(row, 4).length === 4);
}

function isProjectionLikeMeta(meta = {}) {
  const modality = dicomString(meta, 'Modality').toUpperCase();
  if (PROJECTION_MODALITIES.has(modality)) return true;
  return dicomImageType(meta).some(value => PROJECTION_IMAGE_TYPE_TOKENS.has(String(value || '').trim().toUpperCase()));
}

async function readCloudDicomMetas(files = []) {
  const lib = await import(DCMJS_IMPORT_URL);
  const { DicomMessage, DicomMetaDictionary } = lib.data;
  const metas = [];
  for (const file of files) {
    try {
      const ds = DicomMessage.readFile(await file.arrayBuffer());
      const meta = DicomMetaDictionary.naturalizeDataset(ds.dict);
      if (!meta.PixelData) return { metas: [], error: `${file.name || 'DICOM file'} has no PixelData.` };
      metas.push({ file, meta });
    } catch {
      return { metas: [], error: `Could not read DICOM metadata from ${file.name || 'selected file'}.` };
    }
  }
  return { metas, error: '' };
}

function oneSeriesPreflightError(metas = [], noun = 'cloud action') {
  const series = new Set(metas.map(item => dicomString(item.meta, 'SeriesInstanceUID')));
  if (series.size > 1) return `Cloud ${noun} requires one coherent DICOM series per job.`;
  return '';
}

function basicImagePreflightError(metas = [], noun = 'cloud action') {
  for (const item of metas) {
    const rows = dicomNumber(item.meta, 'Rows');
    const cols = dicomNumber(item.meta, 'Columns');
    if (!(rows > 0 && cols > 0)) return `Cloud ${noun} requires DICOM images with positive Rows and Columns.`;
  }
  return '';
}

function projectionManifestPreflightError(sourceManifest = {}, projectionCount = 0, seriesUID = '') {
  if (sourceManifest?.sourceKind !== 'projection') return 'voxellab.source.json sourceKind must be projection.';
  if (seriesUID && sourceManifest.seriesUID && String(sourceManifest.seriesUID) !== seriesUID) {
    return 'voxellab.source.json seriesUID does not match the selected projection DICOM series.';
  }
  const projection = sourceManifest.projection;
  if (!projection || typeof projection !== 'object') return 'voxellab.source.json must include a projection calibration object.';
  const geometry = String(projection.geometryModel || projection.geometry || '').trim();
  if (!PROJECTION_GEOMETRIES.has(geometry)) return 'voxellab.source.json projection geometry is not supported.';
  const angles = numberArray(projection.anglesDeg);
  if (angles.length !== projectionCount) {
    return `voxellab.source.json has ${angles.length} calibrated angle${angles.length === 1 ? '' : 's'} but ${projectionCount} DICOM file${projectionCount === 1 ? '' : 's'} selected.`;
  }
  if (!outputShapeOk(projection.outputShape)) return 'voxellab.source.json projection outputShape must be [width, height, depth] positive integers.';
  const spacing = numberList(projection.outputSpacingMm, 3);
  if (spacing.length !== 3 || spacing.some(value => value <= 0)) return 'voxellab.source.json projection outputSpacingMm must contain three positive numbers.';
  if (numberList(projection.firstIPP, 3).length !== 3) return 'voxellab.source.json projection firstIPP must be [x, y, z].';
  if (numberList(projection.orientation, 6).length !== 6) return 'voxellab.source.json projection orientation must contain six direction cosines.';
  if (!String(projection.frameOfReferenceUID || '').trim()) return 'voxellab.source.json projection frameOfReferenceUID is required.';
  return '';
}

function ultrasoundManifestPreflightError(sourceManifest = {}, frameCount = 0, seriesUID = '') {
  if (sourceManifest?.sourceKind !== 'ultrasound') return 'voxellab.source.json sourceKind must be ultrasound.';
  if (seriesUID && sourceManifest.seriesUID && String(sourceManifest.seriesUID) !== seriesUID) {
    return 'voxellab.source.json seriesUID does not match the selected ultrasound DICOM series.';
  }
  const ultrasound = sourceManifest.ultrasound;
  if (!ultrasound || typeof ultrasound !== 'object') return 'voxellab.source.json must include an ultrasound calibration object.';
  const mode = String(ultrasound.mode || '').trim();
  if (!ULTRASOUND_MODES.has(mode)) return 'voxellab.source.json ultrasound mode is not supported.';
  if (!ULTRASOUND_PROBE_GEOMETRIES.has(String(ultrasound.probeGeometry || '').trim())) return 'voxellab.source.json ultrasound probeGeometry is not supported.';
  const theta = numberList(ultrasound.thetaRangeDeg, 2);
  if (theta.length !== 2 || theta[0] === theta[1]) return 'voxellab.source.json ultrasound thetaRangeDeg must be [min, max] with nonzero span.';
  const radius = numberList(ultrasound.radiusRangeMm, 2);
  if (radius.length !== 2 || !(radius[1] > radius[0] && radius[0] >= 0)) return 'voxellab.source.json ultrasound radiusRangeMm must be [min, max] in mm.';
  if (!outputShapeOk(ultrasound.outputShape)) return 'voxellab.source.json ultrasound outputShape must be [width, height, depth] positive integers.';
  const spacing = numberList(ultrasound.outputSpacingMm, 3);
  if (spacing.length !== 3 || spacing.some(value => value <= 0)) return 'voxellab.source.json ultrasound outputSpacingMm must contain three positive numbers.';
  if (numberList(ultrasound.firstIPP, 3).length !== 3) return 'voxellab.source.json ultrasound firstIPP must be [x, y, z].';
  if (numberList(ultrasound.orientation, 6).length !== 6) return 'voxellab.source.json ultrasound orientation must contain six direction cosines.';
  if (mode === 'tracked-freehand-sector' && !String(ultrasound.frameOfReferenceUID || '').trim()) return 'voxellab.source.json ultrasound frameOfReferenceUID is required for tracked freehand scan conversion.';
  const transforms = ultrasound.frameTransformsLps;
  if (mode === 'tracked-freehand-sector' && (!Array.isArray(transforms) || transforms.length !== frameCount || !transforms.every(matrix4Ok))) {
    return `voxellab.source.json must provide one ultrasound frame transform per DICOM frame (${frameCount}).`;
  }
  return '';
}

function registrationManifestPreflightError(sourceManifest = {}, seriesUIDs = new Set()) {
  if (sourceManifest?.sourceKind !== 'registration') return 'voxellab.source.json sourceKind must be registration.';
  const registration = sourceManifest.registration;
  if (!registration || typeof registration !== 'object') return 'voxellab.source.json must include a registration object.';
  const fixed = String(registration.fixedSeriesUID || '').trim();
  const moving = String(registration.movingSeriesUID || '').trim();
  if (!fixed) return 'voxellab.source.json registration.fixedSeriesUID is required.';
  if (!moving) return 'voxellab.source.json registration.movingSeriesUID is required.';
  if (fixed === moving) return 'voxellab.source.json registration movingSeriesUID must differ from fixedSeriesUID.';
  if (!seriesUIDs.has(fixed)) return 'voxellab.source.json registration.fixedSeriesUID does not match the selected DICOM series.';
  if (!seriesUIDs.has(moving)) return 'voxellab.source.json registration.movingSeriesUID does not match the selected DICOM series.';
  const transform = String(registration.transform || registration.transformType || 'rigid').trim() || 'rigid';
  if (!REGISTRATION_TRANSFORMS.has(transform)) return 'voxellab.source.json registration.transform must be rigid or translation.';
  return '';
}

function projectionPreflightError(metas = [], sourceManifest = {}) {
  const seriesError = oneSeriesPreflightError(metas, 'projection reconstruction');
  if (seriesError) return seriesError;
  const imageError = basicImagePreflightError(metas, 'projection reconstruction');
  if (imageError) return imageError;
  const nonProjection = metas.find(item => !isProjectionLikeMeta(item.meta));
  if (nonProjection) {
    return `Cloud projection reconstruction requires projection X-ray DICOM, not ${dicomString(nonProjection.meta, 'Modality') || nonProjection.file.name || 'the selected image'}.`;
  }
  const multiframe = metas.find(item => dicomNumber(item.meta, 'NumberOfFrames', 1) > 1);
  if (multiframe) return 'Cloud projection reconstruction requires single-frame 2D DICOM projections.';
  const seriesUID = dicomString(metas[0]?.meta, 'SeriesInstanceUID');
  const manifestSeriesUID = String(sourceManifest.seriesUID || '').trim();
  if (seriesUID && manifestSeriesUID && seriesUID !== manifestSeriesUID) {
    return 'voxellab.source.json seriesUID does not match the selected projection DICOM series.';
  }
  return projectionManifestPreflightError(sourceManifest, metas.length, seriesUID);
}

function ultrasoundPreflightError(metas = [], sourceManifest = {}) {
  const seriesError = oneSeriesPreflightError(metas, 'ultrasound scan conversion');
  if (seriesError) return seriesError;
  const imageError = basicImagePreflightError(metas, 'ultrasound scan conversion');
  if (imageError) return imageError;
  const nonUltrasound = metas.find(item => dicomString(item.meta, 'Modality').toUpperCase() !== 'US');
  if (nonUltrasound) return `Cloud ultrasound scan conversion requires ultrasound DICOM, not ${dicomString(nonUltrasound.meta, 'Modality') || nonUltrasound.file.name || 'the selected image'}.`;
  const seriesUID = dicomString(metas[0]?.meta, 'SeriesInstanceUID');
  const manifestSeriesUID = String(sourceManifest.seriesUID || '').trim();
  if (seriesUID && manifestSeriesUID && seriesUID !== manifestSeriesUID) {
    return 'voxellab.source.json seriesUID does not match the selected ultrasound DICOM series.';
  }
  const frameCount = metas.reduce((sum, item) => sum + Math.max(1, dicomNumber(item.meta, 'NumberOfFrames', 1)), 0);
  return ultrasoundManifestPreflightError(sourceManifest, frameCount, seriesUID);
}

function registrationPreflightError(metas = [], sourceManifest = {}) {
  const imageError = basicImagePreflightError(metas, 'registration alignment');
  if (imageError) return imageError;
  const nonVolume = metas.find((item) => {
    const modality = dicomString(item.meta, 'Modality').toUpperCase();
    return !['CT', 'MR'].includes(modality) || isProjectionLikeMeta(item.meta);
  });
  if (nonVolume) {
    return `Cloud registration requires CT/MR volume DICOM, not ${dicomString(nonVolume.meta, 'Modality') || nonVolume.file.name || 'the selected image'}.`;
  }
  const seriesUIDs = new Set(metas.map(item => dicomString(item.meta, 'SeriesInstanceUID')).filter(Boolean));
  if (seriesUIDs.size < 2) return 'Cloud registration requires two selected CT/MR DICOM series.';
  const manifestError = registrationManifestPreflightError(sourceManifest, seriesUIDs);
  if (manifestError) return manifestError;
  const registration = sourceManifest.registration || {};
  const fixed = String(registration.fixedSeriesUID || '').trim();
  const moving = String(registration.movingSeriesUID || '').trim();
  const fixedCount = metas.filter(item => dicomString(item.meta, 'SeriesInstanceUID') === fixed).length;
  const movingCount = metas.filter(item => dicomString(item.meta, 'SeriesInstanceUID') === moving).length;
  if (fixedCount < 2 || movingCount < 2) return 'Cloud registration requires at least two DICOM slices for both fixed and moving series.';
  return '';
}

function volumeSegmentationPreflightError(metas = []) {
  const seriesError = oneSeriesPreflightError(metas, 'CT/MR segmentation');
  if (seriesError) return `${seriesError} Use voxellab.source.json for registration/alignment jobs that intentionally select two CT/MR series.`;
  const imageError = basicImagePreflightError(metas, 'CT/MR segmentation');
  if (imageError) return imageError;
  const nonVolume = metas.find((item) => {
    const modality = dicomString(item.meta, 'Modality').toUpperCase();
    return !['CT', 'MR'].includes(modality) || isProjectionLikeMeta(item.meta);
  });
  if (nonVolume) {
    return `Cloud CT/MR segmentation requires one CT/MR volume DICOM series, not ${dicomString(nonVolume.meta, 'Modality') || nonVolume.file.name || 'the selected image'}.`;
  }
  const frames = metas.reduce((sum, item) => sum + Math.max(1, dicomNumber(item.meta, 'NumberOfFrames', 1)), 0);
  if (frames < 2) return 'Cloud CT/MR segmentation requires at least two DICOM slices or frames from one volume series.';
  return '';
}

export async function cloudSourceInputPreflight(files = [], sourceManifest = {}) {
  const sourceKind = sourceManifest?.sourceKind;
  const dicomFiles = cloudDicomFiles(files);
  if (!dicomFiles.length) return { error: '' };
  const blocked = dicomFiles.find(file => !isCloudDicomFile(file));
  if (blocked) return { error: '' };
  const { metas, error } = await readCloudDicomMetas(dicomFiles);
  if (error) return { error };
  return {
    error: sourceKind === 'projection'
      ? projectionPreflightError(metas, sourceManifest)
      : sourceKind === 'ultrasound'
        ? ultrasoundPreflightError(metas, sourceManifest)
        : sourceKind === 'registration'
          ? registrationPreflightError(metas, sourceManifest)
          : volumeSegmentationPreflightError(metas),
  };
}

export function cloudUploadEligibility(files = [], sourceManifest = { payload: null, error: '' }, sourcePreflight = { error: '' }) {
  const list = Array.from(files || []);
  if (!list.length) {
    return {
      eligible: false,
      reason: 'Select DICOM CT/MR files before running cloud GPU processing.',
      buttonLabel: cloudActionText().button,
    };
  }
  if (sourceManifest.error) {
    return {
      eligible: false,
      reason: sourceManifest.error,
      buttonLabel: 'Run cloud action on Modal GPU',
    };
  }
  const dicomFiles = cloudDicomFiles(list);
  const sourceKind = sourceManifest.payload?.sourceKind;
  const processing = sourceKind === 'projection'
    ? { processingMode: 'projection_set_reconstruction', inputKind: 'calibrated_projection_set' }
    : sourceKind === 'ultrasound'
      ? { processingMode: 'ultrasound_scan_conversion', inputKind: 'calibrated_ultrasound_source' }
      : sourceKind === 'registration'
        ? { processingMode: 'rigid_registration', inputKind: 'dicom_registration_pair' }
        : { inputKind: 'dicom_volume_stack' };
  const action = cloudActionText(processing);
  if (sourcePreflight.error) {
    return {
      eligible: false,
      reason: sourcePreflight.error,
      buttonLabel: action.button,
    };
  }
  if (sourceKind && !dicomFiles.length) {
    return {
      eligible: false,
      reason: `Select DICOM source files with voxellab.source.json before running cloud ${action.noun}.`,
      buttonLabel: action.button,
    };
  }
  const blocked = dicomFiles.filter(file => !isCloudDicomFile(file));
  if (blocked.length) {
    const samples = cloudFileSampleNames(blocked);
    const expected = sourceKind
      ? `Cloud ${action.noun} accepts DICOM source files plus voxellab.source.json only`
      : 'Cloud GPU currently accepts DICOM CT/MR volume stacks only';
    return {
      eligible: false,
      reason: `${expected}${samples ? `; selected non-DICOM input: ${samples}` : ''}. Use View locally for NIfTI, microscopy, OME-Zarr, and unrelated sidecars.`,
      buttonLabel: action.button,
    };
  }
  const countText = `${dicomFiles.length} DICOM file${dicomFiles.length === 1 ? '' : 's'}`;
  const manifestText = sourceKind ? ' plus voxellab.source.json' : '';
  const movementText = `Cloud action ready: ${countText}${manifestText} (${formatFileBytes(totalFileBytes(list))}) will upload to R2 for Modal GPU ${action.noun}.`;
  const resultText = action.resultSummary ? ` Expected result: ${action.resultSummary}.` : '';
  return {
    eligible: true,
    reason: `${movementText}${resultText} Your Modal/R2 account may incur compute, storage, or egress charges.`,
    processing,
    buttonLabel: action.button,
  };
}

export function cloudActionProgressText(stage, detail = '', processing = {}) {
  const value = String(detail || '').trim();
  const action = cloudActionText(processing);
  if (stage === 'preparing') return value ? `Preparing cloud ${action.noun}: ${value}` : `Preparing cloud ${action.noun}...`;
  if (stage === 'uploading') return value ? `Uploading ${action.upload} to R2: ${value}` : `Uploading ${action.upload} to R2...`;
  if (stage === 'processing') {
    if (/^starting/i.test(value)) return `Starting cloud ${action.noun} on GPU...`;
    return value ? `Running cloud ${action.noun} on GPU: ${value}` : `Running cloud ${action.noun} on GPU...`;
  }
  if (stage === 'complete') return value ? `Cloud ${action.noun} complete: importing ${value}` : `Cloud ${action.noun} complete: importing result...`;
  if (stage === 'partial') return value ? `Cloud ${action.noun} partial: importing ${value}` : `Cloud ${action.noun} partial: importing available result...`;
  if (stage === 'stopped') return value || `Stopped waiting for cloud ${action.noun}.`;
  return value ? `${stage}: ${value}` : String(stage || 'Cloud action running...');
}
