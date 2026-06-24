/* global console, process */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
  'demo-pack-contract',
  'converter-contracts',
  'public-export-contract',
]);

const REQUIRED_RESEARCHER_WORKFLOW_IDS = Object.freeze([
  'desktop-install-open',
  'mixed-folder-triage',
  'supported-open-calibration-provenance',
  'microscopy-measure-export-recipe',
  'honest-failure-boundaries',
  'public-release-handoff',
]);

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

function expectedPublicReleaseStepIds() {
  const omitted = new Set(PUBLIC_RELEASE_OMITTED_STEP_IDS);
  return REQUIRED_LAB_READINESS_STEP_IDS.filter(id => !omitted.has(id));
}

function assertProofCoverage(coverage) {
  assert.equal(coverage?.totalLanes, REQUIRED_LAB_READINESS_STEP_IDS.length, 'lab readiness report total lane count must match the required proof gate');
  const omittedIds = sorted(coverage?.omittedIds || []);
  const fullReport = coverage?.scope === 'full';
  const publicReleaseReport = coverage?.scope === 'partial'
    && omittedIds.length === PUBLIC_RELEASE_OMITTED_STEP_IDS.length
    && JSON.stringify(omittedIds) === JSON.stringify(sorted(PUBLIC_RELEASE_OMITTED_STEP_IDS));

  assert.ok(fullReport || publicReleaseReport, 'lab readiness report must cover the full gate or the expected public-release partial gate');

  const expectedIncluded = fullReport ? REQUIRED_LAB_READINESS_STEP_IDS.length : expectedPublicReleaseStepIds().length;
  const expectedOmitted = fullReport ? 0 : PUBLIC_RELEASE_OMITTED_STEP_IDS.length;
  assert.equal(coverage?.includedLanes, expectedIncluded, 'lab readiness report included lane count must match the release proof gate');
  assert.equal(coverage?.omittedLanes, expectedOmitted, 'lab readiness report omitted lane count must match the release proof gate');
  assert.deepEqual(omittedIds, sorted(fullReport ? [] : PUBLIC_RELEASE_OMITTED_STEP_IDS), 'lab readiness report omitted proof lanes must match the release proof gate');
  return fullReport ? REQUIRED_LAB_READINESS_STEP_IDS : expectedPublicReleaseStepIds();
}

function assertResearcherWorkflow(report) {
  assert.ok(Array.isArray(report.researcherWorkflow), 'lab readiness report must include researcher workflow evidence');
  assert.deepEqual(sorted(report.researcherWorkflow.map(item => item?.id)), sorted(REQUIRED_RESEARCHER_WORKFLOW_IDS), 'lab readiness report must include every researcher workflow proof');
  const omittedIds = new Set(report.proofCoverage?.omittedIds || []);
  const publicPartial = report.proofCoverage?.scope === 'partial';
  for (const item of report.researcherWorkflow) {
    assert.ok(Array.isArray(item?.evidenceLanes) && item.evidenceLanes.length > 0, 'lab readiness researcher workflow evidence must include proof lanes');
    const statuses = item.evidenceLanes.map(lane => lane?.status);
    assert.ok(statuses.includes('passed'), 'lab readiness researcher workflow evidence must include at least one passed proof lane');
    for (const lane of item.evidenceLanes) {
      if (lane?.status === 'omitted' && publicPartial && omittedIds.has(lane?.id)) continue;
      assert.equal(lane?.status, 'passed', 'lab readiness researcher workflow proof lanes must all pass unless they are expected public-release omissions');
    }
    const expectedStatus = statuses.includes('omitted') ? 'partial' : 'passed';
    assert.equal(item?.status, expectedStatus, 'lab readiness researcher workflow status must match its proof lanes');
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
  const expectedStepIds = assertProofCoverage(payload.proofCoverage);
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
  assertResearcherWorkflow(payload);
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
