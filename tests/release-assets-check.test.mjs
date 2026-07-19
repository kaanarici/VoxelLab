import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { checkDesktopMakeOutputs } from '../scripts/check_desktop_make_outputs.mjs';
import { RESEARCHER_WORKFLOW_EVIDENCE } from '../scripts/check_lab_readiness.mjs';
import { checkReleaseAssets } from '../scripts/check_release_assets.mjs';

const CURRENT_COMMIT = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const PUBLIC_SAMPLE_EVIDENCE = Object.freeze([
  {
    label: 'ome-tiff',
    format: 'OME-TIFF',
    coverage: 'public OME artificial 5D samples prove axes and warnings',
    boundary: 'uncompressed fixture parsing only',
  },
  {
    label: 'imagej-tiff',
    format: 'ImageJ TIFF',
    coverage: 'public ImageJ Confocal Series sample proves calibration',
    boundary: 'one calibrated ImageJ hyperstack',
  },
  {
    label: 'ome-zarr-metadata',
    format: 'OME-Zarr metadata',
    coverage: 'public OME-NGFF metadata proves axes, units, and coarsest-level local provenance',
    boundary: 'bounded coarsest-level local proof',
  },
]);
const FULL_PROOF_STEPS = Object.freeze([
  'node-contracts',
  'validation-matrix-contract',
  'demo-pack-contract',
  'converter-contracts',
  'desktop-package-contract',
  'release-download-contract',
  'public-export-contract',
  'public-sample-fixtures',
  'browser-user-flows',
  'electron-desktop-intake',
].map(id => ({
  id,
  status: 'passed',
  durationMs: 1,
  ...(id === 'public-sample-fixtures' ? { evidence: PUBLIC_SAMPLE_EVIDENCE } : {}),
})));
const FULL_PROOF_LANE_COUNT = FULL_PROOF_STEPS.length;
const PUBLIC_RELEASE_OMITTED_IDS = Object.freeze([
  'validation-matrix-contract',
  'public-export-contract',
]);
const PUBLIC_RELEASE_STEPS = Object.freeze(FULL_PROOF_STEPS.filter(
  step => !PUBLIC_RELEASE_OMITTED_IDS.includes(step.id),
));
const FULL_RESEARCHER_WORKFLOW = Object.freeze(RESEARCHER_WORKFLOW_EVIDENCE.map(({ id, outcome, laneIds }) => ({
  id,
  outcome,
  status: 'passed',
  evidenceLanes: laneIds.map(laneId => ({ id: laneId, status: 'passed' })),
})));
const CLEAN_REPO = Object.freeze({ commit: CURRENT_COMMIT, dirty: false, statusShort: '' });

async function makeReleaseRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'voxellab-release-assets-'));
  mkdirSync(path.join(root, 'voxellab-lab-readiness'), { recursive: true });
  mkdirSync(path.join(root, 'voxellab-macos', 'make'), { recursive: true });
  mkdirSync(path.join(root, 'voxellab-windows', 'make'), { recursive: true });
  writeFileSync(path.join(root, 'voxellab-lab-readiness', 'lab-readiness-report.json'), JSON.stringify({
    gate: 'VoxelLab lab readiness',
    status: 'passed',
    durationMs: FULL_PROOF_LANE_COUNT,
    repo: CLEAN_REPO,
    proofCoverage: {
      scope: 'full',
      totalLanes: FULL_PROOF_LANE_COUNT,
      includedLanes: FULL_PROOF_LANE_COUNT,
      omittedLanes: 0,
      omittedIds: [],
    },
    researcherWorkflow: FULL_RESEARCHER_WORKFLOW,
    steps: FULL_PROOF_STEPS,
  }));
  writeFileSync(path.join(root, 'voxellab-macos', 'make', 'VoxelLab.dmg'), 'dmg');
  writeFileSync(path.join(root, 'voxellab-macos', 'make', 'VoxelLab.zip'), 'zip');
  writeFileSync(path.join(root, 'voxellab-windows', 'make', 'VoxelLabSetup.exe'), 'exe');
  writeFileSync(path.join(root, 'voxellab-windows', 'make', 'VoxelLab.nupkg'), 'nupkg');
  writeFileSync(path.join(root, 'voxellab-windows', 'make', 'RELEASES'), 'releases');
  return root;
}

