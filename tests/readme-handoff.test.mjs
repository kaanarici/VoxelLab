import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const readmeUrl = new URL('../README.md', import.meta.url);
const readme = readFileSync(fileURLToPath(readmeUrl), 'utf8');

test('README gives desktop users the real release choices and signing warnings', () => {
  assert.match(readme, /GitHub Releases.*releases\/latest/);
  assert.match(readme, /macOS on Apple Silicon \| `VoxelLab\.dmg`/);
  assert.match(readme, /not notarized/);
  assert.match(readme, /Windows \| Installer \(`\.exe`\)/);
  assert.match(readme, /installer is unsigned/);
  assert.doesNotMatch(readme, /Windows.*archive/);
});

test('README offers a short source and demo path without internal release narration', () => {
  const demoIndex = readme.indexOf('npm run demo:install -- --demo lite');
  const startIndex = readme.indexOf('npm start', demoIndex);
  assert.ok(demoIndex > 0);
  assert.ok(startIndex > demoIndex);
  assert.match(readme, /44 MB lite\ndemo/);
  assert.match(readme, /Node\.js 22\.12\.0/);
  assert.match(readme, /Open <http:\/\/localhost:8000>/);
  assert.doesNotMatch(readme, /check:lab|lab-readiness|lab-readiness-report/);
});

test('README states the local privacy boundary and explicit cloud exception', () => {
  assert.match(readme, /does not require a VoxelLab account or a hosted backend/);
  assert.match(readme, /default browser and desktop import paths process those files locally/);
  assert.match(readme, /Files leave your machine only after you\nconfigure Modal and Cloudflare R2 and explicitly start a cloud workflow/);
  assert.match(readme, /Never\nput patient data, credentials, or private workspace URLs/);
});

test('README keeps sidecars and derived objects bound to their source data', () => {
  assert.match(readme, /microscopy sidecars are not standalone images/);
  assert.match(readme, /bounded session queue.*matching source loads/);
  assert.match(readme, /DICOM derived objects may be opened first[\s\S]*same session/);
  assert.match(readme, /Full clinical round-trip is not supported/);
});

test('README describes the proprietary microscopy converter boundary', () => {
  assert.match(readme, /CZI, ND2, and LIF[\s\S]*local readers or an external OME-TIFF converter/);
  assert.match(readme, /scene or position as a separate imported series/);
  assert.match(readme, /external[\s\S]*converter remains a single-output bridge/);
  assert.match(readme, /OIB, OIF, and LSM require that bridge/);
  assert.match(readme, /Unsupported converter setups fail closed/);
});

test('README distinguishes local and streamed OME-Zarr support', () => {
  assert.match(readme, /OME-NGFF 0\.4 and 0\.5/);
  assert.match(readme, /Zarr v2/);
  assert.match(readme, /bounded unsharded Zarr v3/);
  assert.match(readme, /CORS is required for URLs/);
  assert.match(readme, /Sharding[\s\S]*fail closed/);
});

test('README describes the bounded TIFF sample, color, and compression subset', () => {
  assert.match(readme, /8\/16\/32-bit signed or unsigned integer and 32-bit float TIFF/);
  assert.match(readme, /Interleaved RGB\/RGBA can open as channels/);
  assert.match(readme, /multi-vertex ImageJ PolyLines remain open paths/);
  assert.match(readme, /BigTIFF, tiled pyramids, JPEG compression, planar color/);
});

test('README describes bounded NIfTI-2 and geometry-backed scalar DICOM support', () => {
  assert.match(readme, /DICOM CT, MR, PT, NM, and OT stacks/);
  assert.match(readme, /NIfTI-1 and NIfTI-2/);
  assert.match(readme, /signed 8-bit and unsigned 32-bit data/);
  assert.match(readme, /unsafe NIfTI-2 dimensions/);
});

test('README has a real JPEG screenshot and no em dash', () => {
  const screenshot = fileURLToPath(new URL('../.github/assets/voxellab-viewer.jpg', import.meta.url));
  assert.match(readme, /!\[VoxelLab showing a research volume\]\(\.github\/assets\/voxellab-viewer\.jpg\)/);
  assert.equal(existsSync(screenshot), true);
  assert.ok(statSync(screenshot).size > 0);
  assert.deepEqual([...readFileSync(screenshot).subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.doesNotMatch(readme, /—/);
});
