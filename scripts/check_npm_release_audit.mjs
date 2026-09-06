import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const REVIEWED_BUILD_ADVISORIES = Object.freeze({
  'https://github.com/advisories/GHSA-jmr9-qjv8-65gv': 'Electron Packager only; inputs are integrity-checked Electron distributions, never user archives.',
  'https://github.com/advisories/GHSA-w3rx-r6r6-pgpr': 'DMG build only; image-size reads committed VoxelLab artwork, never user images.',
  'https://github.com/advisories/GHSA-5p2g-fcmc-qvqq': 'DMG build only; image-size reads committed VoxelLab artwork, never user images.',
});

export function auditAdvisoryUrls(payload) {
  const urls = new Set();
  for (const vulnerability of Object.values(payload?.vulnerabilities || {})) {
    for (const via of vulnerability?.via || []) {
      if (via && !Array.isArray(via) && Object.getPrototypeOf(via) === Object.prototype && via.url) urls.add(via.url);
    }
  }
  return [...urls].sort();
}

export function assertReviewedNpmAudit(payload) {
  assert.ok(payload?.metadata?.vulnerabilities, 'npm audit output must include vulnerability metadata');
  const urls = auditAdvisoryUrls(payload);
  const unexpected = urls.filter(url => !Object.hasOwn(REVIEWED_BUILD_ADVISORIES, url));
  assert.deepEqual(unexpected, [], `unreviewed npm advisories: ${unexpected.join(', ')}`);
  const critical = Number(payload.metadata.vulnerabilities.critical || 0);
  assert.equal(critical, 0, 'npm release graph must contain no critical vulnerabilities');
  return {
    reviewedAdvisories: urls,
    vulnerablePackages: Number(payload.metadata.vulnerabilities.total || 0),
  };
}

function main() {
  const result = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  const payload = JSON.parse(result.stdout || '{}');
  const summary = assertReviewedNpmAudit(payload);
  console.log(`OK: full npm graph has no unreviewed advisories (${summary.reviewedAdvisories.length} reviewed build-only advisories, ${summary.vulnerablePackages} affected dependency nodes)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
