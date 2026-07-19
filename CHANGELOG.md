# Changelog

Notable changes to VoxelLab are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and packaged releases
use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-19

Initial public release.

### Added

- Browser and Electron desktop apps for local research imaging workflows.
- Local import for supported DICOM CT/MR/PT/NM/OT, NIfTI-1/2, OME-TIFF,
  ImageJ TIFF, TIFF sequences, and bounded OME-Zarr data.
- 2D viewing, MPR, 3D volume rendering, compare mode, measurements,
  annotations, and supported overlays.
- Bounded single-file NIfTI-1/2 scalar import, including dim-4 timepoints,
  signed 8-bit data, and unsigned 32-bit data.
- DICOM RLE decoding for supported 8-bit and 16-bit monochrome images, with
  stored-domain pixel-padding handling before rescale and display mapping.
- Classic stripped TIFF decoding for supported 8/16/32-bit integer and
  float32 samples, LZW/Deflate with Predictor 1 or 2, and interleaved RGB/RGBA
  channel splitting.
- Local safe-level and streamed OME-NGFF 0.4/0.5 import for Zarr v2 and a
  bounded unsharded Zarr v3 subset, including byte-shuffled supported chunks.
- Microscopy C/Z/T navigation, channel controls, calibration, bounded ImageJ
  ROI interchange with open PolyLines, calibrated regular-stack MPR/3D,
  evidence export, and replayable workflow recipes.
- Raw microscopy line profiles and bounded two-channel pixel colocalization
  with explicit thresholds and method limitations.
- Session-bound import and bounded pending-source attachment for supported
  DICOM SEG, RTSTRUCT, VoxelLab SR notes, and RT Dose metadata summaries.
- Optional native readers that split supported CZI scenes, ND2 positions, and
  LIF images/positions, plus a single-output external OME-TIFF bridge.
- Shared JavaScript and Python patient-space geometry checks, synthetic
  imaging fixtures, and fail-closed capability rules.
- Optional local Python, Modal, and Cloudflare R2 processing paths.
- Packaged macOS Apple Silicon and Windows builds with release artifact checks.

### Changed

- Annotation, ROI, and analysis persistence now uses an exact source-series
  identity instead of a reusable display slug.
- Browser runtime dependencies are self-hosted, including the ONNX Runtime
  files used by local SlimSAM inference.
- Local DICOM, TIFF, OME-Zarr, volume-worker, cache, converter, and cloud paths
  enforce explicit acquisition, allocation, concurrency, and retention limits.
- OME-NGFF import selects one safe usable level and preserves selected-level
  calibration, codec, and downsample provenance.
- The public format matrix and validation ledger now distinguish verified
  support from converter-backed, partial, and intentionally blocked workflows.

### Fixed

- Reject ambiguous or out-of-range OME-TIFF plane mappings instead of assigning
  pages to the wrong Z/C/T position.
- Validate DICOM RLE segment tables, PackBits row boundaries, plane counts, and
  decoded output lengths before accepting pixel data.
- Prevent stale DICOMweb, cloud-upload, local-analysis, and volume-worker results
  from mutating a newer viewer selection.
- Clear replaced local volume state and settle pending worker requests when an
  operation fails or the desktop app closes.
- Preserve signed DICOM values and apply rescale only after stored-value pixel
  padding has been identified.
- Reject unsafe NIfTI headers, frequency axes, spatial affines, and decoded
  allocations before a misleading calibrated volume can be created.
- Validate SEG attachments before persistence and require RT Dose metadata to
  match the loaded source Frame of Reference UID.
- Write cloud settings atomically and keep converter output in bounded local
  logs.
- Keep public-export repository metadata intact while rebuilding its sanitized
  working tree.
- Restore browser WebAssembly compilation under the local content security
  policy so SlimSAM inference can initialize.

### Known Limitations

- The macOS app is not notarized and the Windows installer is unsigned.
- Format support is intentionally narrower than Bio-Formats, Fiji, or a
  clinical DICOM workstation.
- VoxelLab is not a medical device and is not for clinical use.

[1.0.0]: https://github.com/kaanarici/VoxelLab/releases/tag/v1.0.0
