/* global console, process */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_MICROSCOPY_FIXTURE_EVIDENCE } from './verify_microscopy_public_samples.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROOF_TYPE_TAXONOMY = Object.freeze({
  static: 'file, workflow, or documentation inspection; no runtime behavior is exercised by this lane',
  contract: 'focused repo contract or fixture assertions; not an end-to-end live workflow proof',
  runtime: 'local browser, desktop, or app entrypoint behavior exercised through the gate command',
  oracle: 'source-backed fixture or public sample evidence checked against expected boundaries',
});
const PROOF_TYPES = new Set(Object.keys(PROOF_TYPE_TAXONOMY));

const NODE_CONTRACT_TESTS = Object.freeze([
  'tests/desktop-intake-text.test.mjs',
  'tests/desktop-path-file.test.mjs',
  'tests/electron-desktop-contract.test.mjs',
  'tests/file-drop.test.mjs',
  'tests/format-capability-matrix.test.mjs',
  'tests/intake-format-summary.test.mjs',
  'tests/imagej-roi.test.mjs',
  'tests/local-intake-summary.test.mjs',
  'tests/local-intake-text.test.mjs',
  'tests/dicom-import-parse.test.mjs',
  'tests/dicom-derived-import.test.mjs',
  'tests/derived-objects.test.mjs',
  'tests/series-select-dom.test.mjs',
  'tests/microscopy-channel-composite.test.mjs',
  'tests/microscopy-dataset-model.test.mjs',
  'tests/microscopy-display-range.test.mjs',
  'tests/microscopy-hyperstack-controls.test.mjs',
  'tests/microscopy-import.test.mjs',
  'tests/microscopy-sequence-import.test.mjs',
  'tests/microscopy-provenance-text.test.mjs',
  'tests/microscopy-zarr-metadata.test.mjs',
  'tests/microscopy-zarr-import.test.mjs',
  'tests/microscopy-workflow-recipe.test.mjs',
  'tests/microscopy-plane-sampler.test.mjs',
  'tests/microscopy-projection.test.mjs',
  'tests/microscopy-threshold.test.mjs',
  'tests/microscopy-particles.test.mjs',
  'tests/microscopy-particles-rows.test.mjs',
  'tests/microscopy-evidence-package.test.mjs',
  'tests/microscopy-analysis-recipe.test.mjs',
  'tests/microscopy-analysis-overlay.test.mjs',
  'tests/microscopy-analysis-invariant.test.mjs',
  'tests/roi-stats-domain.test.mjs',
  'tests/microscopy-accuracy.test.mjs',
  'tests/roi-results.test.mjs',
  'tests/release-assets-check.test.mjs',
  'tests/readme-handoff.test.mjs',
]);

const BROWSER_SPECS = Object.freeze([
  'tests/browser/viewer-nifti-boundaries.spec.js',
  'tests/browser/viewer-upload-flows.spec.js',
  'tests/browser/viewer-microscopy-upload.spec.js',
  'tests/browser/viewer-microscopy-format-boundaries.spec.js',
  'tests/browser/viewer-microscopy-workflow.spec.js',
  'tests/browser/viewer-microscopy-time.spec.js',
  'tests/browser/viewer-microscopy-measurement.spec.js',
  'tests/browser/viewer-microscopy-scale-bar.spec.js',
  'tests/browser/viewer-microscopy-analysis.spec.js',
  'tests/browser/viewer-microscopy-export.spec.js',
  'tests/browser/viewer-microscopy-zarr-workflow.spec.js',
  'tests/browser/viewer-mpr-stability.spec.js',
]);

