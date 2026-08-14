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

const STEP_CLAIMS = Object.freeze({
  nodeContracts: 'focused medical, microscopy, intake, export, and release contract tests',
  validationMatrix: 'static validation-coverage ledger check',
  demoPack: 'public demo-pack catalog and installer contracts',
  converters: 'microscopy reader and converter boundary contracts',
  desktopPackage: 'static Electron package and private-file exclusion check',
  releaseDownload: 'static release workflow and downloadable-artifact check',
  publicExport: 'sanitized one-root public export contract',
  publicSamples: 'source-backed public microscopy sample checks',
  browserFlows: 'browser intake, viewing, measurement, analysis, and export flows',
  electronIntake: 'desktop launch, intake, viewing, measurement, export, and recent-file flows',
});

function proofMetadata(claim, proofType) {
  if (!PROOF_TYPES.has(proofType)) throw new Error(`Unknown proofType: ${proofType}`);
  return { claim, proofType };
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
  const steps = labReadinessSteps(options).map(({ id, command, args, claim, proofType, evidence }) => ({
    id,
    command,
    args,
    commandLine: commandLine({ command, args }),
    claim,
    proofType,
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
  console.error(`[voxellab:lab] claim: ${step.claim}`);
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
        console.log(`\n${step.id}\n  ${step.command} ${step.args.join(' ')}\n  proofType: ${step.proofType}\n  claim: ${step.claim}`);
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
