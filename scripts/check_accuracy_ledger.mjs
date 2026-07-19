#!/usr/bin/env node
/* global console, process */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { geometryFromSeries } from '../js/core/geometry.js';
import { buildDICOMSeriesResult } from '../js/dicom/dicom-import-parse.js';
import { parseNIfTI } from '../js/dicom/nifti-import-parse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FIXTURE_ROOT = process.env.VOXELLAB_ACCURACY_FIXTURE_ROOT
  ? resolve(process.env.VOXELLAB_ACCURACY_FIXTURE_ROOT)
  : join(ROOT, 'tests', 'fixtures', 'accuracy');
const NIFTI_FIXTURE_DIR = join(FIXTURE_ROOT, 'nifti');
const DICOM_FIXTURE_DIR = join(FIXTURE_ROOT, 'dicom');
const TOLERANCE = 1e-6;
const NIFTI_CHECKED_CODE_PATH = [
  'js/dicom/nifti-import-parse.js parseNIfTI',
  'js/core/geometry.js geometryFromSeries',
];
const DICOM_CHECKED_CODE_PATH = [
  'scripts/check_accuracy_ledger.mjs dcmjs fixture adapter',
  'js/dicom/dicom-frame-meta.js frameMetasForInstance',
  'js/dicom/dicom-import-parse.js buildDICOMSeriesResult',
  'js/core/geometry.js geometryFromSeries',
];
const MISMATCH_ERROR = TOLERANCE + 1;

let dcmjsModulePromise = null;

function createCanvasStub() {
  const context = {
    createImageData(width, height) {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData() {},
  };
  return {
    width: 0,
    height: 0,
    getContext() {
      return context;
    },
  };
}

async function withDocumentStub(fn) {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      return createCanvasStub();
    },
  };
  try {
    return await fn();
  } finally {
    globalThis.document = previousDocument;
  }
}

function fixtureFile(name) {
  const bytes = readFileSync(join(NIFTI_FIXTURE_DIR, name));
  return {
    name,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function affinePoint(affine, voxel) {
  const [i, j, k] = voxel;
  return [
    affine[0][0] * i + affine[0][1] * j + affine[0][2] * k + affine[0][3],
    affine[1][0] * i + affine[1][1] * j + affine[1][2] * k + affine[1][3],
    affine[2][0] * i + affine[2][1] * j + affine[2][2] * k + affine[2][3],
  ];
}

function maxAbsError(actual, expected) {
  let max = 0;
  for (let r = 0; r < expected.length; r++) {
    for (let c = 0; c < expected[r].length; c++) {
      max = Math.max(max, Math.abs(actual[r][c] - expected[r][c]));
    }
  }
  return max;
}

function maxPointError(affine, goldenPoints) {
  let max = 0;
  for (const point of goldenPoints) {
    const actual = affinePoint(affine, point.voxel);
    for (let index = 0; index < point.world.length; index++) {
      max = Math.max(max, Math.abs(actual[index] - point.world[index]));
    }
  }
  return max;
}

function compareExpectedValue(actual, expected, path, mismatches) {
  if (typeof expected === 'number') {
    const actualNumber = Number(actual);
    if (!Number.isFinite(actualNumber)) {
      mismatches.push(`${path}: expected finite number, got ${String(actual)}`);
      return MISMATCH_ERROR;
    }
    const error = Math.abs(actualNumber - expected);
    if (error > TOLERANCE) mismatches.push(`${path}: ${actualNumber} !== ${expected}`);
    return error;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      mismatches.push(`${path}: array shape mismatch`);
      return MISMATCH_ERROR;
    }
    return expected.reduce((max, value, index) => Math.max(
      max,
      compareExpectedValue(actual[index], value, `${path}[${index}]`, mismatches),
    ), 0);
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') {
      mismatches.push(`${path}: object shape mismatch`);
      return MISMATCH_ERROR;
    }
    return Object.entries(expected).reduce((max, [key, value]) => Math.max(
      max,
      compareExpectedValue(actual[key], value, `${path}.${key}`, mismatches),
    ), 0);
  }
  if (!Object.is(actual, expected)) {
    mismatches.push(`${path}: ${String(actual)} !== ${String(expected)}`);
    return MISMATCH_ERROR;
  }
  return 0;
}

function listGoldenFiles(fixtureDir) {
  if (!existsSync(fixtureDir)) return [];
  return readdirSync(fixtureDir)
    .filter((name) => name.endsWith('.golden.json'))
    .sort();
}

function referenceLabel(reference) {
  return `${reference.name} ${reference.version}`;
}

function dicomFilePath(relativePath) {
  return join(DICOM_FIXTURE_DIR, relativePath);
}

