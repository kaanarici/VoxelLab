// UI labels for imaging capabilities; geometry rules live in geometry.js.

import {
  classifyGeometryKind,
  isOrthonormalImagePlane,
  sliceAxisAlignmentFromSeries,
} from '../core/geometry.js';

// Shape: modalities whose files are projection images, not voxel-grid slices.
const PROJECTION_MODALITIES = new Set(['CR', 'DX', 'MG', 'XA', 'RF']);

export const GEOMETRY_KIND_CAPABILITY = Object.freeze({
  volumeStack: 'display-volume',
  derivedVolume: 'display-volume',
  projectionSet: 'requires-reconstruction',
  ultrasoundSource: 'requires-reconstruction',
  singleProjection: '2d-only',
  imageStack: '2d-only',
  singleImage: '2d-only',
  microscopyStack: '2d-only',
});

export function geometryKindForSeries(series) {
  if (series?.frameOfReferenceUIDConsistent === false) {
    return Number(series?.slices || 0) > 1 ? 'imageStack' : 'singleImage';
  }
  if (series?.geometryKind) return series.geometryKind;
  const modality = String(series?.modality || '').toUpperCase();
  if (PROJECTION_MODALITIES.has(modality)) {
    return Number(series?.slices || 0) > 1 ? 'projectionSet' : 'singleProjection';
  }
  if (series?.sourceProjectionSetId) return 'derivedVolume';
  if (series?.ultrasoundCalibration?.status === 'calibrated') return 'ultrasoundSource';
  if (series?.imageDomain === 'microscopy' || series?.microscopy) return 'microscopyStack';

  const spacingStats = series?.sliceSpacingStats || {
    mean: Number(series?.sliceSpacing || series?.sliceThickness || 0),
    regular: series?.sliceSpacingRegular !== false,
  };
  const geoKind = classifyGeometryKind(spacingStats, Number(series?.slices || 0));
  if (geoKind === 'cartesian_volume') return 'volumeStack';
  if (geoKind === 'single_frame') return 'singleImage';
  return 'imageStack';
}

export function reconstructionCapabilityForSeries(series) {
  if (series?.frameOfReferenceUIDConsistent === false) return '2d-only';
  if (series?.reconstructionCapability) return series.reconstructionCapability;
  const kind = geometryKindForSeries(series);
  return GEOMETRY_KIND_CAPABILITY[kind] || '2d-only';
}

export function canUseMpr3D(series) {
  if (series?.frameOfReferenceUIDConsistent === false) return false;
  if (series?.imageDomain === 'microscopy' && series?.microscopy?.volumeEligible !== true) return false;
  const kind = geometryKindForSeries(series);
  const capability = reconstructionCapabilityForSeries(series);
  if (!(kind === 'volumeStack' || kind === 'derivedVolume') || capability !== 'display-volume') {
    return false;
  }

  const sliceCount = Number(series?.slices || 0);
  const spacingStats = series?.sliceSpacingStats || {
    mean: Number(series?.sliceSpacing || series?.sliceThickness || 0),
    regular: series?.sliceSpacingRegular !== false,
  };
  const geoKind = classifyGeometryKind(spacingStats, sliceCount);

  if (geoKind !== 'cartesian_volume') return false;

  // Minimum viable geometry fields for MPR/3D rendering.
  const spacing = series?.pixelSpacing || [];
  return sliceAxisAlignmentFromSeries(series) >= 0.9999
    && Number(series?.width || 0) > 0
    && Number(series?.height || 0) > 0
    && Array.isArray(series?.orientation) && series.orientation.length >= 6
    && isOrthonormalImagePlane(series.orientation)
    && Array.isArray(series?.firstIPP) && series.firstIPP.length >= 3
    && Array.isArray(series?.lastIPP) && series.lastIPP.length >= 3
    && Number(spacing[0] || 0) > 0
    && Number(spacing[1] || 0) > 0;
}

export function capabilityLabel(series) {
  const kind = geometryKindForSeries(series);
  const capability = reconstructionCapabilityForSeries(series);
  if (kind === 'derivedVolume') return 'Derived volume';
  if (kind === 'volumeStack') return 'Display volume';
  if (kind === 'microscopyStack') return 'Microscopy stack · 2D only';
  if (kind === 'projectionSet') return 'Projection set · reconstruction required';
  if (kind === 'ultrasoundSource') return 'Ultrasound source · reconstruction required';
  if (kind === 'imageStack') return 'Image stack · 2D only';
  if (kind === 'singleImage') return 'Single image · 2D only';
  if (capability === '2d-only') return '2D projection';
  return capability;
}

export function capabilityBlockReason(series) {
  if (series?.frameOfReferenceUIDConsistent === false) {
    return 'This series mixes DICOM frames of reference, so MPR/3D is blocked to avoid geometric distortion.';
  }
  if (series?._spacingKnown === false) {
    if (series?._niftiSpatialUnit) {
      return `This NIfTI series is uncalibrated because its spatial unit is ${series._niftiSpatialUnit}; MPR/3D needs trusted voxel spacing.`;
    }
    if (series?.dicomImportKind || series?.sourceSeriesUID || series?.sourceStudyUID) {
      return 'This DICOM series is missing trusted pixel spacing, so MPR/3D is blocked to avoid fake geometry.';
    }
    return 'This series is missing trusted pixel spacing, so MPR/3D is blocked to avoid fake geometry.';
  }
  if (series?.imageDomain === 'microscopy' && series?.microscopy?.volumeEligible !== true) {
    if (series?.microscopy?.volumeBlockReason === 'incomplete_z_coverage') {
      return 'Microscopy MPR/3D needs complete contiguous Z coverage for every available channel and timepoint.';
    }
    if (series?.microscopy?.volumeBlockReason === 'volume_source_unavailable') {
      return 'Microscopy MPR/3D needs retained raw planes for the complete active Z stack.';
    }
    if (series?.microscopy?.volumeBlockReason === 'volume_data_invalid') {
      return 'Microscopy MPR/3D is disabled because the retained Z planes do not form one valid scalar volume.';
    }
    if (series?._sliceSpacingKnown === false || Number(series?.slices || 0) < 2) {
      return 'Microscopy MPR/3D needs at least two planes with trusted regular Z spacing.';
    }
    return 'This microscopy stack exceeds the local volume safety budget, so MPR/3D stays disabled.';
  }
  const kind = geometryKindForSeries(series);
  if (kind === 'singleProjection') return 'Single projection images stay 2D; true 3D requires calibrated multi-view reconstruction.';
  if (kind === 'projectionSet') return 'Projection sets must be reconstructed into a derived volume before MPR or 3D viewing.';
  if (kind === 'ultrasoundSource') return 'Calibrated ultrasound sources must be scan-converted into a derived volume before MPR or 3D viewing.';
  if (kind === 'microscopyStack') return 'This microscopy stack needs trusted XY and regular Z calibration before MPR/3D is available.';
  if (kind === 'imageStack') return 'This image stack is missing reliable patient-space slice geometry for MPR or 3D.';
  if (kind === 'singleImage') return 'Single images do not have enough depth for MPR or 3D viewing.';
  if (series?.sliceSpacingRegular === false) return 'This series has irregular slice spacing, so MPR/3D is blocked to avoid geometric distortion.';
  return 'This series lacks the voxel spacing or slice geometry needed for MPR/3D.';
}