test('release assets check accepts lab evidence plus desktop downloads', async () => {
  const root = await makeReleaseRoot();
  const result = checkReleaseAssets(root);
  assert.equal(result.fileCount, 6);
  assert.ok(result.files.includes('voxellab-lab-readiness/lab-readiness-report.json'));
  assert.ok(result.files.includes('voxellab-macos/make/VoxelLab.dmg'));
  assert.ok(result.files.includes('voxellab-windows/make/VoxelLabSetup.exe'));
});

test('release assets check accepts the exact sanitized public proof profile', async () => {
  const root = await makeReleaseRoot();
  const omitted = new Set(PUBLIC_RELEASE_OMITTED_IDS);
  const researcherWorkflow = FULL_RESEARCHER_WORKFLOW.map(item => {
    const evidenceLanes = item.evidenceLanes.map(lane => ({
      ...lane,
      status: omitted.has(lane.id) ? 'omitted' : 'passed',
    }));
    return {
      ...item,
      status: evidenceLanes.some(lane => lane.status === 'omitted') ? 'partial' : 'passed',
      evidenceLanes,
    };
  });
  writeFileSync(path.join(root, 'voxellab-lab-readiness', 'lab-readiness-report.json'), JSON.stringify({
    gate: 'VoxelLab lab readiness',
    status: 'passed',
    durationMs: PUBLIC_RELEASE_STEPS.length,
    repo: CLEAN_REPO,
    proofCoverage: {
      scope: 'partial',
      totalLanes: FULL_PROOF_LANE_COUNT,
      includedLanes: PUBLIC_RELEASE_STEPS.length,
      omittedLanes: PUBLIC_RELEASE_OMITTED_IDS.length,
      omittedIds: PUBLIC_RELEASE_OMITTED_IDS,
    },
    researcherWorkflow,
    steps: PUBLIC_RELEASE_STEPS,
  }));
  assert.equal(checkReleaseAssets(root).fileCount, 6);
});

test('release assets check rejects empty platform artifacts', async () => {
  const root = await makeReleaseRoot();
  writeFileSync(path.join(root, 'voxellab-windows', 'make', 'VoxelLabSetup.exe'), '');
  assert.throws(() => checkReleaseAssets(root), /must not be empty/);
});

test('release assets check rejects non-passing readiness reports', async () => {
  const root = await makeReleaseRoot();
  writeFileSync(path.join(root, 'voxellab-lab-readiness', 'lab-readiness-report.json'), JSON.stringify({
    gate: 'VoxelLab lab readiness',
    status: 'failed',
    repo: CLEAN_REPO,
    proofCoverage: {
      scope: 'full',
      totalLanes: FULL_PROOF_LANE_COUNT,
      includedLanes: FULL_PROOF_LANE_COUNT,
      omittedLanes: 0,
      omittedIds: [],
    },
    steps: FULL_PROOF_STEPS.map(step => step.id === 'node-contracts' ? { ...step, status: 'failed' } : step),
  }));
  assert.throws(() => checkReleaseAssets(root), /lab readiness report must have passed status/);
});

test('release assets check rejects partial readiness reports', async () => {
  const root = await makeReleaseRoot();
  writeFileSync(path.join(root, 'voxellab-lab-readiness', 'lab-readiness-report.json'), JSON.stringify({
    gate: 'VoxelLab lab readiness',
    status: 'passed',
    repo: CLEAN_REPO,
    proofCoverage: {
      scope: 'partial',
      totalLanes: FULL_PROOF_LANE_COUNT,
      includedLanes: FULL_PROOF_LANE_COUNT - 1,
      omittedLanes: 1,
      omittedIds: ['electron-desktop-intake'],
    },
    steps: [{ id: 'node-contracts', status: 'passed' }],
  }));
  assert.throws(() => checkReleaseAssets(root), /must match the public release proof profile/);
});

