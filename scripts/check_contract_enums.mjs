#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpContractEnums } from '../js/core/contracts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON = process.env.PYTHON
  || (existsSync(join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'))
    ? join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    : (process.platform === 'win32' ? 'python' : 'python3'));
const contractsPath = join(ROOT, 'js', 'core', 'contracts.js');
const contractsSource = readFileSync(contractsPath, 'utf8');
if (/with\s*\{\s*type:\s*['"]json['"]\s*\}/.test(contractsSource)) {
  console.error('FAIL: js/core/contracts.js must not JSON-import schemas over HTTP');
  process.exit(1);
}
const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'enums.json'), 'utf8'));
const jsDump = dumpContractEnums();
const pyDump = JSON.parse(execFileSync(
  PYTHON,
  ['-c', 'import json; from contracts import dump_contract_enums; print(json.dumps(dump_contract_enums()))'],
  { encoding: 'utf8', cwd: ROOT, env: { ...process.env, PYTHONPATH: join(ROOT, 'python') } },
));

function sorted(value) {
  if (Array.isArray(value)) return [...value].sort((a, b) => String(a).localeCompare(String(b)));
  if (value == null) return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

let failed = false;
const dumps = [
  ['js/core/contracts.js', jsDump],
  ['python/contracts.py', pyDump],
];
const schemaKeys = Object.keys(schema).sort();
for (const [label, dump] of dumps) {
  const dumpKeys = Object.keys(dump).sort();
  if (JSON.stringify(schemaKeys) !== JSON.stringify(dumpKeys)) {
    console.error(`FAIL: ${label} key set drifted from schemas/enums.json`);
    console.error(`  schema: ${JSON.stringify(schemaKeys)}`);
    console.error(`  dump:   ${JSON.stringify(dumpKeys)}`);
    failed = true;
  }
  for (const key of schemaKeys) {
    const expected = JSON.stringify(sorted(schema[key]));
    const actual = JSON.stringify(sorted(dump[key]));
    if (expected !== actual) {
      console.error(`FAIL: ${label} ${key} drifted from schemas/enums.json`);
      console.error(`  schema: ${expected}`);
      console.error(`  dump:   ${actual}`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log('OK: JS and Python contract enums match schemas/enums.json');
