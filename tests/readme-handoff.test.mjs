import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const readmeUrl = new URL('../README.md', import.meta.url);
const readme = readFileSync(fileURLToPath(readmeUrl), 'utf8');

test('README distinguishes current legacy downloads from the next-release asset policy', () => {
  assert.match(readme, /GitHub Releases.*releases\/latest/);
  assert.match(readme, /manual updates.*Help → Check for Updates/);
  assert.match(readme, /macOS on Apple Silicon \| `VoxelLab\.dmg`/);
  assert.match(readme, /not notarized/);
  assert.match(readme, /Windows \| `VoxelLab-1\.1\.2-Setup\.exe`/);
  assert.match(readme, /installer is unsigned/);
  assert.match(readme, /v1\.1\.2 release predates the curated asset policy/);
  assert.match(readme, /next release[\s\S]*`VoxelLab-<version>-macOS-arm64\.dmg`/);
  assert.match(readme, /next release[\s\S]*`VoxelLab-<version>-Windows-x64\.exe`/);
  assert.match(readme, /exactly[\s\S]*`SHA256SUMS`/);
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

test('README has a real JPEG screenshot', () => {
  const screenshot = fileURLToPath(new URL('../.github/assets/voxellab-viewer.jpg', import.meta.url));
  assert.match(readme, /!\[VoxelLab showing a research volume\]\(\.github\/assets\/voxellab-viewer\.jpg\)/);
  assert.equal(existsSync(screenshot), true);
  assert.ok(statSync(screenshot).size > 0);
  assert.deepEqual([...readFileSync(screenshot).subarray(0, 3)], [0xff, 0xd8, 0xff]);
});
