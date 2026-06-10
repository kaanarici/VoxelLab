/* global process, URL */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { labReadinessSteps, labReadinessSummary, repoEvidenceSnapshot } from '../scripts/check_lab_readiness.mjs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_EXPORT_CHECK_LAB = !existsSync(join(ROOT, 'scripts/sync_public_repo.py'));

test('package exposes the lab readiness gate', () => {
  assert.equal(
    packageJson.scripts?.['check:lab'],
    PUBLIC_EXPORT_CHECK_LAB
      ? 'node scripts/check_lab_readiness.mjs --skip-validation-matrix --skip-public-export --skip-demo-pack --skip-converters'
      : 'node scripts/check_lab_readiness.mjs',
  );
});

test('lab readiness gate covers sample, browser, and desktop evidence by default', () => {
  const ids = labReadinessSteps().map(step => step.id);
  assert.deepEqual(ids, [
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
});

test('lab readiness includes validation matrix claim-ledger proof', () => {
  const matrixGate = labReadinessSteps().find(step => step.id === 'validation-matrix-contract');
  assert.deepEqual(matrixGate.args, ['scripts/run_python.mjs', 'scripts/check_validation_matrix.py']);
  assert.match(matrixGate.proves, /validation matrix claim ledger/);
  assert.match(matrixGate.proves, /validation commands\/tests attached/);
});

test('lab readiness includes public demo pack installer proof', () => {
  const demoGate = labReadinessSteps().find(step => step.id === 'demo-pack-contract');
  assert.deepEqual(demoGate.args, ['scripts/run_python.mjs', '-m', 'pytest', 'tests/test_demo_install.py', '-q']);
  assert.match(demoGate.proves, /public lite demo pack/);
  assert.match(demoGate.proves, /OME-TIFF, ImageJ TIFF, and OME-Zarr sample-pack metadata/);
});

test('lab readiness node contracts include medical and microscopy intake provenance', () => {
  const nodeContracts = labReadinessSteps().find(step => step.id === 'node-contracts');
  assert.ok(nodeContracts.args.includes('tests/desktop-intake-text.test.mjs'));
  assert.ok(nodeContracts.args.includes('tests/desktop-path-file.test.mjs'));
  assert.ok(nodeContracts.args.includes('tests/electron-desktop-contract.test.mjs'));
  assert.ok(nodeContracts.args.includes('tests/file-drop.test.mjs'));
  assert.ok(nodeContracts.args.includes('tests/format-capability-matrix.test.mjs'));
  assert.ok(nodeContracts.args.includes('tests/intake-format-summary.test.mjs'));
  assert.ok(nodeContracts.args.includes('tests/imagej-roi.test.mjs'));
  assert.ok(nodeContracts.args.includes('tests/local-intake-summary.test.mjs'));
  assert.ok(nodeContracts.args.includes('tests/local-intake-text.test.mjs'));
  assert.ok(nodeContracts.args.includes('tests/dicom-import-parse.test.mjs'));
  assert.ok(nodeContracts.args.includes('tests/dicom-derived-import.test.mjs'));
  assert.ok(nodeContracts.args.includes('tests/derived-objects.test.mjs'));
  assert.ok(nodeContracts.args.includes('tests/series-select-dom.test.mjs'));
  assert.ok(nodeContracts.args.includes('tests/microscopy-channel-composite.test.mjs'));
  assert.ok(nodeContracts.args.includes('tests/microscopy-dataset-model.test.mjs'));
  assert.ok(nodeContracts.args.includes('tests/microscopy-display-range.test.mjs'));
  assert.ok(nodeContracts.args.includes('tests/microscopy-hyperstack-controls.test.mjs'));
  assert.ok(nodeContracts.args.includes('tests/microscopy-import.test.mjs'));
  assert.ok(nodeContracts.args.includes('tests/microscopy-sequence-import.test.mjs'));
  assert.ok(nodeContracts.args.includes('tests/microscopy-provenance-text.test.mjs'));
  assert.ok(nodeContracts.args.includes('tests/microscopy-accuracy.test.mjs'));
  assert.ok(nodeContracts.args.includes('tests/release-assets-check.test.mjs'));
  assert.match(nodeContracts.proves, /desktop payload\/path contracts/);
  assert.match(nodeContracts.proves, /desktop and local intake summary\/text/);
  assert.match(nodeContracts.proves, /mixed native medical\/microscopy family boundaries/);
  assert.match(nodeContracts.proves, /separate skipped-file, file-read-failure, and folder-read-failure wording/);
  assert.match(nodeContracts.proves, /browser file\/folder selection cleanup and caps/);
  assert.match(nodeContracts.proves, /source-bound DICOM SR and microscopy sidecar guidance/);
  assert.match(nodeContracts.proves, /microscopy OME\/ImageJ\/TIFF import, dataset, hyperstack, channel, display-range, sequence, ROI, and provenance contracts/);
  assert.match(nodeContracts.proves, /DICOM\/NIfTI calibration\/source provenance/);
  assert.match(nodeContracts.proves, /DICOM SEG\/RTSTRUCT\/SR derived-object binding contracts/);
  assert.match(nodeContracts.proves, /anisotropic pixel-spacing display/);
  assert.match(nodeContracts.proves, /Analyze Particles contracts/);
  assert.match(nodeContracts.proves, /named ROI sidecar mismatch reasons/);
  assert.match(nodeContracts.proves, /release asset validation contracts/);
});

test('lab readiness includes local microscopy converter proof', () => {
  const converterGate = labReadinessSteps().find(step => step.id === 'converter-contracts');
  assert.deepEqual(converterGate.args, [
    'scripts/run_python.mjs',
    '-m',
    'pytest',
    'tests/test_microscopy_convert.py',
    'tests/test_microscopy_convert_samples.py',
    '-q',
  ]);
  assert.match(converterGate.proves, /optional-reader CZI\/ND2\/LIF/);
  assert.match(converterGate.proves, /external-converter CZI\/ND2\/LIF\/OIB\/OIF\/LSM/);
  assert.match(converterGate.proves, /reader\/converter fail-closed behavior/);
  assert.match(converterGate.proves, /sample-backed conversion proof/);
});

test('lab readiness node contracts include public desktop handoff proof', () => {
  const nodeContracts = labReadinessSteps().find(step => step.id === 'node-contracts');
  assert.ok(nodeContracts.args.includes('tests/readme-handoff.test.mjs'));
  assert.match(nodeContracts.proves, /public handoff instructions/);
});

test('lab readiness includes desktop packaging and downloadable release proof', () => {
  const packageGate = labReadinessSteps().find(step => step.id === 'desktop-package-contract');
  const releaseGate = labReadinessSteps().find(step => step.id === 'release-download-contract');
  assert.deepEqual(packageGate.args, ['scripts/check_electron_package.mjs']);
  assert.match(packageGate.proves, /desktop file associations/);
  assert.match(packageGate.proves, /private\/dev\/patient files/);
  assert.deepEqual(releaseGate.args, ['scripts/check_release_workflow.mjs']);
  assert.match(releaseGate.proves, /gate macOS and Windows desktop builds on the verification job/);
  assert.match(releaseGate.proves, /downloadable installers\/archives/);
  assert.match(releaseGate.proves, /validate per-platform make outputs before upload/);
  assert.match(releaseGate.proves, /launch the packaged macOS app before upload/);
  assert.match(releaseGate.proves, /mount\/extract macOS release artifacts before upload/);
  assert.match(releaseGate.proves, /validate collected release assets/);
});

test('lab readiness includes sanitized public export proof', () => {
  const exportGate = labReadinessSteps().find(step => step.id === 'public-export-contract');
  assert.deepEqual(exportGate.args, ['scripts/run_python.mjs', '-m', 'pytest', 'tests/test_public_sync.py', '-q']);
  assert.match(exportGate.proves, /sanitized public export/);
  assert.match(exportGate.proves, /patient data/);
  assert.match(exportGate.proves, /one-root publication/);
});

test('lab readiness Electron gate includes desktop read-failure proof', () => {
  const electronGate = labReadinessSteps().find(step => step.id === 'electron-desktop-intake');
  assert.deepEqual(electronGate.args, ['run', 'desktop:smoke']);
  assert.match(packageJson.scripts?.['desktop:smoke'], /tests\/electron-microscopy-workflow-smoke\.mjs/);
  assert.match(electronGate.proves, /unsupported skips, file read failures, folder read failures/);
  assert.match(electronGate.proves, /mixed native medical\/microscopy family boundaries/);
  assert.match(electronGate.proves, /mixed-folder Open Recent replay/);
  assert.match(electronGate.proves, /local NIfTI calibration\/source provenance/);
  assert.match(electronGate.proves, /local TIFF sequence provenance\/manual calibration/);
  assert.match(electronGate.proves, /Electron-launched calibrated microscopy measurement and annotation plus CSV, PNG, and workflow recipe export/);
  assert.match(electronGate.proves, /source-bound SR sidecars/);
});

test('lab readiness browser gate includes local medical provenance proof', () => {
  const browserGate = labReadinessSteps().find(step => step.id === 'browser-user-flows');
  assert.ok(browserGate.args.includes('tests/browser/viewer-nifti-boundaries.spec.js'));
  assert.ok(browserGate.args.includes('tests/browser/viewer-upload-flows.spec.js'));
  assert.match(browserGate.proves, /visible unsupported skips, file read failures, and folder read failures/);
  assert.match(browserGate.proves, /local DICOM\/NIfTI source provenance/);
  assert.match(browserGate.proves, /unsupported 4D NIfTI rejection/);
  assert.match(browserGate.proves, /mixed native medical\/microscopy family boundaries/);
  assert.match(browserGate.proves, /visible skipped local derived-object reasons/);
  assert.match(browserGate.proves, /source-bound DICOM SR and microscopy sidecar guidance/);
});

test('lab readiness browser gate includes MPR geometry stability proof', () => {
  const browserGate = labReadinessSteps().find(step => step.id === 'browser-user-flows');
  assert.ok(browserGate.args.includes('tests/browser/viewer-mpr-stability.spec.js'));
  assert.match(browserGate.proves, /MPR geometry stability/);
});

test('lab readiness browser gate includes calibrated microscopy export proof', () => {
  const browserGate = labReadinessSteps().find(step => step.id === 'browser-user-flows');
  assert.ok(browserGate.args.includes('tests/browser/viewer-microscopy-export.spec.js'));
  assert.match(browserGate.proves, /calibrated export artifacts/);
});

test('lab readiness browser gate includes microscopy analysis workflow proof', () => {
  const browserGate = labReadinessSteps().find(step => step.id === 'browser-user-flows');
  assert.ok(browserGate.args.includes('tests/browser/viewer-microscopy-analysis.spec.js'));
  assert.match(browserGate.proves, /analysis workflow/);
});

test('lab readiness browser gate includes microscopy time navigation proof', () => {
  const browserGate = labReadinessSteps().find(step => step.id === 'browser-user-flows');
  assert.ok(browserGate.args.includes('tests/browser/viewer-microscopy-time.spec.js'));
  assert.match(browserGate.proves, /microscopy C\/Z\/T time navigation/);
});

test('lab readiness browser gate includes calibrated scale-bar and measurement proof', () => {
  const browserGate = labReadinessSteps().find(step => step.id === 'browser-user-flows');
  assert.ok(browserGate.args.includes('tests/browser/viewer-microscopy-measurement.spec.js'));
  assert.ok(browserGate.args.includes('tests/browser/viewer-microscopy-scale-bar.spec.js'));
  assert.match(browserGate.proves, /calibrated microscopy scale bars and measurements/);
});

test('lab readiness browser gate includes microscopy support-boundary proof', () => {
  const browserGate = labReadinessSteps().find(step => step.id === 'browser-user-flows');
  assert.ok(browserGate.args.includes('tests/browser/viewer-microscopy-format-boundaries.spec.js'));
  assert.match(browserGate.proves, /microscopy format boundaries/);
  assert.match(browserGate.proves, /fail-closed sidecar mismatch messages/);
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
  assert.equal(payload.steps.some(step => step.id === 'electron-desktop-intake'), false);
  assert.ok(payload.steps.some(step => step.id === 'public-sample-fixtures'));
  const publicSamples = payload.steps.find(step => step.id === 'public-sample-fixtures');
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
  assert.match(omittedElectron.proves, /Electron-launched calibrated microscopy measurement and annotation plus CSV, PNG, and workflow recipe export/);
  assert.ok(payload.boundary.includes('not clinical'));
});

test('lab readiness summary records planned and omitted proof lanes', () => {
  const payload = labReadinessSummary({ dryRun: true, skipBrowser: true });
  assert.equal(payload.status, 'planned');
  assert.equal(payload.durationMs, 0);
  assert.match(payload.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(payload.repo.commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof payload.repo.branch === 'string' || payload.repo.branch === null, true);
  assert.equal(typeof payload.repo.dirty, 'boolean');
  assert.equal(typeof payload.repo.statusShort, 'string');
  assert.ok(payload.steps.every(step => step.status === 'planned'));
  assert.deepEqual(payload.proofCoverage, {
    scope: 'partial',
    totalLanes: 10,
    includedLanes: 9,
    omittedLanes: 1,
    omittedIds: ['browser-user-flows'],
  });
  assert.equal(payload.omitted.length, 1);
  assert.equal(payload.omitted[0].id, 'browser-user-flows');
  assert.match(payload.omitted[0].reason, /--skip-browser/);
  assert.match(payload.omitted[0].proves, /analysis workflow/);
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

test('lab readiness summary maps proof lanes to the researcher workflow', () => {
  const payload = labReadinessSummary({ dryRun: true, skipBrowser: true });
  assert.deepEqual(payload.researcherWorkflow.map(item => item.id), [
    'desktop-install-open',
    'mixed-folder-triage',
    'supported-open-calibration-provenance',
    'microscopy-measure-export-recipe',
    'honest-failure-boundaries',
    'public-release-handoff',
  ]);
  const triage = payload.researcherWorkflow.find(item => item.id === 'mixed-folder-triage');
  assert.equal(triage.status, 'partial');
  assert.deepEqual(triage.evidenceLanes, [
    { id: 'node-contracts', status: 'planned' },
    { id: 'browser-user-flows', status: 'omitted' },
    { id: 'electron-desktop-intake', status: 'planned' },
  ]);
  const release = payload.researcherWorkflow.find(item => item.id === 'public-release-handoff');
  assert.equal(release.status, 'planned');
  assert.match(release.outcome, /downloadable release artifacts/);
  const calibration = payload.researcherWorkflow.find(item => item.id === 'supported-open-calibration-provenance');
  assert.deepEqual(calibration.evidenceLanes.map(item => item.id), [
    'node-contracts',
    'public-sample-fixtures',
    'browser-user-flows',
    'electron-desktop-intake',
  ]);
  const microscopyWorkflow = payload.researcherWorkflow.find(item => item.id === 'microscopy-measure-export-recipe');
  assert.equal(microscopyWorkflow.status, 'partial');
  assert.deepEqual(microscopyWorkflow.evidenceLanes, [
    { id: 'node-contracts', status: 'planned' },
    { id: 'public-sample-fixtures', status: 'planned' },
    { id: 'browser-user-flows', status: 'omitted' },
    { id: 'electron-desktop-intake', status: 'planned' },
  ]);
});

test('lab readiness repo evidence snapshot records commit and dirty state', () => {
  const snapshot = repoEvidenceSnapshot();
  assert.match(snapshot.commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof snapshot.branch === 'string' || snapshot.branch === null, true);
  assert.equal(typeof snapshot.upstream === 'string' || snapshot.upstream === null, true);
  assert.equal(typeof snapshot.dirty, 'boolean');
  assert.equal(typeof snapshot.statusShort, 'string');
});

test('lab readiness writes a passed evidence report for focused non-UI lanes', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'voxellab-lab-report-'));
  const reportPath = join(tempDir, 'report.json');
  const privateLaneSkips = [];
  if (!existsSync(join(ROOT, 'docs/validation-matrix.md'))) privateLaneSkips.push('--skip-validation-matrix');
  if (!existsSync(join(ROOT, 'scripts/sync_public_repo.py'))) privateLaneSkips.push('--skip-public-export');
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
  assert.equal(typeof payload.repo.branch === 'string' || payload.repo.branch === null, true);
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
