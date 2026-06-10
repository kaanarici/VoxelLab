/* global console, process */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PUBLIC_MICROSCOPY_FIXTURE_EVIDENCE = Object.freeze([
  Object.freeze({
    label: 'ome-tiff',
    script: 'verify_ome_microscopy_samples.mjs',
    format: 'OME-TIFF',
    coverage: 'public OME artificial 5D samples prove axes, plane counts, C/T local stacks, source provenance, and explicit missing-calibration warnings',
    boundary: 'uncompressed fixture parsing only; missing physical sizes stay uncalibrated',
  }),
  Object.freeze({
    label: 'imagej-tiff',
    script: 'verify_imagej_microscopy_sample.mjs',
    format: 'ImageJ TIFF',
    coverage: 'public ImageJ Confocal Series sample proves X/Y/Z micrometer calibration, metadata calibration provenance, calibrated ROI-results CSV area/perimeter/circularity/center-coordinate/integrated-density columns, uint8 pixel type, two channels, Z stacks, and channel-local stack keys',
    boundary: 'one public calibrated ImageJ hyperstack; not full ImageJ macro, LUT, or Bio-Formats behavior',
  }),
  Object.freeze({
    label: 'ome-zarr-metadata',
    script: 'verify_ome_zarr_public_sample.mjs',
    format: 'OME-Zarr metadata',
    coverage: 'public OME-NGFF 0.4 metadata proves axes, pixel type, multiscale level paths, per-level shapes/chunks/compression, channel colors/LUTs/display ranges, and per-axis physical units',
    boundary: 'metadata-only public proof; Blosc-compressed remote arrays and pyramid rendering intentionally fail closed',
  }),
]);

function publicEvidenceForOutput() {
  return PUBLIC_MICROSCOPY_FIXTURE_EVIDENCE.map(({ label, format, coverage, boundary }) => ({
    label,
    format,
    coverage,
    boundary,
  }));
}

function main() {
  for (const { label, script } of PUBLIC_MICROSCOPY_FIXTURE_EVIDENCE) {
    console.error(`[voxellab] verifying ${label} public microscopy fixture`);
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', script)], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }

  console.log(JSON.stringify({
    verified: PUBLIC_MICROSCOPY_FIXTURE_EVIDENCE.map(({ label }) => label),
    evidence: publicEvidenceForOutput(),
    boundary: 'public fixture proof only; not Fiji, Bio-Formats, or proprietary-format parity',
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
