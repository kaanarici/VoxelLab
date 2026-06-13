const WARNING_LABELS = new Map([
  ['missing_xy_physical_size', 'XY spacing missing'],
  ['missing_z_physical_size', 'Z spacing missing'],
  ['unsupported_x_physical_unit', 'Unsupported X unit'],
  ['unsupported_y_physical_unit', 'Unsupported Y unit'],
  ['unsupported_z_physical_unit', 'Unsupported Z unit'],
  ['imagej_non_metric_resolution', 'Non-metric ImageJ resolution ignored'],
  ['missing_plane_index', 'Filename plane index missing'],
  ['ambiguous_plane_index', 'Duplicate plane indices'],
  ['missing_plane_index_gap', 'Plane index gaps'],
  ['mixed_plane_size', 'Mixed plane size'],
  ['ome_version_missing', 'OME-Zarr version missing'],
  ['ome_version_unrecognized', 'OME-Zarr version unrecognized'],
  ['omero_transitional_metadata', 'OMERO transitional metadata'],
  ['omero_channel_count_mismatch', 'OMERO channel count mismatch'],
  ['pixel_type_unresolved', 'Pixel type unresolved'],
  ['axes_spatial_order_not_zyx', 'Spatial axes are not Z/Y/X'],
  ['multiscales_multiple_entries_first_selected', 'Multiple multiscales entries; first selected'],
]);

function sourceWarnings(series = {}) {
  const seen = new Set();
  const warnings = [
    ...(series.microscopyDataset?.source?.warnings || []),
    ...(series.microscopy?.sequenceWarnings || []),
  ].map(String).filter(Boolean);
  return warnings.filter((warning) => {
    if (seen.has(warning)) return false;
    seen.add(warning);
    return true;
  });
}

function readableWarningCode(warning = '') {
  const arrayMetadataMissing = String(warning || '').match(/^array_metadata_missing_(.+)$/);
  if (arrayMetadataMissing) return `OME-Zarr array metadata missing: ${arrayMetadataMissing[1]}`;
  const axisStringForm = String(warning || '').match(/^axes_(.+)_string_form$/);
  if (axisStringForm) return `OME-Zarr axis uses string form: ${axisStringForm[1]}`;
  const axisMissingType = String(warning || '').match(/^axes_(.+)_missing_type$/);
  if (axisMissingType) return `OME-Zarr axis type missing: ${axisMissingType[1]}`;
  const scalePathUnresolved = String(warning || '').match(/^(.+)_scale_path_unresolved$/);
  if (scalePathUnresolved) return `OME-Zarr scale transform path unresolved: ${scalePathUnresolved[1].replace(/_/g, ' ')}`;
  const translationPathUnresolved = String(warning || '').match(/^(.+)_translation_path_unresolved$/);
  if (translationPathUnresolved) return `OME-Zarr translation transform path unresolved: ${translationPathUnresolved[1].replace(/_/g, ' ')}`;
  const text = String(warning || '').trim().replace(/[_-]+/g, ' ');
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

export function microscopySourceWarningLabels(series = {}) {
  return sourceWarnings(series).map((warning) => WARNING_LABELS.get(warning) || readableWarningCode(warning));
}

export function microscopySourceWarningsText(series = {}) {
  const warnings = microscopySourceWarningLabels(series);
  return warnings.length ? warnings.slice(0, 3).join(', ') + (warnings.length > 3 ? ', ...' : '') : 'None';
}

export function microscopyStreamProvenanceText(series = {}) {
  return String(series.microscopy?.streamProvenance || '').trim();
}

export function microscopySequenceOrderText(series = {}) {
  const source = String(series.microscopyDataset?.source?.originalFormat || series.microscopy?.format || series.sequence || '');
  if (!/^tiff sequence$/i.test(source)) return '';
  const provenance = series.microscopyDataset?.source?.provenance || {};
  const strategy = String(provenance.orderStrategy || '');
  if (strategy === 'numeric-suffix') return 'Numeric filename suffix';
  if (strategy === 'lexical') return 'Lexical filename order';
  return 'Not recorded';
}

function needsZCalibration(series = {}) {
  const zAxis = series.microscopyDataset?.axes?.find((axis) => axis?.name === 'z');
  const sizeZ = Number(zAxis?.size ?? series.microscopy?.sizeZ ?? series.slices ?? 1);
  return sizeZ > 1;
}

function hasKnownZCalibration(series = {}) {
  const z = Number(series.sliceSpacing || series.sliceThickness || 0);
  return z > 0 && series._sliceSpacingKnown !== false;
}

function withZScope(label, series = {}) {
  return needsZCalibration(series) && !hasKnownZCalibration(series) ? `${label} (XY only)` : label;
}

export function microscopyCalibrationSourceText(series = {}, pixelSpacing = []) {
  const row = Number(pixelSpacing?.[0] || 0);
  const col = Number(pixelSpacing?.[1] || 0);
  if (!(row > 0) || !(col > 0) || series._spacingKnown === false) return 'Uncalibrated';
  if (series.microscopy?.calibrationSource === 'manual') return withZScope('Manual calibration', series);
  const source = String(series.microscopyDataset?.source?.originalFormat || series.microscopy?.format || '');
  if (/^tiff sequence$/i.test(source)) return withZScope('Manual calibration', series);
  if (/^ome-zarr$/i.test(source)) return withZScope('OME-Zarr metadata', series);
  if (/^ome-tiff$/i.test(source)) return withZScope('OME-TIFF metadata', series);
  if (/^imagej tiff$/i.test(source)) return withZScope('ImageJ TIFF metadata', series);
  if (/^tiff$/i.test(source)) return withZScope('TIFF metadata', series);
  return withZScope('Metadata calibrated', series);
}

export function microscopyCalibrationTrustText(series = {}, pixelSpacing = []) {
  const row = Number(pixelSpacing?.[0] || 0);
  const col = Number(pixelSpacing?.[1] || 0);
  if (!(row > 0) || !(col > 0) || series._spacingKnown === false) {
    const warnings = new Set(sourceWarnings(series));
    if (warnings.has('unsupported_x_physical_unit') || warnings.has('unsupported_y_physical_unit')) {
      return 'Unknown · XY unit unsupported';
    }
    if (warnings.has('imagej_non_metric_resolution')) {
      return 'Unknown · non-metric resolution ignored';
    }
    return 'Unknown · XY spacing missing';
  }
  const xyOnly = needsZCalibration(series) && !hasKnownZCalibration(series);
  const prefix = series.microscopy?.calibrationSource === 'manual'
    || /^tiff sequence$/i.test(String(series.microscopyDataset?.source?.originalFormat || series.microscopy?.format || series.sequence || ''))
    ? 'Manual calibration'
    : 'Trusted metadata';
  return xyOnly ? `${prefix} · XY trusted, Z unknown` : prefix;
}
