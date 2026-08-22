# Changelog

Notable changes to VoxelLab are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and packaged releases
use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.3] - 2026-08-22

### Fixed

- Ask can use the currently displayed slice from a browser-local DICOM or NIfTI
  import instead of rejecting its `local_*` series identifier.
- Folder option menus keep their compact width instead of stretching across or
  beyond the viewer window.
- Fitting a newly opened series sizes the slice canvas from series geometry
  before zoom, so a leftover 512 placeholder cannot overflow the window.
- Remote slice controls, anatomy labels, and AI context stay attached to the
  image on screen until the requested cloud slice has actually loaded.
- AI observations launch the packaged Python runner from its real location and
  present progress as status text instead of a misleading queued action.
- Customized shortcuts now replace their defaults in execution, toolbar hints,
  and the Help reference.
- The Help modal links to the complete releases page, keeps build version with
  the About section, and refreshes offline caches for this release.
- Right-sidebar sections restore their saved open state, keep collapsed controls
  out of keyboard focus, and no longer collapse when their info icon is used.

### Changed

- README screenshot and setup examples now match the current viewer and both
  local AI providers (Claude Code and Codex).
- Cloud GPU segmentation is a primary guided action in the Segmentation menu,
  with source-file and eligibility guidance before upload.

## [1.2.2] - 2026-08-19

### Fixed

- The slice scrubber can be resized from the divider after the FPS control,
  down to half of its default width.
- Notices sit in the bottom-right, clear the toolbar and open menus, and no
  longer draw a leftover accent stripe.
- The Compare series heading stays flush with the top of the popover while
  the list scrolls.

### Known Limitations

- The macOS app is not notarized and the Windows installer is unsigned.
- Format support remains intentionally narrower than Bio-Formats, Fiji, or a
  clinical DICOM workstation.
- VoxelLab is not a medical device and is not for clinical use.

## [1.2.1] - 2026-08-19

### Fixed

- Restored undistorted 3D volume rendering when viewing a clip-box face
  head-on, after a 1.2.0 regression that stretched the scene.
- Entering 3D now shows the full volume instead of a leftover 2D slice crop.
  The 3D clip follows the reviewed slice only while 3D is already active.
- 3D anatomy labels stay attached to their structures when zooming without
  rotating the camera.
- Mesh export still includes segmentation labels when the colour overlay is
  turned off.
- Overlay toggles, fusion, and isolated recipe replay no longer write the
  wrong display or invent overlay stack names.
- Imported ROI results appear in the table immediately, without waiting for a
  redundant channel or time-point switch.

### Known Limitations

- The macOS app is not notarized and the Windows installer is unsigned.
- Format support remains intentionally narrower than Bio-Formats, Fiji, or a
  clinical DICOM workstation.
- VoxelLab is not a medical device and is not for clinical use.

## [1.2.0] - 2026-08-16

### Added

- Added calibrated microscopy workflows for OME-TIFF, ImageJ TIFF and ROI
  sidecars, bounded OME-Zarr streaming, line profiles, colocalization, evidence
  packages, and reproducible workflow recipes.
- Added guarded cloud GPU actions for segmentation, registration,
  reconstruction, and ultrasound scan conversion with explicit source,
  calibration, and result provenance.
- Added Windows launch-path, file-association, installer, and packaged-runtime
  coverage for supported DICOM, NIfTI, and microscopy inputs.

### Changed

- Simplified desktop distribution to intentional unsigned, manual updates with
  only versioned macOS and Windows installers plus checksums in GitHub Releases.
- Kept lab-readiness evidence and packaging intermediates in GitHub Actions, and
  added an in-app link to the latest release.
- Made Compare use one physical display scale, identify aligned versus unknown
  studies, expose matrix and spacing provenance, and label index-synchronized
  panes as unregistered.
- Made remote Ask actions disclose the selected provider and the image, region,
  and study context that leaves the device before a question is sent.
