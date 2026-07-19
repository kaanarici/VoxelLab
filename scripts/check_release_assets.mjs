/* global console, process */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RESEARCHER_WORKFLOW_EVIDENCE } from './check_lab_readiness.mjs';

const REQUIRED_GROUPS = Object.freeze([
  {
    id: 'lab-readiness',
    directory: 'voxellab-lab-readiness',
    patterns: [/^lab-readiness-report\.json$/],
  },
  {
    id: 'macos',
    directory: 'voxellab-macos',
    patterns: [/\.dmg$/i, /\.zip$/i],
  },
  {
    id: 'windows',
    directory: 'voxellab-windows',
    patterns: [/\.exe$/i, /\.nupkg$/i, /^RELEASES$/],
  },
]);

const BLOCKED_BASENAMES = new Set([
  '.env',
  '.env.example',
  'AGENTS.md',
  'CLAUDE.md',
  'FLOW_INDEX.md',
  'MISSION.md',
  'config.local.json',
]);

const BLOCKED_PATH_PARTS = new Set([
  '.claude',
  '.codex',
  '.flow',
  '.git',
  '.github',
  '.playwright-mcp',
  '.pytest_cache',
  '.venv',
  '.vercel',
  '.vscode',
  '__pycache__',
  'data_compressed',
  'demo_sources',
  'docs',
  'node_modules',
  'out',
  'synthseg_repo',
  'test-results',
]);

const BLOCKED_RESEARCH_DATA_EXTENSIONS = Object.freeze([
  '.czi',
  '.dcm',
  '.dicom',
  '.ima',
  '.lif',
  '.lsm',
  '.nd2',
  '.nii',
  '.nii.gz',
  '.oib',
  '.oif',
  '.ome.tif',
  '.ome.tiff',
  '.roi',
  '.tif',
  '.tiff',
]);

const REQUIRED_LAB_READINESS_STEP_IDS = Object.freeze([
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
]);

const PUBLIC_RELEASE_OMITTED_STEP_IDS = Object.freeze([
  'validation-matrix-contract',
  'public-export-contract',
]);

const REQUIRED_RESEARCHER_WORKFLOW_IDS = Object.freeze(RESEARCHER_WORKFLOW_EVIDENCE.map(item => item.id));
const RESEARCHER_WORKFLOW_BY_ID = new Map(RESEARCHER_WORKFLOW_EVIDENCE.map(item => [item.id, item]));

function walkFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  }
  return files.sort();
}

export function walkReleaseAssetFiles(rootDir) {
  return walkFiles(rootDir);
}

function relativeParts(rootDir, filePath) {
  return path.relative(rootDir, filePath).split(path.sep);
}

function assertNoInternalFiles(rootDir, files) {
  for (const file of files) {
    const parts = relativeParts(rootDir, file);
    const blocked = parts.some(part => BLOCKED_PATH_PARTS.has(part) || part.startsWith('.env'));
    assert.equal(blocked, false, `${parts.join('/')} must not ship in release assets`);
    assert.equal(BLOCKED_BASENAMES.has(path.basename(file)), false, `${parts.join('/')} must not ship in release assets`);
  }
}

function researchDataExtension(file) {
  const name = path.basename(file).toLowerCase();
  return BLOCKED_RESEARCH_DATA_EXTENSIONS.find(extension => name.endsWith(extension)) || '';
}

function assertNoLooseResearchData(rootDir, files) {
  for (const file of files) {
    const extension = researchDataExtension(file);
    assert.equal(
      extension,
      '',
      `${relativeParts(rootDir, file).join('/')} must not ship loose research imaging data in release assets`,
    );
  }
}

function assertNonEmpty(files) {
  for (const file of files) {
    assert.ok(statSync(file).size > 0, `${file} must not be empty`);
  }
}

export function assertReleaseArtifactFileHygiene(rootDir, files) {
  assertNoInternalFiles(rootDir, files);
  assertNoLooseResearchData(rootDir, files);
  assertNonEmpty(files);
}

function assertGroup(rootDir, files, group) {
  const groupFiles = files.filter(file => relativeParts(rootDir, file).includes(group.directory));
  assert.ok(groupFiles.length > 0, `missing release artifact group: ${group.directory}`);
  for (const pattern of group.patterns) {
    assert.ok(
      groupFiles.some(file => pattern.test(path.basename(file))),
      `${group.directory} must include ${pattern}`,
    );
  }
  return groupFiles;
}

function artifactGroupForFile(rootDir, file) {
  const parts = relativeParts(rootDir, file);
  return REQUIRED_GROUPS.find(group => parts.includes(group.directory)) || null;
}

function assertOnlyExpectedArtifacts(rootDir, files) {
  for (const file of files) {
    const group = artifactGroupForFile(rootDir, file);
    const relative = relativeParts(rootDir, file).join('/');
    assert.ok(group, `${relative} is not part of an expected release artifact group`);
    assert.ok(
      group.patterns.some(pattern => pattern.test(path.basename(file))),
      `${relative} is not an expected ${group.directory} release artifact`,
    );
  }
}

function currentGitCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.status !== 0 || result.error || result.signal) return '';
  return result.stdout.trim();
}

function sorted(values) {
  return [...values].sort();
}