const RESEARCHER_WORKFLOW_EVIDENCE = Object.freeze([
  {
    id: 'desktop-install-open',
    outcome: 'download or package the desktop app, then open local files or folders through the native shell',
    laneIds: ['desktop-package-contract', 'release-download-contract', 'electron-desktop-intake'],
  },
  {
    id: 'mixed-folder-triage',
    outcome: 'show a clear mixed-folder intake summary for supported, converter-backed, sidecar, skipped, and failed files',
    laneIds: ['node-contracts', 'browser-user-flows', 'electron-desktop-intake'],
  },
  {
    id: 'supported-open-calibration-provenance',
    outcome: 'open supported medical and microscopy data while preserving geometry, calibration, and provenance boundaries',
    laneIds: ['node-contracts', 'public-sample-fixtures', 'browser-user-flows', 'electron-desktop-intake'],
  },
  {
    id: 'microscopy-measure-export-recipe',
    outcome: 'navigate microscopy C/Z/T/channel data, measure or annotate, export results, and replay workflow recipes',
    laneIds: ['node-contracts', 'public-sample-fixtures', 'browser-user-flows', 'electron-desktop-intake'],
  },
  {
    id: 'honest-failure-boundaries',
    outcome: 'fail closed with named user-visible errors for unsupported, unsafe, or misleading inputs',
    laneIds: ['node-contracts', 'validation-matrix-contract', 'browser-user-flows', 'electron-desktop-intake'],
  },
  {
    id: 'public-release-handoff',
    outcome: 'produce a sanitized public export and downloadable release artifacts only after verification',
    laneIds: ['public-export-contract', 'release-download-contract'],
  },
]);

const FIRST_USE_WORKFLOW = Object.freeze({
  id: 'calibrated-microscopy-particle-evidence-handoff',
  version: 'v1',
  name: 'Calibrated microscopy particle evidence handoff',
  user: 'life-science research scientist',
  timeBudgetMinutes: 10,
  input: 'OME-TIFF or ImageJ-style microscopy file opened through the VoxelLab upload UI',
  primaryExperience: 'VoxelLab browser or desktop viewer UI',
  inspection: 'calibration, C/Z/T/channel axes, source format, and active plane are visible before analysis',
  advancedOperation: 'Analyze Particles on retained raw microscopy planes',
  exportedArtifact: 'voxellab-microscopy-evidence-<series>.zip',
  packageContents: [
    'ROI results JSON',
    'ROI results CSV',
    'annotated PNG snapshot',
    'analysis/threshold descriptor',
    'calibration, axes, and source manifest',
    'limitations text',
  ],
  limitations: [
    'Research and educational use only; not clinical or diagnostic output.',
    'OME/ImageJ/TIFF microscopy support is bounded; not Bio-Formats or Fiji parity.',
    'Physical measurements are trusted only when metadata or manual calibration is explicit.',
    'Particle evidence is threshold-driven and must be reviewed by the researcher.',
  ],
  provenance: [
    'source file names and microscopy format',
    'C/Z/T/channel axes and selected channel/time',
    'metadata or manual calibration and spacing trust',
    'raw intensity domain and Analyze Particles ROI rows',
  ],
  laneIds: [
    'node-contracts',
    'public-sample-fixtures',
    'browser-user-flows',
    'public-export-contract',
    'release-download-contract',
  ],
  decision: 'double down',
  decisionRationale: 'Evidence packaging is the core product layer now: the current code can import calibrated microscopy files, inspect provenance, run a bounded analysis, and export a collaborator-ready package without cloud credentials, source pixels, or clinical claims. Analysis depth should come next only after this handoff stays trustworthy.',
});

