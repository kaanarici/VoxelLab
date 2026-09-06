import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { setupLockName } from '../scripts/setup_dev.mjs';

const setupScript = fileURLToPath(new URL('../scripts/setup_dev.mjs', import.meta.url));

test('setupLockName selects the narrowest supported dependency lock', () => {
  const cases = [
    [[], 'dev.lock'],
    [['--ai'], 'ai.lock'],
    [['--pipeline'], 'ci.lock'],
    [['--cloud'], 'ci.lock'],
    [['--ai', '--pipeline'], 'ci.lock'],
    [['--ai', '--cloud'], 'ci.lock'],
    [['--pipeline', '--cloud'], 'ci.lock'],
    [['--ai', '--pipeline', '--cloud'], 'ci.lock'],
    [['--rtk'], 'rtk.lock'],
  ];

  for (const [flags, expected] of cases) {
    assert.equal(setupLockName(new Set(flags)), expected, flags.join(' '));
  }
});

test('setupLockName rejects every RTK combination with another dependency extra', () => {
  const extras = ['--ai', '--pipeline', '--cloud'];
  for (let mask = 1; mask < (1 << extras.length); mask += 1) {
    const flags = ['--rtk', ...extras.filter((_, index) => mask & (1 << index))];
    assert.throws(
      () => setupLockName(new Set(flags)),
      /--rtk cannot be combined with --ai, --pipeline, or --cloud/,
      flags.join(' '),
    );
  }
});

test('setup entrypoint rejects incompatible RTK flags before running setup commands', () => {
  const result = spawnSync(process.execPath, [
    setupScript,
    '--rtk',
    '--cloud',
    '--demo',
    'none',
    '--skip-python',
    '--skip-npm',
    '--skip-playwright',
  ], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--rtk cannot be combined with --ai, --pipeline, or --cloud/);
});

test('setup help advertises the dedicated AI lock', () => {
  const result = spawnSync(process.execPath, [setupScript, '--help'], { encoding: 'utf8' });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /--ai\s+requirements\/ai\.lock/);
  assert.match(result.stdout, /--provider claude\|codex/);
  assert.match(result.stdout, /Do not combine --rtk with them/);
  assert.equal(result.stderr, '');
});

test('AI lock contains only the development and Ask dependencies', async () => {
  const lock = await readFile(new URL('../requirements/ai.lock', import.meta.url), 'utf8');

  assert.match(lock, /^numpy==/m);
  assert.match(lock, /^pillow==/m);
  for (const excluded of ['boto3', 'botocore', 'modal', 'nibabel', 'pydicom', 'scipy', 'scikit-learn', 'tifffile']) {
    assert.doesNotMatch(lock, new RegExp(`^${excluded}==`, 'm'));
  }
});
