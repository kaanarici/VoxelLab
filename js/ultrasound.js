const _PROBE_GEOMETRIES = new Set(['sector', 'linear', 'curvilinear', '3d-probe', 'unknown']);

function calibrationSummary(summary = null) {
  if (!summary || Array.isArray(summary) || Object.getPrototypeOf(summary) !== Object.prototype) return null;
  const status = String(summary.status || '').trim().toLowerCase();
  const source = String(summary.source || '').trim().toLowerCase();
  const probeGeometry = String(summary.probeGeometry || '').trim().toLowerCase();
  const mode = String(summary.mode || '').trim().toLowerCase();
  if (status !== 'calibrated' || source !== 'external-json' || !_PROBE_GEOMETRIES.has(probeGeometry)) return null;
  return { status, source, probeGeometry, mode };
}

export function classifyUltrasoundSource(meta = {}, summary = null) {
  const modality = String(meta.Modality || '').toUpperCase();
  const numberOfFrames = Number(meta.NumberOfFrames || 1);
  const imageType = Array.isArray(meta.ImageType) ? meta.ImageType : [];

  if (modality !== 'US') return null;

  let dataType = 'still';
  if (numberOfFrames > 1) dataType = 'cine';
  if (imageType.some(t => String(t).toUpperCase() === 'VOLUME')) dataType = '3d-volume';
  if (imageType.some(t => String(t).toUpperCase() === 'DOPPLER')) dataType = 'doppler';
  if (imageType.some(t => String(t).toUpperCase() === 'M_MODE' || String(t).toUpperCase() === 'M-MODE')) dataType = 'm-mode';

  const regions = Array.isArray(meta.SequenceOfUltrasoundRegions) ? meta.SequenceOfUltrasoundRegions : [];
  const formats = new Set(regions.map(region => Number(region.RegionSpatialFormat)));
  if (formats.has(2)) dataType = 'm-mode';
  if (formats.has(3)) dataType = 'doppler';
  if (formats.has(4)) dataType = 'waveform';
  if (formats.has(5)) dataType = 'graphics';
  const calibration = calibrationSummary(summary);
  const probeGeometry = calibration?.probeGeometry || 'unknown';
  const reconstructionEligible = !!calibration
    && !['doppler', 'm-mode', 'waveform', 'graphics'].includes(dataType)
    && [...formats].every(format => format === 1);
  return {
    modality: 'US',
    dataType,
    probeGeometry,
    numberOfFrames,
    volumetricEligible: false,
    scanConversionAvailable: reconstructionEligible,
    reconstructionEligible,
    calibrationStatus: calibration ? 'calibrated' : 'missing',
    calibrationSource: calibration?.source || '',
    calibrationSummary: calibration,
    reason: reconstructionEligible
      ? 'Calibrated ultrasound source requires scan conversion before volumetric use.'
      : volumetricBlockReason(dataType),
  };
}

function volumetricBlockReason(dataType) {
  if (dataType === 'waveform' || dataType === 'graphics') return 'Waveforms and graphics cannot define a spatial volume.';
  if (dataType === 'doppler') return 'Doppler reconstruction is not supported. The source remains available in 2D.';
  if (dataType === 'm-mode') return 'M-mode is a time-distance plot — not a spatial volume.';
  if (dataType === '3d-volume') return '3D ultrasound volumes require probe-specific scan-conversion before Cartesian volumetric use.';
  if (dataType === 'cine') return 'Ultrasound cine loops are temporal sequences — volumetric use requires scan-converted spatial reconstruction.';
  return 'Ultrasound data stays 2D until scan-conversion produces a Cartesian derived volume.';
}