test('release assets check rejects mismatched readiness step counts', async () => {
  const root = await makeReleaseRoot();
  writeFileSync(path.join(root, 'voxellab-lab-readiness', 'lab-readiness-report.json'), JSON.stringify({
    gate: 'VoxelLab lab readiness',
    status: 'passed',
    repo: CLEAN_REPO,
    proofCoverage: {
      scope: 'full',
      totalLanes: FULL_PROOF_LANE_COUNT,
      includedLanes: FULL_PROOF_LANE_COUNT,
      omittedLanes: 0,
      omittedIds: [],
    },
    steps: [{ id: 'node-contracts', status: 'passed' }],
  }));
  assert.throws(() => checkReleaseAssets(root), /step count must match included proof lanes/);
});

test('release assets check rejects mismatched readiness lane counts', async () => {
  const root = await makeReleaseRoot();
  writeFileSync(path.join(root, 'voxellab-lab-readiness', 'lab-readiness-report.json'), JSON.stringify({
    gate: 'VoxelLab lab readiness',
    status: 'passed',
    repo: CLEAN_REPO,
    proofCoverage: {
      scope: 'full',
      totalLanes: 99,
      includedLanes: FULL_PROOF_LANE_COUNT,
      omittedLanes: 0,
      omittedIds: [],
    },
    steps: FULL_PROOF_STEPS,
  }));
  assert.throws(() => checkReleaseAssets(root), /total lane count must match/);
});

test('release assets check rejects failed readiness proof steps', async () => {
  const root = await makeReleaseRoot();
  writeFileSync(path.join(root, 'voxellab-lab-readiness', 'lab-readiness-report.json'), JSON.stringify({
    gate: 'VoxelLab lab readiness',
    status: 'passed',
    repo: CLEAN_REPO,
    proofCoverage: {
      scope: 'full',
      totalLanes: FULL_PROOF_LANE_COUNT,
      includedLanes: FULL_PROOF_LANE_COUNT,
      omittedLanes: 0,
      omittedIds: [],
    },
    steps: FULL_PROOF_STEPS.map(step => step.id === 'browser-user-flows' ? { ...step, status: 'failed' } : step),
  }));
  assert.throws(() => checkReleaseAssets(root), /every proof step passed/);
});

test('release assets check rejects unknown readiness proof steps', async () => {
  const root = await makeReleaseRoot();
  writeFileSync(path.join(root, 'voxellab-lab-readiness', 'lab-readiness-report.json'), JSON.stringify({
    gate: 'VoxelLab lab readiness',
    status: 'passed',
    repo: CLEAN_REPO,
    proofCoverage: {
      scope: 'full',
      totalLanes: FULL_PROOF_LANE_COUNT,
      includedLanes: FULL_PROOF_LANE_COUNT,
      omittedLanes: 0,
      omittedIds: [],
    },
    steps: FULL_PROOF_STEPS.map(step => step.id === 'electron-desktop-intake' ? { id: 'placeholder-proof', status: 'passed' } : step),
  }));
  assert.throws(() => checkReleaseAssets(root), /must include every required release proof step/);
});

test('release assets check rejects readiness reports without proof durations', async () => {
  const root = await makeReleaseRoot();
  writeFileSync(path.join(root, 'voxellab-lab-readiness', 'lab-readiness-report.json'), JSON.stringify({
    gate: 'VoxelLab lab readiness',
    status: 'passed',
    repo: CLEAN_REPO,
    proofCoverage: {
      scope: 'full',
      totalLanes: FULL_PROOF_LANE_COUNT,
      includedLanes: FULL_PROOF_LANE_COUNT,
      omittedLanes: 0,
      omittedIds: [],
    },
    steps: FULL_PROOF_STEPS.map(step => ({ id: step.id, status: step.status })),
  }));
  assert.throws(() => checkReleaseAssets(root), /total proof duration/);
});

test('release assets check rejects readiness reports without public sample evidence', async () => {
  const root = await makeReleaseRoot();
  writeFileSync(path.join(root, 'voxellab-lab-readiness', 'lab-readiness-report.json'), JSON.stringify({
    gate: 'VoxelLab lab readiness',
    status: 'passed',
    durationMs: FULL_PROOF_LANE_COUNT,
    repo: CLEAN_REPO,
    proofCoverage: {
      scope: 'full',
      totalLanes: FULL_PROOF_LANE_COUNT,
      includedLanes: FULL_PROOF_LANE_COUNT,
      omittedLanes: 0,
      omittedIds: [],
    },
    researcherWorkflow: FULL_RESEARCHER_WORKFLOW,
    steps: FULL_PROOF_STEPS.map(step => (
      step.id === 'public-sample-fixtures' ? { id: step.id, status: step.status, durationMs: step.durationMs } : step
    )),
  }));
  assert.throws(() => checkReleaseAssets(root), /public microscopy sample evidence/);
});