function readArrayBuffer(path) {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function loadDcmjsModule() {
  dcmjsModulePromise ||= import(pathToFileURL(join(ROOT, 'node_modules', 'dcmjs', 'build', 'dcmjs.es.js')).href);
  return dcmjsModulePromise;
}

async function loadDicomFixtureDatasets(golden) {
  const lib = await loadDcmjsModule();
  const datasets = [];
  for (const relativePath of golden.files) {
    const arrayBuffer = readArrayBuffer(dicomFilePath(relativePath));
    const dataset = lib.data.DicomMessage.readFile(arrayBuffer);
    const meta = lib.data.DicomMetaDictionary.naturalizeDataset(dataset.dict);
    datasets.push({
      meta,
      pixelData: dataset.dict['7FE00010'],
      file: {
        name: relativePath.split('/').pop(),
        webkitRelativePath: relativePath,
      },
    });
  }
  return datasets;
}

function formatError(value) {
  if (value === 0) return '0';
  if (!Number.isFinite(value)) return String(value);
  return value.toExponential(3);
}

function markdownTable(rows) {
  const lines = [
    '| Oracle | Fixture | Reference | Tolerance | Max abs error | Result |',
    '|---|---|---:|---:|---:|---|',
  ];
  for (const row of rows) {
    lines.push(`| ${row.oracle} | ${row.fixture} | ${row.reference} | ${row.tolerance} | ${formatError(row.maxAbsError)} | ${row.status} |`);
  }
  return lines.join('\n');
}

function writeArtifacts(ledger) {
  writeFileSync(
    join(ROOT, 'accuracy-ledger.json'),
    `${JSON.stringify(ledger, null, 2)}\n`,
    'utf8',
  );

  const reference = ledger.references.join(', ');
  const md = [
    '# Accuracy Ledger',
    '',
    `Reference: ${reference}`,
    `Tolerance: ${ledger.tolerance}`,
    '',
    'This regenerable trust artifact checks synthetic NIfTI-1 fixtures against nibabel goldens and synthetic DICOM stacks against pydicom-read DICOM PS3.3 Image Plane goldens. VoxelLab stores patient-space geometry as LPS millimeters, so nibabel RAS+ affines are transformed to LPS+ millimeters before comparison.',
    '',
    'Checked VoxelLab paths:',
    ...Object.entries(ledger.checkedCodePaths).map(([oracle, path]) => `- ${oracle}: ${path.join(' -> ')}`),
    '',
    markdownTable(ledger.rows),
    '',
    'Scope: this covers uncompressed scalar 3D NIfTI-1 affine ingestion through qform/sform metadata, spatial unit conversion to millimeters, and voxel-to-world mapping for committed synthetic fixtures. It also covers local DICOM stack sorting, IOP/IPP/PixelSpacing patient-space mapping, enhanced multi-frame per-frame geometry and pixel-value transformations, and fail-closed flags for duplicate IPP or mixed FrameOfReferenceUID fixtures.',
    '',
    'Not covered yet: NIfTI-2 or signed 8-bit/unsigned 32-bit numerical parity against an external oracle, NIfTI scalar dim-4 numerical parity against nibabel beyond synthetic import-contract tests, compressed `.nii.gz` numerical parity against an external oracle, compressed DICOM pixel codecs, derived-object registration, microscopy geometry, rendering, measurement UI, or any clinical/diagnostic use.',
    '',
  ].join('\n');
  writeFileSync(join(ROOT, 'ACCURACY_LEDGER.md'), md, 'utf8');
}

function rowIdentity(row) {
  return `${row.oracle}\0${row.fixture}`;
}

function matchesCommittedCorpus(rows) {
  let committed;
  try {
    committed = JSON.parse(readFileSync(join(ROOT, 'accuracy-ledger.json'), 'utf8'));
  } catch {
    return false;
  }
  const expected = Array.isArray(committed?.rows)
    ? committed.rows.map(rowIdentity).sort()
    : [];
  const actual = rows.map(rowIdentity).sort();
  return expected.length > 0
    && actual.length === expected.length
    && actual.every((identity, index) => identity === expected[index]);
}

async function buildNiftiRows(references) {
  const goldenFiles = listGoldenFiles(NIFTI_FIXTURE_DIR)
    .filter((name) => existsSync(join(NIFTI_FIXTURE_DIR, JSON.parse(readFileSync(join(NIFTI_FIXTURE_DIR, name), 'utf8')).fixture)));
  const rows = [];

  for (const goldenFile of goldenFiles) {
    const golden = JSON.parse(readFileSync(join(NIFTI_FIXTURE_DIR, goldenFile), 'utf8'));
    const result = await withDocumentStub(() => parseNIfTI(fixtureFile(golden.fixture)));
    assert.ok(result?.entry, `${golden.fixture} did not parse`);
    const actualAffine = geometryFromSeries(result.entry).affineLps;
    const expectedAffine = golden.expectedVoxelLab.affine;
    const affineError = maxAbsError(actualAffine, expectedAffine);
    const pointError = maxPointError(actualAffine, golden.expectedVoxelLab.voxelToWorldPoints);
    const maxError = Math.max(affineError, pointError);
    const reference = referenceLabel(golden.reference);
    const row = {
      oracle: 'nifti-affine-vs-nibabel',
      fixture: golden.fixture,
      reference,
      tolerance: TOLERANCE,
      maxAbsError: maxError,
      affineMaxAbsError: affineError,
      voxelToWorldMaxAbsError: pointError,
      status: maxError <= TOLERANCE ? 'PASS' : 'FAIL',
      checkedCodePath: NIFTI_CHECKED_CODE_PATH,
    };
    rows.push(row);
    references.add(reference);
  }
  return rows;
}

async function buildDicomRows(references) {
  const goldenFiles = listGoldenFiles(DICOM_FIXTURE_DIR)
    .filter((name) => {
      const golden = JSON.parse(readFileSync(join(DICOM_FIXTURE_DIR, name), 'utf8'));
      return golden.files.every((relativePath) => existsSync(dicomFilePath(relativePath)));
    });
  const rows = [];

  for (const goldenFile of goldenFiles) {
    const golden = JSON.parse(readFileSync(join(DICOM_FIXTURE_DIR, goldenFile), 'utf8'));
    const datasets = await loadDicomFixtureDatasets(golden);
    const skippedReasons = [];
    const result = await withDocumentStub(() => buildDICOMSeriesResult(
      datasets,
      () => {},
      `accuracy_${golden.fixture}`,
      skippedReasons,
    ));
    assert.ok(result?.entry, `${golden.fixture} did not parse (${skippedReasons.join(' | ')})`);

    const actualAffine = geometryFromSeries(result.entry).affineLps;
    const expected = golden.expectedVoxelLab;
    const affineError = maxAbsError(actualAffine, expected.affine);
    const pointError = maxPointError(actualAffine, expected.voxelToWorldPoints);
    const mismatches = [];
    const seriesFieldError = compareExpectedValue(result.entry, expected.series, 'series', mismatches);
    const normalizedVolumeError = expected.normalizedVolume
      ? compareExpectedValue(Array.from(result.rawVolume || []), expected.normalizedVolume, 'normalizedVolume', mismatches)
      : 0;
    const maxError = Math.max(affineError, pointError, seriesFieldError, normalizedVolumeError);
    const reference = referenceLabel(golden.reference);
    const row = {
      oracle: 'dicom-patient-space-vs-pydicom-ps3.3',
      fixture: golden.fixture,
      reference,
      tolerance: TOLERANCE,
      maxAbsError: maxError,
      affineMaxAbsError: affineError,
      voxelToWorldMaxAbsError: pointError,
      seriesFieldMaxAbsError: seriesFieldError,
      normalizedVolumeMaxAbsError: normalizedVolumeError,
      status: maxError <= TOLERANCE && mismatches.length === 0 ? 'PASS' : 'FAIL',
      checkedCodePath: DICOM_CHECKED_CODE_PATH,
      affineAppliesToVolume: expected.affineAppliesToVolume,
      volumeStackSafe: expected.volumeStackSafe,
      mismatches,
    };
    rows.push(row);
    references.add(reference);
  }
  return rows;
}

export async function buildAccuracyLedger() {
  const references = new Set();
  const rows = [
    ...await buildNiftiRows(references),
    ...await buildDicomRows(references),
  ];

  // Synthetic fixtures can be stripped from sanitized exports. With no fixtures
  // to verify, leave the committed ledger artifacts untouched.
  if (!rows.length) return null;

  const checkedCodePaths = Object.fromEntries(
    [...new Set(rows.map((row) => row.oracle))].map((oracle) => [
      oracle,
      rows.find((row) => row.oracle === oracle).checkedCodePath,
    ]),
  );
  const checkedCodePath = [...new Set(rows.flatMap((row) => row.checkedCodePath))];

  const ledger = {
    artifact: 'voxellab-accuracy-ledger',
    version: 1,
    tolerance: TOLERANCE,
    references: [...references].sort(),
    checkedCodePath,
    checkedCodePaths,
    summary: {
      total: rows.length,
      passed: rows.filter((row) => row.status === 'PASS').length,
      failed: rows.filter((row) => row.status !== 'PASS').length,
      maxAbsError: rows.reduce((max, row) => Math.max(max, row.maxAbsError), 0),
    },
    rows,
  };
  // Public exports intentionally omit the synthetic NIfTI binaries. Verify any
  // available oracle rows, but never replace the complete committed ledger with
  // a partial artifact assembled from the reduced public fixture corpus.
  if (matchesCommittedCorpus(rows)) writeArtifacts(ledger);
  return ledger;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ledger = await buildAccuracyLedger();
  if (!ledger) {
    console.log('No accuracy fixtures present; left committed ledger artifacts unchanged.');
  } else {
    for (const row of ledger.rows) {
      console.log(`${row.status} ${row.fixture} max_abs_error=${formatError(row.maxAbsError)}`);
    }
    if (!matchesCommittedCorpus(ledger.rows)) {
      console.log('Accuracy fixture corpus does not match the committed ledger; verified available rows and left committed artifacts unchanged.');
    }
    if (ledger.summary.failed > 0) process.exit(1);
  }
}
