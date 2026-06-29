import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');

test('README separates desktop app handoff from browser development flow', () => {
  const desktopIndex = readme.indexOf('For most researchers, start with the desktop app');
  const developmentIndex = readme.indexOf('### Browser/Development Setup');
  assert.ok(desktopIndex > 0);
  assert.ok(developmentIndex > desktopIndex);
  assert.match(readme, /Download the latest macOS or\nWindows build from/);
  assert.match(readme, /On Windows, download the installer or archive from the latest release/);
  assert.match(readme, /The installed app opens its own VoxelLab window/);
  assert.match(readme, /File > Open Files\.\.\./);
  assert.match(readme, /File > Open Folder\.\.\./);
  assert.match(readme, /Use this path if you want to run the repo directly instead of installing a\ndesktop build/);
  assert.match(readme, /In the browser\/development version, run `npm start`, open\nhttp:\/\/localhost:8000/);
  assert.doesNotMatch(readme, /Start VoxelLab, open http:\/\/localhost:8000/);
});

test('README explains lab-readiness reports are tied to repo state', () => {
  assert.match(readme, /npm run check:lab -- --report lab-readiness-report\.json/);
  assert.match(readme, /public demo-pack install\/catalog proof/);
  assert.match(readme, /records the current commit, branch\/upstream when available/);
  assert.match(readme, /whether the working tree was dirty/);
  assert.match(readme, /records total and\nper-lane proof durations/);
  assert.match(readme, /researcher-workflow evidence map/);
  assert.match(readme, /desktop\nopen, mixed-folder triage, calibration\/provenance, microscopy measure\/export/);
  assert.match(readme, /`--json` when automation needs the\nsame machine-readable summary on stdout/);
  assert.match(readme, /progress logs stay on stderr/);
});

test('README keeps DICOM SR support source-series-bound', () => {
  assert.match(readme, /DICOM SR \| VoxelLab-oriented measurement note export; re-import only after the matching source series is loaded/);
  assert.match(readme, /VoxelLab-exported DICOM SR measurement notes; open the matching source DICOM\n\s{2}series first, then open the SR file again/);
  assert.match(readme, /standalone SR files ask for the source series first/);
});

test('README tells researchers to pair sidecars with source data', () => {
  assert.match(readme, /matching VoxelLab\/ImageJ sidecars; sidecars are not standalone images/);
  assert.match(readme, /open them with the source image or after the source series is already loaded/);
});

test('README keeps proprietary microscopy support behind explicit conversion', () => {
  assert.match(readme, /CZI, ND2, LIF, OIB, OIF, and LSM are not native browser formats/);
  assert.match(readme, /CZI\/ND2\/LIF can use optional local backend readers/);
  assert.match(readme, /OIB\/OIF\/LSM require a configured external OME-TIFF converter/);
  assert.match(readme, /unsupported setups fail closed/);
});
