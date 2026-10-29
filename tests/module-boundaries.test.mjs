import assert from 'node:assert/strict';
import { glob } from 'node:fs/promises';
import { test } from 'node:test';
import { moduleExists, repoPath, resolvedDependencies } from './helpers/node/module-imports.mjs';

const RENDER_AND_SYNC_MODULES = [
  'js/sync.js',
  'js/metadata.js',
  'js/volume/volume-3d.js',
  'js/volume/volume-voxels-ensure.js',
  'js/volume/volume-label-overlay.js',
  'js/series/compare.js',
];

const BOUNDARIES = [
  {
    module: 'js/overlay/overlay-stack.js',
    role: 'overlay stack loading stays a state and image-stack concern',
    forbidden: ['js/sync.js', 'js/metadata.js', 'js/volume/volume-3d.js'],
  },
  {
    module: 'js/overlay/overlay-toggle.js',
    role: 'overlay toggling owns no 3D voxel refresh, sync fan-out, or compare reload',
    forbidden: [
      'js/sync.js',
      'js/series/compare.js',
      'js/volume/volume-3d.js',
      'js/volume/volume-voxels-ensure.js',
      'js/volume/volume-label-overlay.js',
    ],
  },
  {
    module: 'js/fusion-loader.js',
    role: 'fusion loading stays out of the viewer sync fan-out',
    forbidden: ['js/sync.js'],
  },
];

test('forbidden dependency targets still exist so the boundary table cannot go stale', () => {
  for (const path of RENDER_AND_SYNC_MODULES) {
    assert.equal(moduleExists(path), true, `${path} was moved or removed; update the boundary table`);
  }
  for (const { module, forbidden } of BOUNDARIES) {
    assert.equal(moduleExists(module), true, `${module} is missing`);
    for (const path of forbidden) {
      assert.ok(RENDER_AND_SYNC_MODULES.includes(path), `${path} must be listed as a tracked boundary target`);
    }
  }
});

for (const { module, role, forbidden } of BOUNDARIES) {
  test(`${module}: ${role}`, () => {
    const { all } = resolvedDependencies(module);
    for (const path of forbidden) {
      assert.equal(
        all.includes(path),
        false,
        `${module} must not import ${path} (static or dynamic); found ${all.join(', ')}`,
      );
    }
  });
}

test('no shipped viewer module imports the isolated host write adapter', async () => {
  assert.equal(moduleExists('js/runtime/isolated-host.js'), true, 'the forbidden write adapter was moved; update this scan');
  assert.equal(moduleExists('js/runtime/viewer-runtime.js'), true, 'the allowed host-writes seam was moved; update this scan');
  const offenders = [];
  const users = [];
  for await (const entry of glob('js/**/*.js', { cwd: repoPath('.') })) {
    const module = entry.replaceAll('\\', '/');
    const { all } = resolvedDependencies(module);
    if (module === 'js/runtime/isolated-host.js') continue;
    if (all.includes('js/runtime/isolated-host.js')) offenders.push(module);
    if (all.includes('js/runtime/viewer-runtime.js')) users.push(module);
  }
  assert.deepEqual(
    offenders,
    [],
    'live modules must take host writes through hostWritesFor, not import writeHost* directly',
  );
  assert.ok(users.length > 0, 'expected live modules to route host writes through viewer-runtime');
});

test('resolvedDependencies reports the real static and dynamic edges it guards', () => {
  const overlayStack = resolvedDependencies('js/overlay/overlay-stack.js');
  assert.ok(overlayStack.static.includes('js/core/state.js'));
  assert.ok(overlayStack.static.includes('js/series/series-image-stack.js'));

  const localImport = resolvedDependencies('js/intake/run-local-import.js');
  assert.ok(localImport.dynamic.includes('js/dicom/dicom-import.js'));
  assert.equal(localImport.static.includes('js/dicom/dicom-import.js'), false);
});
