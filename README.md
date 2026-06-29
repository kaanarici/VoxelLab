# VoxelLab

[![Check](https://github.com/kaanarici/VoxelLab/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/kaanarici/VoxelLab/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

VoxelLab is a local-first research viewer for medical volumes and microscopy stacks.
It runs in the browser, opens local files by drag and drop, and keeps the default
workflow on your machine.

It is built for research and education, not diagnosis.

> **Not for clinical use.** VoxelLab is not a medical device, PACS workstation,
> diagnostic viewer, DICOM conformance product, calibrated display, or
> regulatory-cleared workflow.

## What It Does

- Opens supported DICOM, NIfTI, OME-TIFF, ImageJ TIFF, TIFF sequence, and limited OME-Zarr data.
- Shows 2D slices, MPR, 3D volume rendering, compare views, overlays, and measurements where geometry supports it.
- Supports microscopy C/Z/T navigation, channel controls, calibrated scale bars, ROI results including line and angle measurements, deterministic workflow recipes (save/replay), limited ImageJ `.roi` sidecar import including straight-line and angle measurements, ImageJ ROI ZIP import for stored/deflated supported ROI sidecars, VoxelLab-authored uncompressed ROI ZIP export including straight-line and angle measurements, and CSV/JSON/PNG plus calibrated rendered TIFF snapshot export for supported local microscopy data.
- Includes optional local Python and cloud GPU processing paths for advanced research workflows.
- Uses plain HTML, CSS, and JavaScript modules. There is no frontend build step.

## Quick Start

### Desktop App

For most researchers, start with the desktop app. Download the latest macOS or
Windows build from
[GitHub Releases](https://github.com/kaanarici/VoxelLab/releases), then open
VoxelLab locally.

On macOS, open the `.dmg` and drag **VoxelLab** onto **Applications**. The macOS
builds are not yet notarized by Apple, so the first launch is gated: right-click
the app in Applications and choose **Open**, then confirm. After that it opens
normally.

On Windows, download the installer or archive from the latest release and open
VoxelLab from the installed or extracted app.

The installed app opens its own VoxelLab window. Use **File > Open Files...**,
**File > Open Folder...**, or drag files and folders into the window.

### Browser/Development Setup

Use this path if you want to run the repo directly instead of installing a
desktop build.

Requirements:

- Node.js 20+
- Python 3.11+

```bash
git clone https://github.com/kaanarici/VoxelLab.git
cd VoxelLab
npm run setup
npm start
```

Open http://localhost:8000.

The setup command can install a small public MRI demo pack, so you can try the
viewer without bringing your own data.

## Try Your Own Files

In the desktop app, use **File > Open Files...**, **File > Open Folder...**, or
drag files and folders into the VoxelLab window.

In the browser/development version, run `npm start`, open
http://localhost:8000, then drag files or folders into the viewer.

Good first inputs:

- a DICOM folder or DICOM files
- a `.nii` or `.nii.gz` file
- an OME-TIFF or ImageJ TIFF microscopy stack
- a folder of single-plane TIFF images from one stack
- a local OME-Zarr folder, within the current limited support boundary
- matching VoxelLab/ImageJ sidecars; sidecars are not standalone images, so
  open them with the source image or after the source series is already loaded
- VoxelLab-exported DICOM SR measurement notes; open the matching source DICOM
  series first, then open the SR file again

Local imports stay local. Optional cloud processing only runs when configured
and explicitly used.

## Public Demo Data

Install demo packs:

```bash
npm run demo:install -- --demo lite
npm run demo:install -- --demo none --pack ome-microscopy-samples
npm run demo:install -- --demo none --pack imagej-confocal-series-sample
npm run demo:install -- --demo none --pack ome-zarr-public-metadata-sample
```

Verify the public microscopy fixtures:

```bash
npm run demo:verify:ome
npm run demo:verify:imagej
npm run demo:verify:ome-zarr
npm run demo:verify:microscopy
```

These checks download public samples into a temporary directory, parse them
through VoxelLab's import path, verify the expected metadata/calibration
contract, then delete the temporary files.

## Supported Inputs

| Input | Current support | Important boundary |
|---|---|---|
| DICOM CT/MR slice stacks | 2D, MPR, 3D, compare, measurements, overlays when patient-space geometry is consistent | Research viewer only, not clinical DICOM conformance |
| Enhanced multi-frame CT/MR DICOM | Expands supported per-frame geometry and pixels into the shared stack path | Irregular or unsupported transfer syntax cases fail closed or stay 2D |
| NIfTI `.nii` / `.nii.gz` | Browser-local volume import with spatial units converted to millimeters when known | Unknown units remain uncalibrated for measurements and scale bars |
| OME-TIFF / ImageJ TIFF | Browser-local grayscale microscopy stacks, C/Z/T navigation, channel controls, calibrated measurements when metadata is present, limited ImageJ `.roi` sidecar import including straight-line and angle measurements, stored/deflated ImageJ ROI ZIP import for supported ROI sidecars, and VoxelLab-authored uncompressed ROI ZIP export including straight-line and angle measurements | Not Bio-Formats parity; broader ROI Manager type parity, compressed TIFF, BigTIFF, and many edge cases are not first-party yet |
| TIFF image sequences | Homogeneous single-plane TIFF files can import as one ordered Z stack, with explicit manual XY/Z calibration controls when embedded spacing is missing | Generic sequences remain uncalibrated until metadata or user calibration is provided |
| OME-Zarr / NGFF | Limited local OME-NGFF 0.4-style zarr v2, uncompressed level-0 chunks; metadata recognition for broader public samples | Compression, zarr v3, remote chunk streaming, and pyramid rendering are not first-party yet |
| DICOM SEG / RTSTRUCT / RT Dose | Session-backed overlays, ROIs, or derived records for supported source studies | Not a full radiotherapy workflow |
| DICOM SR | VoxelLab-oriented measurement note export; re-import only after the matching source series is loaded | Not generic clinical SR ingestion; standalone SR files ask for the source series first |
| Manifest PNG/raw stacks | Demo/internal viewer format | Not an interchange standard |

Unsupported inputs should fail closed rather than silently becoming a misleading
volume or calibrated measurement.

## Accuracy Policy

VoxelLab uses one shared geometry contract across browser import, MPR, 3D
scaling, measurements, compare mode, Python conversion, and cloud processing.

- Slice ordering prefers patient position and orientation. `InstanceNumber` is only a fallback.
- Compare and overlay matching prefer `FrameOfReferenceUID` when present.
- Measurements and scale bars are calibrated only when spacing metadata is known.
- Microscopy claims are tied to fixture tests and public sample verifiers.
- Proprietary microscopy formats such as CZI, ND2, LIF, OIB, OIF, and LSM are not native browser formats today. CZI/ND2/LIF can use optional local backend readers, and OIB/OIF/LSM require a configured external OME-TIFF converter. Either way, the browser only receives the converted OME-TIFF, and unsupported setups fail closed.

## Optional Advanced Processing

The browser viewer works without cloud services. Advanced processing is optional
and needs extra setup.

```bash
npm run setup -- --pipeline
npm run setup -- --pipeline --cloud
npm run setup -- --pipeline --rtk
```

Available research paths include local conversion scripts, SynthSeg,
TotalSegmentator, tissue/biomarker helpers, calibrated projection
reconstruction, ultrasound scan conversion, Modal GPU jobs, and Cloudflare R2
hosting.

Configure local/private values in `.env`; keep secrets out of git. Public-safe
defaults live in `config.json`.

## Development

Useful commands:

```bash
npm run setup
npm run check
npm run check:lab
npm run check:geometry
npm run test:node
npm run test:python
npm run test:browser
```

Use `npm run check:lab` before handing a build to a researcher. It runs the
focused first-pass intake gate: public demo-pack install/catalog proof, public
microscopy sample verifiers, browser upload/provenance checks including
unsupported skips and read failures, microscopy format-boundary checks, unsupported 4D NIfTI rejection, mixed native
medical/microscopy folder boundary checks, local microscopy converter checks,
analysis workflow checks, calibrated export checks, fail-closed sidecar mismatch
checks, limited OME-Zarr workflow checks, desktop package/release-download contract checks,
sanitized public export proof, and hidden Electron desktop smoke tests including
desktop-launched microscopy measurement, annotation, CSV, PNG, and workflow
recipe export.

To keep a small handoff record of the evidence lanes and skipped proof, run:

```bash
npm run check:lab -- --report lab-readiness-report.json
```

The report records the current commit, branch/upstream when available, and
whether the working tree was dirty when the gate ran. It also records total and
per-lane proof durations, plus a researcher-workflow evidence map for desktop
open, mixed-folder triage, calibration/provenance, microscopy measure/export,
honest failures, and release handoff. Add `--json` when automation needs the
same machine-readable summary on stdout; progress logs stay on stderr.

Run the app:

```bash
npm start
```

Run the Electron shell:

```bash
npm run desktop:start
```

## Project Map

| Path | Purpose |
|---|---|
| `index.html`, `viewer.js`, `js/`, `css/`, `templates/` | Browser viewer |
| `electron/` | Desktop shell and local file bridge |
| `scripts/` | Setup, validation, demo, public sample, and helper scripts |
| `tests/` | Node, Python, and browser tests |
| `demo_packs/` | Public demo pack catalog and lite demo artifact |
| `ARCHITECTURE.md` | Higher-level architecture notes |
| `CONTRIBUTING.md` | Contributor setup |
| `R2_SETUP.md` | Optional R2/cloud setup |

## Credits

VoxelLab builds on public research tooling and datasets, including OpenNeuro,
OME sample data, ImageJ sample data, OME-NGFF/IDR sample metadata, SynthSeg,
TotalSegmentator, HD-BET, Three.js, dcmjs, and Cornerstone codecs.

## License

MIT. See [LICENSE](LICENSE).

Medical disclaimer: VoxelLab is for research and educational use only. Do not
use it for diagnosis, treatment decisions, emergency care, or any regulated
clinical workflow.