const STEP_CLAIMS = Object.freeze({
  nodeContracts: 'contract check: focused node tests cover desktop payload/path contracts, desktop and local intake summary/text including mixed native medical/microscopy family boundaries plus separate skipped-file, file-read-failure, and folder-read-failure wording, browser file/folder selection cleanup and caps, public handoff instructions, source-bound DICOM SR and microscopy sidecar guidance, DICOM/NIfTI calibration/source provenance, DICOM SEG/RTSTRUCT/SR derived-object binding contracts, anisotropic pixel-spacing display, microscopy OME/ImageJ/TIFF import, dataset, hyperstack, channel, display-range, sequence, ROI, and provenance contracts, OME-Zarr metadata/import boundaries, recipe replay, microscopy projection/threshold/Analyze Particles contracts, ROI export contracts, named ROI sidecar mismatch reasons, and release asset validation contracts',
  validationMatrix: 'static coverage-ledger check: validation matrix claim ledger is parseable and every public support claim keeps a nonempty validation coverage ledger entry attached',
  demoPack: 'contract check: public lite demo pack catalog/install contract plus optional MRI, CT, OME-TIFF, ImageJ TIFF, and OME-Zarr sample-pack metadata and attribution',
  converters: 'contract check: local microscopy converter boundaries for optional-reader CZI/ND2/LIF and external-converter CZI/ND2/LIF/OIB/OIF/LSM, reader/converter fail-closed behavior, external OME-TIFF validation, and sample-backed conversion evidence when local vendor samples/readers are available',
  desktopPackage: 'static package-contract proof: Electron Forge package identity, desktop file associations, packaged app asset allowlist, and exclusion of private/dev/patient files from desktop builds',
  releaseDownload: 'static workflow-contract proof: release workflow YAML requires verification before macOS and Windows desktop builds, per-platform make-output validation, packaged macOS app smoke and macOS artifact smoke commands before upload, collected release-asset validation, and downloadable installers/archives only after both platform builds finish',
  publicExport: 'contract check: sanitized public export removes private workflow files, patient data, local reports, provider config, and repo-only sync scripts before one-root publication',
  publicSamples: 'oracle check: public OME-TIFF, ImageJ TIFF, and OME-Zarr sample evidence with explicit support boundaries',
  browserFlows: 'runtime check: browser upload triage with visible unsupported skips, file read failures, and folder read failures, local DICOM/NIfTI source provenance, unsupported 4D NIfTI rejection, mixed native medical/microscopy family boundaries, visible skipped local derived-object reasons, source-bound DICOM SR and microscopy sidecar guidance, MPR geometry stability, microscopy format boundaries, fail-closed sidecar mismatch messages, microscopy C/Z/T time navigation, calibrated microscopy scale bars and measurements, microscopy navigation/workflow replay, analysis workflow with first-use microscopy particle evidence ZIP package export, calibrated export artifacts, and limited OME-Zarr user flows',
  electronIntake: 'runtime check: desktop shell boot, open-file/open-folder launch delivery, folder triage including unsupported skips, file read failures, folder read failures, and mixed native medical/microscopy family boundaries, mixed-folder Open Recent replay, local NIfTI calibration/source provenance, local TIFF sequence provenance/manual calibration, local OME-Zarr, Electron-launched calibrated microscopy measurement and annotation plus CSV, PNG, and workflow recipe export, source-bound SR sidecars, sidecars, conversion, and recent files',
});

function proofMetadata(claim, proofType) {
  if (!PROOF_TYPES.has(proofType)) throw new Error(`Unknown proofType: ${proofType}`);
  return { claim, proofType, proves: claim };
}

function proofStep({ id, command, args, claim, proofType, evidence }) {
  return {
    id,
    command,
    args,
    ...proofMetadata(claim, proofType),
    ...(evidence ? { evidence } : {}),
  };
}

function omittedProofLane(id, reason, claim, proofType) {
  return {
    id,
    reason,
    ...proofMetadata(claim, proofType),
  };
}

function publicMicroscopyFixtureEvidence() {
  return PUBLIC_MICROSCOPY_FIXTURE_EVIDENCE.map(({ label, format, coverage, boundary }) => ({
    label,
    format,
    coverage,
    boundary,
  }));
}

function nodeBin(command) {
  if (command === 'node') return process.execPath;
  return process.platform === 'win32' ? `${command}.cmd` : command;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    dryRun: false,
    json: false,
    reportPath: '',
    skipBrowser: false,
    skipConverters: false,
    skipDemoPack: false,
    skipElectron: false,
    skipPublicSamples: false,
    skipPublicExport: false,
    skipValidationMatrix: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--report') {
      const reportPath = argv[index + 1];
      if (!reportPath || reportPath.startsWith('--')) throw new Error('--report requires a path');
      options.reportPath = reportPath;
      index += 1;
    } else if (arg === '--skip-browser') options.skipBrowser = true;
    else if (arg === '--skip-converters') options.skipConverters = true;
    else if (arg === '--skip-demo-pack') options.skipDemoPack = true;
    else if (arg === '--skip-electron') options.skipElectron = true;
    else if (arg === '--skip-public-samples') options.skipPublicSamples = true;
    else if (arg === '--skip-public-export') options.skipPublicExport = true;
    else if (arg === '--skip-validation-matrix') options.skipValidationMatrix = true;
    else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

