import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const readmeUrl = new URL('../README.md', import.meta.url);
const readme = readFileSync(fileURLToPath(readmeUrl), 'utf8');
const { version } = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
const versionPattern = version.replaceAll('.', '\\.');

test('README documents the current curated release and manual updates', () => {
  assert.match(readme, new RegExp(`VoxelLab v${versionPattern}.*releases/latest`));
  assert.match(readme, /Updates are manual:\s+open \*\*Help → Check for Updates\*\*/);
  assert.match(readme, new RegExp(`macOS on Apple Silicon \\| \`VoxelLab-${versionPattern}-macOS-arm64\\.dmg\``));
  assert.match(readme, /not notarized/);
  assert.match(readme, new RegExp(`Windows 10 or 11 on x64 \\| \`VoxelLab-${versionPattern}-Windows-x64\\.exe\``));
  assert.match(readme, /installer is unsigned/);
  assert.match(readme, /Use `SHA256SUMS` from the release/);
  assert.doesNotMatch(readme, /v1\.1\.2|next release|legacy packaging/i);
});

test('README offers a short source and demo path without internal release narration', () => {
  const demoIndex = readme.indexOf('npm run demo:install -- --demo lite');
  const startIndex = readme.indexOf('npm start', demoIndex);
  assert.ok(demoIndex > 0);
  assert.ok(startIndex > demoIndex);
  assert.match(readme, /44 MB lite demo/);
  assert.match(readme, /Node\.js 22\.12\.0/);
  assert.match(readme, /Open <http:\/\/localhost:8000>/);
  assert.doesNotMatch(readme, /check:lab|lab-readiness|lab-readiness-report/);
});

test('README states the local privacy boundary and explicit cloud exception', () => {
  assert.match(readme, /does not require a VoxelLab account or a hosted backend/);
  assert.match(readme, /default browser and desktop import paths process those files locally/);
  assert.match(readme, /Files leave your machine only after you configure Modal and Cloudflare R2 and\s+explicitly start a cloud workflow/);
  assert.match(readme, /Never put patient data, credentials, or\s+private workspace URLs/);
});

test('README has a real JPEG screenshot', () => {
  const screenshot = fileURLToPath(new URL('../.github/assets/voxellab-viewer.jpg', import.meta.url));
  assert.match(readme, /!\[VoxelLab showing a research volume\]\(\.github\/assets\/voxellab-viewer\.jpg\)/);
  assert.equal(existsSync(screenshot), true);
  assert.ok(statSync(screenshot).size > 0);
  assert.deepEqual([...readFileSync(screenshot).subarray(0, 3)], [0xff, 0xd8, 0xff]);
});

test('README keeps the license section minimal', () => {
  assert.match(readme, /## License\n\n\[MIT\]\(LICENSE\)\n$/);
  assert.doesNotMatch(readme, /img\.shields\.io\/badge\/License/);
});