test('release assets check rejects readiness reports without researcher workflow evidence', async () => {
  const root = await makeReleaseRoot();
  writeFileSync(path.join(root, 'voxellab-lab-readiness', 'lab-readiness-report.json'), JSON.stringify({
    gate: 'VoxelLab lab readiness',
    status: 'passed',
    durationMs: FULL_PROOF_LANE_COUNT,
    repo: CLEAN_REPO,
    proofCoverage: {
      scope: 'full',
      totalLanes: FULL_PROOF_LANE_COUNT,
      includedLanes: FULL_PROOF_LANE_COUNT,
      omittedLanes: 0,
      omittedIds: [],
    },
    steps: FULL_PROOF_STEPS,
  }));
  assert.throws(() => checkReleaseAssets(root), /researcher workflow evidence/);
});

test('release assets check rejects readiness reports missing the validation matrix proof lane', async () => {
  const root = await makeReleaseRoot();
  writeFileSync(path.join(root, 'voxellab-lab-readiness', 'lab-readiness-report.json'), JSON.stringify({
    gate: 'VoxelLab lab readiness',
    status: 'passed',
    repo: CLEAN_REPO,
    proofCoverage: {
      scope: 'full',
      totalLanes: FULL_PROOF_LANE_COUNT,
      includedLanes: FULL_PROOF_LANE_COUNT,
      omittedLanes: 0,
      omittedIds: [],
    },
    steps: FULL_PROOF_STEPS.map(step => step.id === 'validation-matrix-contract' ? { id: 'placeholder-proof', status: 'passed' } : step),
  }));
  assert.throws(() => checkReleaseAssets(root), /must include every required release proof step/);
});

test('release assets check rejects stale readiness report commits', async () => {
  const root = await makeReleaseRoot();
  writeFileSync(path.join(root, 'voxellab-lab-readiness', 'lab-readiness-report.json'), JSON.stringify({
    gate: 'VoxelLab lab readiness',
    status: 'passed',
    repo: { commit: '0'.repeat(40), dirty: false, statusShort: '' },
    proofCoverage: {
      scope: 'full',
      totalLanes: FULL_PROOF_LANE_COUNT,
      includedLanes: FULL_PROOF_LANE_COUNT,
      omittedLanes: 0,
      omittedIds: [],
    },
    steps: FULL_PROOF_STEPS,
  }));
  assert.throws(() => checkReleaseAssets(root), /commit must match the release checkout/);
});

test('release assets check rejects dirty readiness reports', async () => {
  const root = await makeReleaseRoot();
  writeFileSync(path.join(root, 'voxellab-lab-readiness', 'lab-readiness-report.json'), JSON.stringify({
    gate: 'VoxelLab lab readiness',
    status: 'passed',
    repo: {
      commit: CURRENT_COMMIT,
      dirty: true,
      statusShort: 'M scripts/check_lab_readiness.mjs',
    },
    proofCoverage: {
      scope: 'full',
      totalLanes: FULL_PROOF_LANE_COUNT,
      includedLanes: FULL_PROOF_LANE_COUNT,
      omittedLanes: 0,
      omittedIds: [],
    },
    steps: FULL_PROOF_STEPS,
  }));
  assert.throws(() => checkReleaseAssets(root), /clean checkout/);
});

test('release assets check rejects local and internal files', async () => {
  for (const rel of [
    'voxellab-macos/AGENTS.md',
    'voxellab-macos/config.local.json',
    'voxellab-macos/.env.local',
    'voxellab-macos/.codex/session.json',
    'voxellab-macos/.github/workflows/check.yml',
    'voxellab-macos/.playwright-mcp/state.json',
    'voxellab-macos/__pycache__/module.pyc',
    'voxellab-macos/test-results/report.json',
    'voxellab-macos/docs/plan.md',
    'voxellab-macos/data_compressed/example.raw.zst',
  ]) {
    const root = await makeReleaseRoot();
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'internal');
    assert.throws(() => checkReleaseAssets(root), /must not ship in release assets/, rel);
  }
});