- Added a repository-wide documentation integrity gate for current links, code
  paths, npm commands, flow maps, and historical-document status.
- Enabled the complete anti-slop Oxlint policy as errors inside the canonical
  lint command and simplified runtime boundary parsing without suppressions.

### Fixed

- Preserved the reviewed slice when entering 3D, kept its clip depth independent,
  and returned safely to 2D when WebGL volume rendering is unavailable.
- Corrected physical sizing for Compare panes and non-square-pixel measurement
  overlays, hid destructive measurement controls until hover, and rejected
  zero-length rulers.
- Corrected registration badges so quality from one reference series is never
  attributed to a different active comparison.
- Corrected modal focus, semantics, validation, cloud-command routing, folder
  deletion confirmation, and DICOM SR measurement-versus-annotation counts.
- Preserved existing Windows file handlers during install and uninstall, and
  normalized drive, UNC, extended-length, non-ASCII, and case-variant launch
  paths.
- Added resumable, integrity-checked demo downloads without retrying local
  filesystem failures as network failures.

### Security

- Removed bundled cached AI interpretations that made ungrounded normality or
  pathology-absence claims, including restricted-diffusion claims from a b0
  volume, and constrained new AI prompts to objective visible descriptions.
- Advanced offline caches so upgraded installations replace the removed AI
  sidecars and current application code instead of retaining legacy content.

### Known Limitations

- The macOS app is not notarized and the Windows installer is unsigned.
- Format support remains intentionally narrower than Bio-Formats, Fiji, or a
  clinical DICOM workstation.
- VoxelLab is not a medical device and is not for clinical use.

## [1.1.2] - 2026-08-14

### Added

- Browser and Electron desktop apps for local research imaging workflows.
- Local import for supported DICOM, NIfTI, OME-TIFF, ImageJ TIFF, TIFF
  sequences, and bounded OME-Zarr data.
- 2D, MPR, 3D, compare, measurement, annotation, microscopy, and supported
  overlay workflows.
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
- Volume controls now surface clipping by name and use the shared checkbox,
  field, focus, contrast, and responsive interaction patterns.
- The MPR angle controls use styled exact-degree fields, and the complete MPR
  toolbar remains on one horizontally scrollable row at narrow widths.
- Modal GPU and webhook images now install from reviewed hash-locked dependency
  graphs and use current GPU, disk, concurrency, and source-package settings.

### Fixed

- Gave the Windows installer a stable space-free filename so downloaded release
  assets match `SHA256SUMS` exactly.
- Authorized local proxy responses are no longer persisted under header-blind
  Cache Storage keys.
- Exact negative angles can be typed without state synchronization overwriting
  partial input, and programmatic clip-depth changes keep the filled track in
  sync.
- 3D transfer presets consistently clear an active arbitrary cut.

### Known Limitations

- The retained v1.1.2 release uses legacy asset names and includes packaging
  intermediates. The curated three-file download policy begins with the next
  release.
- The macOS app is not notarized and the Windows installer is unsigned.
- Existing cloud installations must provision distinct private upload and
  public result buckets, migrate any legacy mixed-bucket data, update the Modal
  secret, and redeploy before cloud processing can be enabled.
- Format support remains intentionally narrower than Bio-Formats, Fiji, or a
  clinical DICOM workstation.
- VoxelLab is not a medical device and is not for clinical use.

[1.2.3]: https://github.com/kaanarici/VoxelLab/releases/tag/v1.2.3
[1.2.2]: https://github.com/kaanarici/VoxelLab/releases/tag/v1.2.2
[1.2.1]: https://github.com/kaanarici/VoxelLab/releases/tag/v1.2.1
[1.2.0]: https://github.com/kaanarici/VoxelLab/releases/tag/v1.2.0
[1.1.2]: https://github.com/kaanarici/VoxelLab/releases/tag/v1.1.2
