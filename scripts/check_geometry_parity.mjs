#!/usr/bin/env node
// Geometry contract guard for the JS/Python dual implementation.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const FIXTURE_PATH = join(ROOT, 'tests', 'fixtures', 'geometry', 'canonical-cases.json');
const JS_PATH = join(ROOT, 'js', 'core', 'geometry.js');
const PY_PATH = join(ROOT, 'python', 'geometry.py');
const PYTHON = process.env.PYTHON
  || (existsSync(join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'))
    ? join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    : (process.platform === 'win32' ? 'python' : 'python3'));
const JS_ONLY = process.argv.includes('--js-only');

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const contractKeys = new Set(Object.keys(fixture.sharedContract));

const sharedMap = new Map([
  ['dot3', { js: 'dot3', py: 'dot3' }],
  ['cross3', { js: 'cross3', py: 'cross3' }],
  ['norm3', { js: 'norm3', py: 'norm3' }],
  ['normalize3', { js: 'normalize3', py: 'normalize3' }],
  ['sliceNormalFromIOP', { js: 'sliceNormalFromIOP', py: 'slice_normal_from_iop' }],
  ['sliceAxisAlignmentFromSeries', { js: 'sliceAxisAlignmentFromSeries', py: 'slice_axis_alignment_from_series' }],
  ['projectionAlongNormal', { js: 'projectionAlongNormal', py: 'ipp_projection' }],
  ['sortDatasetsSpatially', { js: 'sortDatasetsSpatially', py: 'sort_datasets_spatially' }],
  ['sliceSpacingStatsFromPositions', { js: 'sliceSpacingStatsFromPositions', py: 'spacing_from_positions' }],
  ['classifyGeometryKind', { js: 'classifyGeometryKind', py: 'classify_geometry_kind' }],
  ['affineLpsFromSeries', { js: 'geometryFromSeries', py: 'affine_lps_from_series' }],
  ['compareGroup', { js: 'seriesCompareGroup', py: 'compare_group_key' }],
  ['buildGeometryRecord', { js: 'buildGeometryRecord', py: 'build_geometry_record' }],
]);

const allowedJsOnly = new Map([
  ['numberList', 'browser DICOM metadata value coercion helper covered by JS geometry tests'],
  ['orientationFromIOP', 'browser import basis parser used by shared helpers'],
  ['voxelToPatientLps', 'browser coordinate readout helper over geometryFromSeries'],
  ['geometryFromDicomMetas', 'browser DICOM meta adapter feeding buildGeometryRecord'],
  ['inPlaneDisplaySize', 'browser canvas sizing helper'],
  ['inPlanePixelSpacing', 'browser measurement and scale-bar helper'],
  ['isOrthonormalImagePlane', 'browser DICOM derived-object validation helper'],
  ['patientPointAtSlice', 'browser slice navigation helper over geometryFromSeries'],
  ['closestSliceIndexForPatientPoint', 'browser compare and derived-object binding helper'],
]);
const allowedPyOnly = new Map([
  ['float_list', 'Python DICOM value coercion helper'],
  ['slice_sort_key', 'legacy Python sorting helper retained for callers'],
  ['frame_of_reference_summary', 'Python helper internal to geometry_from_slices'],
  ['extract_enhanced_multiframe_slices', 'Python enhanced multi-frame adapter feeding geometry_from_slices'],
  ['geometry_from_slices', 'Python DICOM slice adapter feeding build_geometry_record'],
  ['series_effective_slice_spacing', 'Python pipeline spacing helper over series records'],
]);
const geometryRecordFields = [
  'kind',
  'dimensions',
  'spacingMm',
  'sliceSpacingStatsMm',
  'slicePositionsDistinct',
  'orientation',
  'firstIPP',
  'lastIPP',
  'affineLps',
  'frameOfReferenceUID',
  'frameOfReferenceUIDConsistent',
  'source',
];

let failed = false;
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  failed = true;
};
const pass = (message) => console.log(`OK: ${message}`);

for (const key of contractKeys) {
  if (!sharedMap.has(key)) fail(`fixture contract "${key}" is missing from sharedMap`);
}
for (const key of sharedMap.keys()) {
  if (!contractKeys.has(key)) fail(`sharedMap contract "${key}" is missing from canonical-cases.json`);
}

const jsExports = [...readFileSync(JS_PATH, 'utf8').matchAll(/^export function (\w+)/gm)].map((m) => m[1]);
const pyDefs = [...readFileSync(PY_PATH, 'utf8').matchAll(/^def (\w+)/gm)].map((m) => m[1]);
const mappedJs = new Set([...sharedMap.values()].map((value) => value.js));
const mappedPy = new Set([...sharedMap.values()].map((value) => value.py));

for (const name of jsExports) {
  if (!mappedJs.has(name) && !allowedJsOnly.has(name)) {
    fail(`js/core/geometry.js export "${name}" lacks a shared fixture entry or allowlist reason`);
  }
}
for (const name of pyDefs) {
  if (!mappedPy.has(name) && !allowedPyOnly.has(name)) {
    fail(`geometry.py function "${name}" lacks a shared fixture entry or allowlist reason`);
  }
}
for (const [name, reason] of [...allowedJsOnly, ...allowedPyOnly]) {
  if (!reason || reason.length < 12) fail(`runtime-only geometry function "${name}" has no useful allowlist reason`);
}
for (const caseData of fixture.sharedContract.buildGeometryRecord || []) {
  const fields = Object.keys(caseData.expected || {});
  for (const field of geometryRecordFields) {
    if (!fields.includes(field)) fail(`buildGeometryRecord/${caseData.id} expected record is missing "${field}"`);
  }
}
for (const caseData of fixture.sharedContract.compareGroup || []) {
  if (!Object.hasOwn(caseData, 'expected') && !Object.hasOwn(caseData, 'expectedPrefix')) {
    fail(`compareGroup/${caseData.id} needs expected or expectedPrefix`);
  }
}

if (!failed) pass('fixture keys, shared map, and allowlists are in sync');

try {
  execSync('node --test tests/geometry.test.mjs', { cwd: ROOT, stdio: 'inherit' });
  pass('JS geometry contract tests pass');
} catch (error) {
  fail(`JS geometry contract tests failed: ${error.status ?? error.message}`);
}

if (!JS_ONLY) {
  try {
    execSync(`${JSON.stringify(PYTHON)} -m pytest -q tests/test_geometry.py`, { cwd: ROOT, stdio: 'inherit' });
    pass('Python geometry contract tests pass');
  } catch (error) {
    fail(`Python geometry contract tests failed: ${error.status ?? error.message}`);
  }
}

if (failed) process.exit(1);
console.log('All geometry contract checks passed.');