test('release assets check rejects loose research imaging data', async () => {
  for (const rel of [
    'voxellab-macos/make/patient.dcm',
    'voxellab-macos/make/brain.nii.gz',
    'voxellab-macos/make/cells.ome.tiff',
    'voxellab-windows/make/cells.czi',
    'voxellab-windows/make/cells.roi',
  ]) {
    const root = await makeReleaseRoot();
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'research data');
    assert.throws(() => checkReleaseAssets(root), /must not ship loose research imaging data/, rel);
  }
});

test('release assets check rejects unexpected files in artifact groups', async () => {
  for (const rel of [
    'voxellab-macos/make/README.txt',
    'voxellab-windows/make/SHA256SUMS.txt',
    'voxellab-lab-readiness/notes.json',
  ]) {
    const root = await makeReleaseRoot();
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'extra');
    assert.throws(() => checkReleaseAssets(root), /is not an expected .* release artifact/, rel);
  }
});

test('release assets check rejects files outside expected artifact groups', async () => {
  const root = await makeReleaseRoot();
  const file = path.join(root, 'misc', 'build.txt');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'extra');
  assert.throws(() => checkReleaseAssets(root), /is not part of an expected release artifact group/);
});

async function makeDesktopMakeRoot(platform) {
  const root = await mkdtemp(path.join(tmpdir(), `voxellab-desktop-make-${platform}-`));
  if (platform === 'darwin') {
    writeFileSync(path.join(root, 'VoxelLab.dmg'), 'dmg');
    writeFileSync(path.join(root, 'VoxelLab.zip'), 'zip');
  } else {
    writeFileSync(path.join(root, 'VoxelLabSetup.exe'), 'exe');
    writeFileSync(path.join(root, 'VoxelLab.nupkg'), 'nupkg');
    writeFileSync(path.join(root, 'RELEASES'), 'releases');
  }
  return root;
}

test('desktop make output check accepts macOS downloadable artifacts', async () => {
  const root = await makeDesktopMakeRoot('darwin');
  const result = checkDesktopMakeOutputs(root, 'darwin');
  assert.equal(result.platform, 'darwin');
  assert.deepEqual(result.files.sort(), ['VoxelLab.dmg', 'VoxelLab.zip']);
});

test('desktop make output check accepts Windows downloadable artifacts', async () => {
  const root = await makeDesktopMakeRoot('win32');
  const result = checkDesktopMakeOutputs(root, 'win32');
  assert.equal(result.platform, 'win32');
  assert.deepEqual(result.files.sort(), ['RELEASES', 'VoxelLab.nupkg', 'VoxelLabSetup.exe']);
});

test('desktop make output check rejects empty required artifacts', async () => {
  const root = await makeDesktopMakeRoot('darwin');
  writeFileSync(path.join(root, 'VoxelLab.dmg'), '');
  assert.throws(() => checkDesktopMakeOutputs(root, 'darwin'), /must not be empty/);
});

test('desktop make output check rejects unexpected build outputs before upload', async () => {
  const root = await makeDesktopMakeRoot('win32');
  writeFileSync(path.join(root, 'README.txt'), 'notes');
  assert.throws(() => checkDesktopMakeOutputs(root, 'win32'), /is not an expected Windows desktop artifact/);
});

test('desktop make output check reuses release hygiene for internal and research files', async () => {
  const root = await makeDesktopMakeRoot('darwin');
  mkdirSync(path.join(root, '.codex'), { recursive: true });
  writeFileSync(path.join(root, '.codex', 'session.json'), '{}');
  assert.throws(() => checkDesktopMakeOutputs(root, 'darwin'), /must not ship in release assets/);

  const imagingRoot = await makeDesktopMakeRoot('darwin');
  writeFileSync(path.join(imagingRoot, 'patient.dcm'), 'dicom');
  assert.throws(() => checkDesktopMakeOutputs(imagingRoot, 'darwin'), /must not ship loose research imaging data/);
});
