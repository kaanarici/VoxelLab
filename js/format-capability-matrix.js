import { escapeHtml } from './dom.js';

export const FORMAT_CAPABILITY_ROWS = Object.freeze([
  Object.freeze({
    status: 'Native',
    format: 'DICOM CT/MR',
    note: 'Local or DICOMweb import; MPR/3D only when geometry is consistent.',
  }),
  Object.freeze({
    status: 'Native',
    format: 'NIfTI .nii/.nii.gz',
    note: 'Browser-local volume import with measured voxel spacing when metadata is present.',
  }),
  Object.freeze({
    status: 'Native',
    format: 'OME-TIFF / ImageJ TIFF',
    note: 'Uncompressed signed/unsigned 8/16-bit grayscale, C/T solo-channel, composite, split-preview, workflow recipe save/replay, and calibrated ROI measurements when spacing metadata is present.',
  }),
  Object.freeze({
    status: 'Native',
    format: 'ImageJ ROI .roi',
    note: 'Limited ImageJ ROI Manager sidecar import for rect, oval, straight-line, angle, polygon/freehand, traced, and point ROIs when co-dropped with a supported microscopy image or opened onto the active microscopy series.',
  }),
  Object.freeze({
    status: 'Native',
    format: 'ImageJ ROI .zip',
    note: 'Limited ImageJ ROI ZIP import for stored/deflated supported ROI sidecars when co-dropped or opened onto the active microscopy series, plus VoxelLab-authored uncompressed ZIP export including straight-line and angle measurements; broader ROI Manager type parity is not claimed yet.',
  }),
  Object.freeze({
    status: 'Converted',
    format: 'SEG / RTSTRUCT / SR / RT Dose',
    note: 'Session-bound import onto a loaded source; SR re-import is limited to VoxelLab-exported measurement notes, and dose-grid rendering is not complete.',
  }),
  Object.freeze({
    status: 'Converted',
    format: 'Projection / ultrasound jobs',
    note: 'Optional runtime can emit a derived volume; raw inputs stay 2D unless calibrated.',
  }),
  Object.freeze({
    status: 'Native',
    format: 'TIFF image sequences',
    note: 'Homogeneous single-plane TIFF sets import as one ordered Z stack with provenance; manual XY/Z calibration can promote trusted measurements.',
  }),
  Object.freeze({
    status: 'Native',
    format: 'OME-Zarr (limited)',
    note: 'Local OME-NGFF 0.4-style zarr v2, uncompressed level-0 local chunks only; metadata-only fallback for compressed, remote, pyramid, or broader OME-Zarr.',
  }),
  Object.freeze({
    status: 'Unsupported',
    format: 'Compressed TIFF / BigTIFF / tiled pyramids',
    note: 'Convert to uncompressed OME-TIFF/OME-Zarr first; browser import fails closed.',
  }),
  Object.freeze({
    status: 'Converted',
    format: 'CZI / ND2 / LIF / OIB / OIF / LSM bridge',
    note: 'Local backend can convert CZI/ND2/LIF with optional readers or CZI/ND2/LIF/OIB/OIF/LSM through a configured external OME-TIFF converter; Electron uses the same external-converter boundary. This is not native browser import or first-party Bio-Formats parity.',
  }),
]);

export function renderFormatCapabilityMatrix(rows = FORMAT_CAPABILITY_ROWS) {
  const renderedRows = rows.map(({ status, format, note }) => `
    <div class="format-capability-row" role="row" data-status="${escapeHtml(String(status).toLowerCase())}">
      <span class="format-capability-status" role="cell">${escapeHtml(status)}</span>
      <span class="format-capability-format" role="cell">${escapeHtml(format)}</span>
      <span class="format-capability-note" role="cell">${escapeHtml(note)}</span>
    </div>
  `).join('');
  return `
    <div class="format-capability-matrix" role="table" aria-label="Format support matrix">
      <div class="format-capability-title">Format support</div>
      <div class="format-capability-head" role="row">
        <span role="columnheader">Status</span>
        <span role="columnheader">Input</span>
        <span role="columnheader">Boundary</span>
      </div>
      ${renderedRows}
    </div>
  `;
}