function assertProofCoverage(coverage) {
  assert.equal(coverage?.totalLanes, REQUIRED_LAB_READINESS_STEP_IDS.length, 'lab readiness report total lane count must match the required proof gate');
  const omittedIds = sorted(coverage?.omittedIds || []);
  const expectedOmittedIds = coverage?.scope === 'full'
    ? []
    : sorted(PUBLIC_RELEASE_OMITTED_STEP_IDS);
  assert.ok(['full', 'partial'].includes(coverage?.scope), 'lab readiness report scope must be full or the public release profile');
  assert.deepEqual(omittedIds, expectedOmittedIds, 'partial lab readiness report must match the public release proof profile');
  assert.equal(coverage?.includedLanes, REQUIRED_LAB_READINESS_STEP_IDS.length - expectedOmittedIds.length, 'lab readiness report included lane count must match its proof profile');
  assert.equal(coverage?.omittedLanes, expectedOmittedIds.length, 'lab readiness report omitted lane count must match its proof profile');
  const omitted = new Set(expectedOmittedIds);
  return {
    expectedStepIds: REQUIRED_LAB_READINESS_STEP_IDS.filter(id => !omitted.has(id)),
    omitted,
  };
}

function assertResearcherWorkflow(report, omitted) {
  assert.ok(Array.isArray(report.researcherWorkflow), 'lab readiness report must include researcher workflow evidence');
  assert.deepEqual(sorted(report.researcherWorkflow.map(item => item?.id)), sorted(REQUIRED_RESEARCHER_WORKFLOW_IDS), 'lab readiness report must include every researcher workflow proof');
  for (const item of report.researcherWorkflow) {
    const expected = RESEARCHER_WORKFLOW_BY_ID.get(item?.id);
    assert.ok(Array.isArray(item?.evidenceLanes) && item.evidenceLanes.length > 0, 'lab readiness researcher workflow evidence must include proof lanes');
    assert.equal(item?.outcome, expected?.outcome, 'lab readiness researcher workflow outcome must match the evidence contract');
    assert.deepEqual(sorted(item.evidenceLanes.map(lane => lane?.id)), sorted(expected?.laneIds || []), 'lab readiness researcher workflow must include its required evidence lanes');
    const statuses = item.evidenceLanes.map(lane => lane?.status);
    assert.ok(statuses.includes('passed'), 'lab readiness researcher workflow evidence must include at least one passed proof lane');
    for (const lane of item.evidenceLanes) {
      assert.equal(lane?.status, omitted.has(lane?.id) ? 'omitted' : 'passed', 'lab readiness researcher workflow lane status must match the release proof profile');
    }
    assert.equal(item?.status, statuses.includes('omitted') ? 'partial' : 'passed', 'lab readiness researcher workflow status must match its evidence lanes');
  }
}

function assertLabReadinessReport(reportPath) {
  const payload = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(payload.gate, 'VoxelLab lab readiness', 'release assets must include a VoxelLab lab readiness report');
  assert.equal(payload.status, 'passed', 'lab readiness report must have passed status');
  assert.match(payload.repo?.commit || '', /^[0-9a-f]{40}$/, 'lab readiness report must record the checked commit');
  assert.equal(payload.repo?.dirty, false, 'lab readiness report must come from a clean checkout');
  assert.equal(payload.repo?.statusShort || '', '', 'lab readiness report must not include dirty checkout details');
  const commit = currentGitCommit();
  if (commit) assert.equal(payload.repo.commit, commit, 'lab readiness report commit must match the release checkout');
  const { expectedStepIds, omitted } = assertProofCoverage(payload.proofCoverage);
  assert.ok(Array.isArray(payload.steps) && payload.steps.length > 0, 'lab readiness report must include evidence steps');
  assert.equal(payload.steps.length, payload.proofCoverage?.includedLanes, 'lab readiness report step count must match included proof lanes');
  assert.deepEqual(sorted(payload.steps.map(step => step?.id)), sorted(expectedStepIds), 'lab readiness report must include every required release proof step');
  assert.ok(payload.steps.every(step => step?.status === 'passed'), 'lab readiness report must have every proof step passed');
  assert.equal(Number.isFinite(payload.durationMs) && payload.durationMs >= 0, true, 'lab readiness report must include total proof duration');
  assert.ok(payload.steps.every(step => Number.isFinite(step?.durationMs) && step.durationMs >= 0), 'lab readiness report must include proof step durations');
  const publicSamples = payload.steps.find(step => step?.id === 'public-sample-fixtures');
  assert.ok(Array.isArray(publicSamples?.evidence) && publicSamples.evidence.length >= 3, 'lab readiness report must include public microscopy sample evidence');
  assert.ok(
    publicSamples.evidence.every(item => item?.label && item?.format && item?.coverage && item?.boundary),
    'public microscopy sample evidence must name labels, formats, coverage, and boundaries',
  );
  assertResearcherWorkflow(payload, omitted);
}

export function checkReleaseAssets(rootDir) {
  const resolvedRoot = path.resolve(rootDir || 'release-assets');
  const files = walkFiles(resolvedRoot);
  assert.ok(files.length > 0, `${resolvedRoot} contains no release assets`);
  assertReleaseArtifactFileHygiene(resolvedRoot, files);
  assertOnlyExpectedArtifacts(resolvedRoot, files);

  const groups = new Map(REQUIRED_GROUPS.map(group => [group.id, assertGroup(resolvedRoot, files, group)]));
  const report = groups.get('lab-readiness').find(file => path.basename(file) === 'lab-readiness-report.json');
  assertLabReadinessReport(report);

  return {
    root: resolvedRoot,
    fileCount: files.length,
    files: files.map(file => path.relative(resolvedRoot, file).split(path.sep).join('/')),
  };
}

function main() {
  const result = checkReleaseAssets(process.argv[2]);
  console.log(`OK: release assets contain lab evidence plus macOS and Windows desktop artifacts (${result.fileCount} files)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