export function labReadinessSteps(options = {}) {
  const steps = [
    proofStep({
      id: 'node-contracts',
      command: 'node',
      args: ['--test', ...NODE_CONTRACT_TESTS],
      claim: STEP_CLAIMS.nodeContracts,
      proofType: 'contract',
    }),
  ];

  if (!options.skipValidationMatrix) {
    steps.push(proofStep({
      id: 'validation-matrix-contract',
      command: 'node',
      args: ['scripts/run_python.mjs', 'scripts/check_validation_matrix.py'],
      claim: STEP_CLAIMS.validationMatrix,
      proofType: 'static',
    }));
  }

  if (!options.skipDemoPack) {
    steps.push(proofStep({
      id: 'demo-pack-contract',
      command: 'node',
      args: ['scripts/run_python.mjs', '-m', 'pytest', 'tests/test_demo_install.py', '-q'],
      claim: STEP_CLAIMS.demoPack,
      proofType: 'contract',
    }));
  }

  if (!options.skipConverters) {
    steps.push(proofStep({
      id: 'converter-contracts',
      command: 'node',
      args: [
        'scripts/run_python.mjs',
        '-m',
        'pytest',
        'tests/test_microscopy_convert.py',
        'tests/test_microscopy_convert_samples.py',
        '-q',
      ],
      claim: STEP_CLAIMS.converters,
      proofType: 'contract',
    }));
  }

  steps.push(
    proofStep({
      id: 'desktop-package-contract',
      command: 'node',
      args: ['scripts/check_electron_package.mjs'],
      claim: STEP_CLAIMS.desktopPackage,
      proofType: 'static',
    }),
    proofStep({
      id: 'release-download-contract',
      command: 'node',
      args: ['scripts/check_release_workflow.mjs'],
      claim: STEP_CLAIMS.releaseDownload,
      proofType: 'static',
    }),
  );

  if (!options.skipPublicExport) {
    steps.push(proofStep({
      id: 'public-export-contract',
      command: 'node',
      args: ['scripts/run_python.mjs', '-m', 'pytest', 'tests/test_public_sync.py', '-q'],
      claim: STEP_CLAIMS.publicExport,
      proofType: 'contract',
    }));
  }

  if (!options.skipPublicSamples) {
    steps.push(proofStep({
      id: 'public-sample-fixtures',
      command: 'node',
      args: ['scripts/verify_microscopy_public_samples.mjs'],
      claim: STEP_CLAIMS.publicSamples,
      proofType: 'oracle',
      evidence: publicMicroscopyFixtureEvidence(),
    }));
  }

  if (!options.skipBrowser) {
    steps.push(proofStep({
      id: 'browser-user-flows',
      command: 'npx',
      args: ['playwright', 'test', ...BROWSER_SPECS, '--project=chromium', '--workers=1'],
      claim: STEP_CLAIMS.browserFlows,
      proofType: 'runtime',
    }));
  }

  if (!options.skipElectron) {
    steps.push(proofStep({
      id: 'electron-desktop-intake',
      command: 'npm',
      args: ['run', 'desktop:smoke'],
      claim: STEP_CLAIMS.electronIntake,
      proofType: 'runtime',
    }));
  }

  return steps;
}

function omittedProofLanes(options = {}) {
  const omitted = [];
  if (options.skipValidationMatrix) {
    omitted.push(omittedProofLane(
      'validation-matrix-contract',
      'skipped by --skip-validation-matrix',
      STEP_CLAIMS.validationMatrix,
      'static',
    ));
  }
  if (options.skipPublicExport) {
    omitted.push(omittedProofLane(
      'public-export-contract',
      'skipped by --skip-public-export',
      STEP_CLAIMS.publicExport,
      'contract',
    ));
  }
  if (options.skipDemoPack) {
    omitted.push(omittedProofLane(
      'demo-pack-contract',
      'skipped by --skip-demo-pack',
      STEP_CLAIMS.demoPack,
      'contract',
    ));
  }
  if (options.skipConverters) {
    omitted.push(omittedProofLane(
      'converter-contracts',
      'skipped by --skip-converters',
      STEP_CLAIMS.converters,
      'contract',
    ));
  }
  if (options.skipPublicSamples) {
    omitted.push(omittedProofLane(
      'public-sample-fixtures',
      'skipped by --skip-public-samples',
      STEP_CLAIMS.publicSamples,
      'oracle',
    ));
  }
  if (options.skipBrowser) {
    omitted.push(omittedProofLane(
      'browser-user-flows',
      'skipped by --skip-browser',
      STEP_CLAIMS.browserFlows,
      'runtime',
    ));
  }
  if (options.skipElectron) {
    omitted.push(omittedProofLane(
      'electron-desktop-intake',
      'skipped by --skip-electron',
      STEP_CLAIMS.electronIntake,
      'runtime',
    ));
  }
  return omitted;
}

