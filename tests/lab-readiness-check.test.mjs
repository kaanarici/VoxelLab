/* global process, URL */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  PROOF_TYPE_TAXONOMY,
  labReadinessSteps,
  labReadinessSummary,
  repoEvidenceSnapshot,
} from '../scripts/check_lab_readiness.mjs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_EXPORT_CHECK_LAB = !existsSync(join(ROOT, 'scripts/sync_public_repo.py'));
const VALID_PROOF_TYPES = new Set(Object.keys(PROOF_TYPE_TAXONOMY));
const STATIC_RUNTIME_OVERCLAIM = /\b(?:active packaged-app launch|launch(?:es|ed|ing)?|runtime behavior|open a real app window)\b/i;

function canBindLocalhostPort() {
  const script = [
    "const net = require('node:net');",
    'const server = net.createServer();',
    "server.once('error', () => process.exit(1));",
    "server.listen(0, '127.0.0.1', () => server.close(() => process.exit(0)));",
    'setTimeout(() => process.exit(1), 2000).unref();',
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  return result.status === 0;
}

function assertProofMetadata(lane, proofType) {
  assert.equal(lane.proofType, proofType);
  assert.ok(VALID_PROOF_TYPES.has(lane.proofType));
  assert.equal(lane.claim?.constructor, String);
  assert.ok(lane.claim.length > 0);
}

test('package exposes the lab readiness gate', () => {
  assert.equal(
    packageJson.scripts?.['check:lab'],
    PUBLIC_EXPORT_CHECK_LAB
      ? 'node scripts/check_lab_readiness.mjs --skip-validation-matrix --skip-public-export --skip-demo-pack --skip-converters --skip-browser'
      : 'node scripts/check_lab_readiness.mjs',
  );
});

test('lab readiness uses the required commands and honest proof types', () => {
  const expected = [
    ['node-contracts', 'node', 'contract', ['--test', 'tests/electron-desktop-contract.test.mjs', 'tests/release-assets-check.test.mjs']],
    ['validation-matrix-contract', 'node', 'static', ['scripts/run_python.mjs', 'scripts/check_validation_matrix.py']],
    ['demo-pack-contract', 'node', 'contract', ['scripts/run_python.mjs', '-m', 'pytest', 'tests/test_demo_install.py', '-q']],
    ['converter-contracts', 'node', 'contract', ['scripts/run_python.mjs', '-m', 'pytest', 'tests/test_microscopy_convert.py', 'tests/test_microscopy_convert_samples.py', '-q']],
    ['desktop-package-contract', 'node', 'static', ['scripts/check_electron_package.mjs']],
    ['release-download-contract', 'node', 'static', ['scripts/check_release_workflow.mjs']],
    ['public-export-contract', 'node', 'contract', ['scripts/run_python.mjs', '-m', 'pytest', 'tests/test_public_sync.py', '-q']],
    ['public-sample-fixtures', 'node', 'oracle', ['scripts/verify_microscopy_public_samples.mjs']],
    ['browser-user-flows', 'npx', 'runtime', ['playwright', 'test', 'tests/browser/viewer-mpr-stability.spec.js', '--project=chromium', '--workers=1']],
    ['electron-desktop-intake', 'npm', 'runtime', ['run', 'desktop:smoke']],
  ];
  const steps = labReadinessSteps();
  assert.deepEqual(steps.map(step => step.id), expected.map(([id]) => id));
  for (const [id, command, proofType, requiredArgs] of expected) {
    const lane = steps.find(step => step.id === id);
    assertProofMetadata(lane, proofType);
    assert.equal(lane.command, command);
    for (const arg of requiredArgs) assert.ok(lane.args.includes(arg), `${id} must include ${arg}`);
    if (proofType === 'static') assert.doesNotMatch(lane.claim, STATIC_RUNTIME_OVERCLAIM, id);
  }
  assert.match(packageJson.scripts?.['desktop:smoke'], /tests\/electron-microscopy-workflow-smoke\.mjs/);
});

test('lab readiness dry run prints the evidence contract without running Electron', () => {
  const result = spawnSync(process.execPath, ['scripts/check_lab_readiness.mjs', '--dry-run', '--json', '--skip-electron'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.gate, 'VoxelLab lab readiness');
  assert.equal(payload.status, 'planned');
  assert.equal(payload.durationMs, 0);
  assert.deepEqual(Object.keys(payload.proofTypeTaxonomy), ['static', 'contract', 'runtime', 'oracle']);
  assert.ok(payload.steps.every(step => VALID_PROOF_TYPES.has(step.proofType)));
  assert.ok(payload.steps.every(step => step.claim));
  assert.equal(payload.steps.some(step => step.id === 'electron-desktop-intake'), false);
  assert.ok(payload.steps.some(step => step.id === 'public-sample-fixtures'));
  const publicSamples = payload.steps.find(step => step.id === 'public-sample-fixtures');
  assertProofMetadata(publicSamples, 'oracle');
  assert.deepEqual(publicSamples.evidence.map(item => item.label), [
    'ome-tiff',
    'imagej-tiff',
    'ome-zarr-metadata',
  ]);
  assert.ok(publicSamples.evidence.every(item => item.coverage && item.boundary));
  assert.deepEqual(payload.proofCoverage, {
    scope: 'partial',
    totalLanes: 10,
    includedLanes: 9,
    omittedLanes: 1,
    omittedIds: ['electron-desktop-intake'],
  });
  const omittedElectron = payload.omitted.find(step => step.id === 'electron-desktop-intake');
  assert.ok(omittedElectron);
  assertProofMetadata(omittedElectron, 'runtime');
  assert.match(omittedElectron.claim, /desktop launch/);
  assert.ok(payload.boundary.includes('not clinical'));
});

test('lab readiness summary records planned and omitted proof lanes', () => {
  const payload = labReadinessSummary({ dryRun: true, skipBrowser: true });
  assert.equal(payload.status, 'planned');
  assert.equal(payload.durationMs, 0);
  assert.match(payload.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(payload.repo.commit, /^[0-9a-f]{40}$/);
  assert.equal(payload.repo.branch?.constructor === String || payload.repo.branch === null, true);
  assert.equal(payload.repo.dirty?.constructor, Boolean);
  assert.equal(payload.repo.statusShort?.constructor, String);
  assert.deepEqual(Object.keys(payload.proofTypeTaxonomy), ['static', 'contract', 'runtime', 'oracle']);
  assert.ok(payload.steps.every(step => step.status === 'planned'));
  assert.ok(payload.steps.every(step => VALID_PROOF_TYPES.has(step.proofType)));
  assert.ok(payload.steps.every(step => step.claim));
  assert.deepEqual(payload.proofCoverage, {
    scope: 'partial',
    totalLanes: 10,
    includedLanes: 9,
    omittedLanes: 1,
    omittedIds: ['browser-user-flows'],
  });
  assert.equal(payload.omitted.length, 1);
  assert.equal(payload.omitted[0].id, 'browser-user-flows');
  assertProofMetadata(payload.omitted[0], 'runtime');
  assert.match(payload.omitted[0].reason, /--skip-browser/);
  assert.match(payload.omitted[0].claim, /browser intake/);
});

test('lab readiness summary marks unskipped proof as the full gate', () => {
  const payload = labReadinessSummary({ dryRun: true });
  assert.deepEqual(payload.proofCoverage, {
    scope: 'full',
    totalLanes: 10,
    includedLanes: 10,
    omittedLanes: 0,
    omittedIds: [],
  });
});

test('lab readiness repo evidence snapshot records commit and dirty state', () => {
  const snapshot = repoEvidenceSnapshot();
  assert.match(snapshot.commit, /^[0-9a-f]{40}$/);
  assert.equal(snapshot.branch?.constructor === String || snapshot.branch === null, true);
  assert.equal(snapshot.upstream?.constructor === String || snapshot.upstream === null, true);
  assert.equal(snapshot.dirty?.constructor, Boolean);
  assert.equal(snapshot.statusShort?.constructor, String);
});

test('lab readiness writes a passed evidence report for focused non-UI lanes', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'voxellab-lab-report-'));
  const reportPath = join(tempDir, 'report.json');
  const privateLaneSkips = [];
  if (!existsSync(join(ROOT, 'docs/validation-matrix.md'))) privateLaneSkips.push('--skip-validation-matrix');
  if (!existsSync(join(ROOT, 'scripts/sync_public_repo.py')) || !canBindLocalhostPort()) {
    privateLaneSkips.push('--skip-public-export');
  }
  if (PUBLIC_EXPORT_CHECK_LAB) privateLaneSkips.push('--skip-demo-pack', '--skip-converters');
  const result = spawnSync(process.execPath, [
    'scripts/check_lab_readiness.mjs',
    ...privateLaneSkips,
    '--skip-public-samples',
    '--skip-browser',
    '--skip-electron',
    '--report',
    reportPath,
    '--json',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const stdoutPayload = JSON.parse(result.stdout);
  assert.equal(stdoutPayload.status, 'passed');
  assert.equal(Number.isFinite(stdoutPayload.durationMs), true);
  assert.ok(stdoutPayload.steps.every(step => Number.isFinite(step.durationMs) && step.durationMs >= 0));
  assert.match(result.stderr, /\[voxellab:lab\] node-contracts/);
  const payload = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(payload.status, 'passed');
  assert.equal(Number.isFinite(payload.durationMs), true);
  assert.ok(payload.durationMs >= 0);
  assert.match(payload.repo.commit, /^[0-9a-f]{40}$/);
  assert.equal(payload.repo.branch?.constructor === String || payload.repo.branch === null, true);
  const expectedOmittedIds = [
    ...(privateLaneSkips.includes('--skip-validation-matrix') ? ['validation-matrix-contract'] : []),
    ...(privateLaneSkips.includes('--skip-public-export') ? ['public-export-contract'] : []),
    ...(privateLaneSkips.includes('--skip-demo-pack') ? ['demo-pack-contract'] : []),
    ...(privateLaneSkips.includes('--skip-converters') ? ['converter-contracts'] : []),
    'public-sample-fixtures',
    'browser-user-flows',
    'electron-desktop-intake',
  ];
  assert.deepEqual(payload.omitted.map(step => step.id), expectedOmittedIds);
  assert.deepEqual(payload.proofCoverage, {
    scope: 'partial',
    totalLanes: 10,
    includedLanes: 10 - expectedOmittedIds.length,
    omittedLanes: expectedOmittedIds.length,
    omittedIds: expectedOmittedIds,
  });
  assert.ok(payload.steps.every(step => step.status === 'passed'));
  assert.ok(payload.steps.every(step => Number.isFinite(step.durationMs) && step.durationMs >= 0));
  assert.ok(payload.steps.every(step => VALID_PROOF_TYPES.has(step.proofType)));
  assert.ok(payload.steps.every(step => step.claim));
  assert.ok(payload.omitted.every(step => VALID_PROOF_TYPES.has(step.proofType)));
  assert.ok(payload.omitted.every(step => step.claim));
  assert.equal(
    payload.steps.some(step => step.id === 'demo-pack-contract'),
    !privateLaneSkips.includes('--skip-demo-pack'),
  );
  assert.equal(
    payload.steps.some(step => step.id === 'converter-contracts'),
    !privateLaneSkips.includes('--skip-converters'),
  );
  assert.ok(payload.steps.some(step => step.id === 'desktop-package-contract'));
  assert.ok(payload.steps.some(step => step.id === 'release-download-contract'));
});

test('lab readiness help describes hidden Electron smoke behavior', () => {
  const result = spawnSync(process.execPath, ['scripts/check_lab_readiness.mjs', '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--report <path>/);
  assert.match(result.stdout, /Skip hidden Electron desktop smoke tests/);
  assert.doesNotMatch(result.stdout, /open a real app window/);
});
