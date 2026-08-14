import { escapeHtml } from './dom.js';

export const FORMAT_CAPABILITY_ROWS = Object.freeze([
  Object.freeze({
    status: 'Native',
    format: 'DICOM CT/MR/PT/NM/OT',
    note: 'Local or DICOMweb scalar import; calibrated MPR/3D requires consistent patient-space geometry and a supported pixel layout.',
  }),
  Object.freeze({
    status: 'Native',
    format: 'NIfTI-1/2 .nii/.nii.gz',
    note: 'Browser-local 3D import plus bounded scalar dim-4 data as related independently selectable 3D timepoints with one shared display window and provenance. Supported scalar types include signed 8-bit and unsigned 32-bit data. Paired files, dim-5+, frequency axes, invalid single-file magic or spatial affines, unsafe NIfTI-2 dimensions, and oversized inputs fail closed; unknown spatial units stay uncalibrated.',
  }),
  Object.freeze({
    status: 'Native',
    format: 'OME-TIFF / ImageJ TIFF',
    note: 'Classic stripped signed/unsigned 8/16/32-bit integer or 32-bit float samples with uncompressed, standard LZW, or Deflate storage and Predictor 1/2. Complete calibrated stacks support MPR/3D; interleaved RGB/RGBA opens as channels; raw line profiles, bounded two-channel colocalization, workflow recipes, and calibrated measurements use retained source planes.',
  }),
  Object.freeze({
    status: 'Native',
    format: 'ImageJ ROI .roi',
    note: 'Limited ImageJ ROI Manager sidecar import for rect, oval, straight-line, angle, polygon/freehand, traced, point, and open PolyLine ROIs when co-dropped with a supported microscopy image or opened onto the active microscopy series. Two vertices become a straight line; longer PolyLines retain open multi-vertex geometry. Unsupported ROI types reject.',
  }),
  Object.freeze({
    status: 'Native',
    format: 'ImageJ ROI .zip',
    note: 'Limited ImageJ ROI ZIP import for unencrypted stored/deflated supported ROI sidecars with valid CRC32 checksums when co-dropped or opened onto the active microscopy series, with hard entry-count and encoded/decoded byte budgets. VoxelLab can export uncompressed ZIP sidecars for supported rows, straight-line measurements, and angle measurements; encrypted or checksum-invalid entries and broader ROI Manager type parity are not supported.',
  }),
  Object.freeze({
    status: 'Converted',
    format: 'SEG / RTSTRUCT / SR / RT Dose',
    note: 'A bounded session queue can retain supported objects until the matching source loads; SR re-import is limited to VoxelLab-exported measurement notes. RT Dose validates its frame of reference, positive dose-grid dimensions, and scaling as metadata only: its dose grid is never decoded, rendered, calculated, or exported.',
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
    note: 'Local import safely selects a usable multiscale level and URL streaming supports OME-NGFF 0.4/0.5. Zarr v2 supports raw, zlib, gzip, zstd, and the supported Blosc subset with optional byte shuffle; bounded unsharded Zarr v3 supports regular arrays, default chunk keys, and bytes plus gzip, zstd, or supported Blosc codecs. CORS is required for URLs. Hard limits and unsupported filters, codecs, axes, or sharding fail closed.',
  }),
  Object.freeze({
    status: 'Unsupported',
    format: 'TIFF JPEG / BigTIFF / tiled pyramids',
    note: 'Convert to supported stripped LZW/Deflate TIFF or OME-Zarr first; browser import fails closed.',
  }),
  Object.freeze({
    status: 'Converted',
    format: 'CZI / ND2 / LIF / OIB / OIF / LSM bridge',
    note: 'Local optional readers can split supported CZI scenes, ND2 positions, and LIF images/positions into separate bounded OME-TIFF imports. A configured external converter can return one OME-TIFF for CZI/ND2/LIF/OIB/OIF/LSM, including Electron. This is not native browser import or first-party Bio-Formats parity.',
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
