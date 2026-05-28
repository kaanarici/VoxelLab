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
- Supports microscopy C/Z/T navigation, channel controls, calibrated scale bars, ROI results, deterministic workflow recipes (save/replay), and CSV/JSON/PNG export for supported local microscopy data.
- Includes optional local Python and cloud GPU processing paths for advanced research workflows.
- Uses plain HTML, CSS, and JavaScript modules. There is no frontend build step.

## Quick Start

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

Start VoxelLab, open http://localhost:8000, then drag files or folders into the
viewer.

Good first inputs:

- a DICOM folder or DICOM files
- a `.nii` or `.nii.gz` file
- an OME-TIFF or ImageJ TIFF microscopy stack
- a folder of single-plane TIFF images from one stack
- a local OME-Zarr folder, within the current limited support boundary

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
| OME-TIFF / ImageJ TIFF | Browser-local grayscale microscopy stacks, C/Z/T navigation, channel controls, calibrated measurements when metadata is present | Not Bio-Formats parity; compressed TIFF, BigTIFF, and many edge cases are not first-party yet |
| TIFF image sequences | Homogeneous single-plane TIFF files can import as one ordered Z stack, with explicit manual XY/Z calibration controls when embedded spacing is missing | Generic sequences remain uncalibrated until metadata or user calibration is provided |
| OME-Zarr / NGFF | Limited local OME-NGFF 0.4-style zarr v2, uncompressed level-0 chunks; metadata recognition for broader public samples | Compression, zarr v3, remote chunk streaming, and pyramid rendering are not first-party yet |
| DICOM SEG / RTSTRUCT / RT Dose | Session-backed overlays, ROIs, or derived records for supported source studies | Not a full radiotherapy workflow |
| DICOM SR | VoxelLab-oriented measurement note export and re-import | Not generic clinical SR ingestion |
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
- Proprietary microscopy formats such as CZI, ND2, and LIF are not native browser formats today. They should be handled through an explicit converter/plugin strategy until licensing and tests prove otherwise.

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
npm run check:geometry
npm run test:node
npm run test:python
npm run test:browser
```

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
