# Changelog

Notable changes to VoxelLab are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and packaged releases
use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.2] - 2026-08-14

### Fixed

- Gave the Windows installer a stable space-free filename so downloaded release
  assets match `SHA256SUMS` exactly.

## [1.1.1] - 2026-08-14

### Changed

- Removed internal product-planning fields and duplicate prose assertions from
  release evidence while preserving executable proof-lane and artifact checks.
- Made the plugin sidebar overflow regression deterministic across CI viewport
  layouts.

## [1.1.0] - 2026-08-14

### Added

- Physical-space arbitrary-plane clipping in the 3D volume renderer, including
  exact yaw and pitch entry, depth, inversion, reset, and shared MPR angles.
- Runtime launch proof for packaged Windows desktop builds, SHA-256 release
  manifests, and GitHub build-provenance attestations.
- Serious/critical WCAG browser audits, cold-start budgets, repeated 3D renderer
  reuse checks, byte-bounded warm-volume retention, and lower-peak gradient
  generation.
- Separate private-upload and public-result R2 paths, with exact-size presigned
  uploads, bounded conditional downloads, and verified result publication.

### Changed

- Python CI dependencies are universal, exact-version, and hash locked; the full
  npm release graph now fails on every advisory outside three documented,
  build-only installer exceptions.
- Current Electron Forge dependencies replace avoidably vulnerable transitive
  URL, IP, and glob packages.
- Release packaging accepts Developer ID/notarization and Authenticode
  credentials when repository secrets are configured, while retaining the
  explicit unsigned fallback for contributor builds.
- Volume controls now surface clipping by name and use the shared checkbox,
  field, focus, contrast, and responsive interaction patterns.
- The MPR angle controls use styled exact-degree fields, and the complete MPR
  toolbar remains on one horizontally scrollable row at narrow widths.
- Modal GPU and webhook images now install from reviewed hash-locked dependency
  graphs and use current GPU, disk, concurrency, and source-package settings.

### Fixed

- Authorized local proxy responses are no longer persisted under header-blind
  Cache Storage keys.
- Exact negative angles can be typed without state synchronization overwriting
  partial input, and programmatic clip-depth changes keep the filled track in
  sync.
- 3D transfer presets consistently clear an active arbitrary cut.

### Known Limitations

- Official macOS notarization and Windows Authenticode signing require project
  certificates and provider credentials; the public workflow cannot sign until
  those repository secrets are supplied.
- Existing cloud installations must provision distinct private upload and
  public result buckets, migrate any legacy mixed-bucket data, update the Modal
  secret, and redeploy before cloud processing can be enabled.
- Format support remains intentionally narrower than Bio-Formats, Fiji, or a
  clinical DICOM workstation.
- VoxelLab is not a medical device and is not for clinical use.

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

[1.1.0]: https://github.com/kaanarici/VoxelLab/releases/tag/v1.1.0
[1.0.0]: https://github.com/kaanarici/VoxelLab/releases/tag/v1.0.0