function commandLine(step) {
  return [step.command, ...step.args].join(' ');
}

function workflowLaneStatuses(laneIds, stepById, omittedIds) {
  return laneIds.map((laneId) => {
    if (omittedIds.has(laneId)) return { id: laneId, status: 'omitted' };
    return { id: laneId, status: stepById.get(laneId)?.status || 'pending' };
  });
}

function statusForWorkflowLanes(laneStatuses) {
  if (laneStatuses.some(item => item.status === 'failed')) return 'failed';
  if (laneStatuses.some(item => item.status === 'omitted')) return 'partial';
  if (laneStatuses.every(item => item.status === 'passed')) return 'passed';
  if (laneStatuses.every(item => item.status === 'planned')) return 'planned';
  return 'pending';
}

function workflowEvidenceMap(steps, omitted) {
  return {
    stepById: new Map(steps.map(step => [step.id, step])),
    omittedIds: new Set((omitted || []).map(step => step.id)),
  };
}

function researcherWorkflowEvidence(steps, omitted) {
  const { stepById, omittedIds } = workflowEvidenceMap(steps, omitted);
  return RESEARCHER_WORKFLOW_EVIDENCE.map(({ id, outcome, laneIds }) => {
    const evidenceLanes = workflowLaneStatuses(laneIds, stepById, omittedIds);
    return { id, outcome, status: statusForWorkflowLanes(evidenceLanes), evidenceLanes };
  });
}

function firstUsefulWorkflowEvidence(steps, omitted) {
  const { stepById, omittedIds } = workflowEvidenceMap(steps, omitted);
  const evidenceLanes = workflowLaneStatuses(FIRST_USE_WORKFLOW.laneIds, stepById, omittedIds);
  return {
    ...FIRST_USE_WORKFLOW,
    status: statusForWorkflowLanes(evidenceLanes),
    evidenceLanes,
  };
}

function gitOutput(args) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0 || result.error || result.signal) return '';
  return result.stdout.trim();
}

export function repoEvidenceSnapshot() {
  const statusShort = gitOutput(['status', '--short']);
  return {
    commit: gitOutput(['rev-parse', 'HEAD']) || null,
    branch: gitOutput(['branch', '--show-current']) || null,
    upstream: gitOutput(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) || null,
    dirty: statusShort.length > 0,
    statusShort,
  };
}

export function labReadinessSummary(options = {}, results = []) {
  const resultById = new Map(results.map(result => [result.id, result]));
  const steps = labReadinessSteps(options).map(({ id, command, args, claim, proofType, proves, evidence }) => ({
    id,
    command,
    args,
    commandLine: commandLine({ command, args }),
    claim,
    proofType,
    proves,
    status: resultById.get(id)?.status ?? (options.dryRun ? 'planned' : 'pending'),
    exitCode: resultById.get(id)?.exitCode,
    durationMs: resultById.get(id)?.durationMs,
    ...(evidence ? { evidence } : {}),
  }));
  const omitted = omittedProofLanes(options);
  const totalLaneCount = labReadinessSteps().length;
  const failed = steps.find(step => step.status === 'failed');
  const pending = steps.some(step => step.status === 'pending');
  const durationMs = results.reduce((total, result) => total + Number(result.durationMs || 0), 0);
  return {
    gate: 'VoxelLab lab readiness',
    status: failed ? 'failed' : pending ? 'pending' : options.dryRun ? 'planned' : 'passed',
    generatedAt: new Date().toISOString(),
    durationMs,
    repo: repoEvidenceSnapshot(),
    proofTypeTaxonomy: PROOF_TYPE_TAXONOMY,
    proofCoverage: {
      scope: omitted.length ? 'partial' : 'full',
      totalLanes: totalLaneCount,
      includedLanes: steps.length,
      omittedLanes: omitted.length,
      omittedIds: omitted.map(step => step.id),
    },
    firstUsefulWorkflow: firstUsefulWorkflowEvidence(steps, omitted),
    researcherWorkflow: researcherWorkflowEvidence(steps, omitted),
    steps,
    omitted,
    boundary: 'focused first-pass research intake proof; not clinical, Fiji, PACS, Bio-Formats, or proprietary-format parity',
  };
}

