import { extractEnhancedMultiFrameMetas } from './dicom-frame-meta.js';
import { hasVolumeStackGeometry } from './dicom-import-geometry.js';
import { getFloatArray, getInt, getStr, getStrArray, normalizeModality } from './dicom-meta.js';
import { geometryFromDicomMetas } from './geometry.js';
import { classifyUltrasoundSource } from './ultrasound.js';

const PROJECTION_MODALITIES = new Set(['CR', 'DX', 'XA', 'RF', 'MG', 'IO', 'PX']);
const PROJECTION_IMAGE_TYPE_TOKENS = new Set(['LOCALIZER', 'SCOUT', 'PROJECTION']);

function hasProjectionImageType(metas) {
  return metas.some(meta =>
    getStrArray(meta, 'ImageType').some(value =>
      PROJECTION_IMAGE_TYPE_TOKENS.has(value.trim().toUpperCase())
    )
  );
}

/** Classify an import batch as volumetric, projection, ultrasound, or 2D-only before conversion. */
export function classifyDICOMImport(items = [], sourceManifest = null) {
  // Example input: [{ meta: { Modality: "CT", ImagePositionPatient: [...] } }, ...].
  const metas = items.map(item => item.meta || item).filter(Boolean);
  const first = metas[0] || {};
  const modality = normalizeModality(getStr(first, 'Modality', 'OT'));
  const imageCount = metas.length;
  const numberOfFrames = Math.max(...metas.map(meta => getInt(meta, 'NumberOfFrames', 1)), 1);
  const isProjectionModality = PROJECTION_MODALITIES.has(modality);
  const imageTypeProjection = hasProjectionImageType(metas);
  const isProjection = isProjectionModality || imageTypeProjection;
  const ultrasoundSummary = sourceManifest?.sourceKind === 'ultrasound'
    ? {
        status: 'calibrated',
        source: 'external-json',
        probeGeometry: String(sourceManifest?.ultrasound?.probeGeometry || ''),
        mode: String(sourceManifest?.ultrasound?.mode || ''),
      }
    : null;
  const ultrasound = classifyUltrasoundSource(first, ultrasoundSummary);
  if (ultrasound) {
    const restrictedUltrasound = ultrasound.dataType === 'cine' || ultrasound.dataType === '3d-volume';
    return {
      kind: ultrasound.reconstructionEligible
        ? 'ultrasound-source'
        : (restrictedUltrasound ? 'ultrasound-cine' : (imageCount > 1 ? 'image-stack' : 'single-image')),
      modality,
      imageCount,
      numberOfFrames,
      isProjection: false,
      isProjectionSet: false,
      isReconstructedVolumeStack: false,
      hasVolumeStackGeometry: false,
      reason: ultrasound.reason,
      ultrasound,
    };
  }
  if (numberOfFrames > 1) {
    const frameMetas = metas.length === 1 ? extractEnhancedMultiFrameMetas(first) : null;
    const hasSpacing = frameMetas?.every(meta => {
      const spacing = getFloatArray(meta, 'PixelSpacing');
      return Array.isArray(spacing) && spacing.length >= 2 && spacing[0] > 0 && spacing[1] > 0;
    });
    if (frameMetas?.length >= 2 && hasSpacing && hasVolumeStackGeometry(frameMetas)) {
      const geometry = geometryFromDicomMetas(frameMetas);
      const regularStack = geometry?.sliceSpacingRegular !== false;
      return {
        kind: regularStack ? 'volume-stack' : 'image-stack',
        modality,
        imageCount,
        numberOfFrames,
        isProjection: false,
        isProjectionSet: false,
        isReconstructedVolumeStack: regularStack,
        hasVolumeStackGeometry: regularStack,
        reason: regularStack
          ? 'enhanced multi-frame per-frame geometry defines a regular Cartesian volume'
          : 'enhanced multi-frame geometry exists but spacing is irregular, so import stays 2D-only',
      };
    }
    // Do not promote enhanced multi-frame to a volumetric-safe import until
    // the browser path can both extract per-frame geometry and decode/frame
    // pixel data correctly end-to-end.
    return {
      kind: 'multiframe-image',
      modality,
      imageCount,
      numberOfFrames,
      isProjection: false,
      isProjectionSet: false,
      isReconstructedVolumeStack: false,
      hasVolumeStackGeometry: false,
      reason: 'multi-frame DICOM requires dedicated per-frame geometry and pixel extraction before volumetric use',
    };
  }
  const hasStackGeometry = hasVolumeStackGeometry(metas);
  const geometry = hasStackGeometry ? geometryFromDicomMetas(metas) : null;
  const regularStack = hasStackGeometry && geometry?.sliceSpacingRegular !== false;
  const kind = isProjection
    ? (imageCount > 1 ? 'projection-set' : 'single-projection')
    : (regularStack ? 'volume-stack' : (imageCount > 1 ? 'image-stack' : 'single-image'));

  return {
    kind,
    modality,
    imageCount,
    isProjection,
    isProjectionSet: kind === 'projection-set',
    isReconstructedVolumeStack: kind === 'volume-stack',
    hasVolumeStackGeometry: regularStack,
    reason: isProjection
      ? (isProjectionModality ? `${modality} is a projection X-ray modality` : 'ImageType marks projection/localizer/scout data')
      : (regularStack
        ? 'distinct IPP positions along IOP-derived slice normal with regular spacing'
        : (hasStackGeometry ? 'slice geometry exists but spacing is irregular, so import stays 2D-only' : 'no reliable volume-stack geometry')),
  };
}

export function geometryKindForImportKind(kind) {
  return {
    'volume-stack': 'volumeStack',
    'projection-set': 'projectionSet',
    'single-projection': 'singleProjection',
    'ultrasound-source': 'ultrasoundSource',
    'ultrasound-cine': 'imageStack',
    'multiframe-image': 'imageStack',
    'image-stack': 'imageStack',
    'single-image': 'singleImage',
  }[kind] || 'singleImage';
}

export function reconstructionCapabilityForGeometryKind(kind) {
  if (kind === 'volumeStack' || kind === 'derivedVolume') return 'display-volume';
  if (kind === 'projectionSet' || kind === 'ultrasoundSource') return 'requires-reconstruction';
  return '2d-only';
}

export function importRestrictionReason(importClassification) {
  if (!importClassification) return '';
  if (importClassification.kind === 'multiframe-image' || importClassification.kind === 'ultrasound-cine') {
    return importClassification.reason || 'Unsupported multi-frame DICOM import';
  }
  return '';
}
