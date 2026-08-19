#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpOverlayContract } from '../js/core/viewer-session-shape.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = process.env.PYTHON
  || (existsSync(join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'))
    ? join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    : (process.platform === 'win32' ? 'python' : 'python3'));
const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'overlay-contract.json'), 'utf8'));
const jsDump = dumpOverlayContract();
const pyDump = JSON.parse(execFileSync(
  PYTHON,
  ['-c', 'import json; from overlay_contract import dump_overlay_contract; print(json.dumps(dump_overlay_contract()))'],
  { encoding: 'utf8', cwd: ROOT, env: { ...process.env, PYTHONPATH: join(ROOT, 'python') } },
));

function sortedRow(row) {
  return Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));
}

function canonicalOverlayContract(value) {
  const overlays = [...(value?.overlays || [])]
    .map(sortedRow)
    .sort((a, b) => String(a.loaderDir).localeCompare(String(b.loaderDir)));
  return { overlays };
}

let failed = false;
const dumps = [
  ['js/core/viewer-session-shape.js', jsDump],
  ['python/overlay_contract.py', pyDump],
];
const expected = JSON.stringify(canonicalOverlayContract(schema));
for (const [label, dump] of dumps) {
  const actual = JSON.stringify(canonicalOverlayContract(dump));
  if (expected !== actual) {
    console.error(`FAIL: ${label} drifted from schemas/overlay-contract.json`);
    console.error(`  schema: ${expected}`);
    console.error(`  dump:   ${actual}`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log('OK: JS and Python overlay contract dumps match schemas/overlay-contract.json');