function writeReport(reportPath, payload) {
  if (!reportPath) return;
  const resolvedPath = path.isAbsolute(reportPath) ? reportPath : path.resolve(ROOT, reportPath);
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, `${JSON.stringify(payload, null, 2)}\n`);
}

function helpText() {
  return [
    'Usage: node scripts/check_lab_readiness.mjs [options]',
    '',
    'Runs the focused gate for VoxelLab first-pass lab intake readiness.',
    '',
    'Options:',
    '  --dry-run              Print the planned evidence lanes without running them.',
    '  --json                 Print machine-readable lane status.',
    '  --report <path>        Write the machine-readable evidence report to a JSON file.',
    '  --skip-validation-matrix',
    '                         Skip the private validation-matrix ledger proof.',
    '  --skip-public-export   Skip the private public-export sync proof.',
    '  --skip-demo-pack       Skip the private Python demo-pack installer proof.',
    '  --skip-converters      Skip the private Python microscopy converter proof.',
    '  --skip-public-samples  Skip live public microscopy sample downloads/verifiers.',
    '  --skip-browser         Skip Playwright browser user-flow specs.',
    '  --skip-electron        Skip hidden Electron desktop smoke tests.',
  ].join('\n');
}

function runStep(step, options = {}) {
  console.error(`\n[voxellab:lab] ${step.id}`);
  console.error(`[voxellab:lab] proofType: ${step.proofType}`);
  console.error(`[voxellab:lab] proves: ${step.proves}`);
  const startedAt = Date.now();
  const captureChildOutput = options.json;
  const result = spawnSync(nodeBin(step.command), step.args, {
    cwd: ROOT,
    stdio: captureChildOutput ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    encoding: captureChildOutput ? 'utf8' : undefined,
    env: { ...process.env },
  });
  if (captureChildOutput) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  const durationMs = Date.now() - startedAt;
  if (result.error) {
    console.error(`[voxellab:lab] ${step.id} failed to start: ${result.error.message}`);
    return { status: 1, durationMs };
  }
  if (result.signal) {
    console.error(`[voxellab:lab] ${step.id} terminated by ${result.signal}`);
    return { status: 1, durationMs };
  }
  return { status: result.status ?? 1, durationMs };
}

function main() {
  let options;
  try {
    options = parseArgs();
  } catch (error) {
    console.error(error.message);
    console.error(helpText());
    process.exit(2);
  }
  if (options.help) {
    console.log(helpText());
    return;
  }

  const steps = labReadinessSteps(options);

  if (options.dryRun) {
    const summary = labReadinessSummary(options);
    writeReport(options.reportPath, summary);
    console.log(options.json ? JSON.stringify(summary, null, 2) : helpText());
    if (!options.json) {
      for (const step of steps) {
        console.log(`\n${step.id}\n  ${step.command} ${step.args.join(' ')}\n  proofType: ${step.proofType}\n  proves: ${step.proves}`);
      }
    }
    return;
  }

  const results = [];
  for (const step of steps) {
    const result = runStep(step, options);
    results.push({
      id: step.id,
      status: result.status === 0 ? 'passed' : 'failed',
      exitCode: result.status,
      durationMs: result.durationMs,
    });
    if (result.status !== 0) {
      console.error(`\n[voxellab:lab] failed at ${step.id}`);
      const summary = labReadinessSummary(options, results);
      writeReport(options.reportPath, summary);
      if (options.json) console.log(JSON.stringify(summary, null, 2));
      process.exit(result.status);
    }
  }

  const summary = labReadinessSummary(options, results);
  writeReport(options.reportPath, summary);
  if (options.json) console.log(JSON.stringify(summary, null, 2));
  else console.log('\n[voxellab:lab] OK: focused lab-readiness gate passed');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
