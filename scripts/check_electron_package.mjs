/* global console, process */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DESKTOP_COMPOUND_INPUT_EXTENSIONS,
  DESKTOP_CONVERTIBLE_INPUT_EXTENSIONS,
  DESKTOP_SUPPORTED_INPUT_EXTENSIONS,
} from '../electron/shared/desktop-contracts.js';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERIC_MAC_DOCUMENT_EXTENSIONS = new Set(['.json', '.zip']);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function loadElectronPackageInputs(rootDir = repoRoot) {
  return {
    packageJson: readJson(path.join(rootDir, 'package.json')),
    forgeConfig: require(path.join(rootDir, 'forge.config.cjs')),
  };
}

export function isIgnoredByPackager(ignore, packagePath) {
  const normalized = packagePath.startsWith('/') ? packagePath : `/${packagePath}`;
  if (typeof ignore === 'function') return Boolean(ignore(normalized));
  const rules = Array.isArray(ignore) ? ignore : [ignore];
  return rules.some((rule) => {
    if (rule instanceof RegExp) return rule.test(normalized);
    if (typeof rule === 'string') return normalized.includes(rule);
    return false;
  });
}

function assertMaker(config, name, platform) {
  const maker = config.makers?.find(candidate => candidate?.name === name);
  assert.ok(maker, `missing Forge maker ${name}`);
  assert.ok(maker.platforms?.includes(platform), `${name} must target ${platform}`);
  return maker;
}

function assertIgnored(ignore, packagePath) {
  assert.ok(isIgnoredByPackager(ignore, packagePath), `${packagePath} must be ignored by Electron packaging`);
}

function assertIncluded(ignore, packagePath) {
  assert.equal(isIgnoredByPackager(ignore, packagePath), false, `${packagePath} must remain packaged`);
}

function assertForgeScripts(packageJson) {
  const scripts = packageJson.scripts ?? {};
  const scriptText = Object.values(scripts).join('\n');
  const forgeCli = 'node node_modules/@electron-forge/cli/dist/electron-forge.js';
  assert.doesNotMatch(scriptText, /\belectron-(?:builder|packager)\b/, 'use Electron Forge, not electron-builder/electron-packager scripts');
  assert.equal(scripts['desktop:package'], `${forgeCli} package`);
  assert.equal(scripts['desktop:make'], `${forgeCli} make`);
  assert.equal(scripts['desktop:make:mac'], `${forgeCli} make --platform=darwin`);
  assert.equal(scripts['desktop:make:win'], `${forgeCli} make --platform=win32`);
  assert.equal(scripts['desktop:smoke:packaged:mac'], 'node scripts/check_packaged_electron_app.mjs out/forge');
  assert.equal(scripts['desktop:smoke:release:mac'], 'node scripts/check_macos_release_artifacts.mjs out/forge/make');

  for (const [name, command] of Object.entries(scripts)) {
    if (!/\belectron-forge(?:\.js)?\b/.test(command)) continue;
    assert.match(
      command,
      /(?:\belectron-forge\b|node node_modules\/@electron-forge\/cli\/dist\/electron-forge\.js)\s+(?:package|make)\b/,
      `${name} must call Electron Forge package or make`,
    );
  }
}

export function checkElectronPackageConfig(rootDir = repoRoot) {
  const { packageJson, forgeConfig } = loadElectronPackageInputs(rootDir);
  const packager = forgeConfig.packagerConfig ?? {};
  const devDependencies = packageJson.devDependencies ?? {};

  assert.equal(packageJson.main, 'electron/main/index.js');
  assert.equal(packager.name, 'VoxelLab');
  assert.equal(packager.executableName, 'VoxelLab');
  assert.equal(packager.icon, path.join(rootDir, 'electron/assets/icon'));
  assert.equal(packager.appBundleId, 'com.voxellab.viewer');
  assert.equal(packager.appCategoryType, 'public.app-category.medical');
  if (!process.env.VOXELLAB_OSX_IDENTITY) {
    const topLevelAppSignOptions = packager.osxSign.optionsForFile('/tmp/VoxelLab.app');
    const helperSignOptions = packager.osxSign.optionsForFile('/tmp/VoxelLab.app/Contents/Frameworks/VoxelLab Helper.app');
    const rendererSignOptions = packager.osxSign.optionsForFile('/tmp/VoxelLab.app/Contents/Frameworks/VoxelLab Helper (Renderer).app');
    const gpuSignOptions = packager.osxSign.optionsForFile('/tmp/VoxelLab.app/Contents/Frameworks/VoxelLab Helper (GPU).app');
    const pluginSignOptions = packager.osxSign.optionsForFile('/tmp/VoxelLab.app/Contents/Frameworks/VoxelLab Helper (Plugin).app');
    assert.equal(topLevelAppSignOptions.entitlements, path.join(rootDir, 'electron/entitlements/darwin-main.plist'));
    assert.equal(helperSignOptions.entitlements, path.join(rootDir, 'electron/entitlements/darwin-helper.plist'));
    assert.equal(rendererSignOptions.entitlements, helperSignOptions.entitlements);
    assert.equal(gpuSignOptions.entitlements, helperSignOptions.entitlements);
    assert.equal(pluginSignOptions, null);
    for (const entitlementPath of [topLevelAppSignOptions.entitlements, helperSignOptions.entitlements]) {
      assert.ok(
        readFileSync(entitlementPath, 'utf8').includes('com.apple.security.cs.disable-library-validation'),
        'ad-hoc macOS app signing must disable library validation so the packaged app can launch before Developer ID signing',
      );
    }
  }
  const docExtensions = packager.extendInfo.CFBundleDocumentTypes
    .flatMap(record => record.CFBundleTypeExtensions || []);
  const expectedMacDocumentExtensions = [
    ...DESKTOP_SUPPORTED_INPUT_EXTENSIONS.filter(extension => !GENERIC_MAC_DOCUMENT_EXTENSIONS.has(extension)),
    ...DESKTOP_COMPOUND_INPUT_EXTENSIONS,
    ...DESKTOP_CONVERTIBLE_INPUT_EXTENSIONS,
  ].map(extension => extension.slice(1));
  for (const ext of expectedMacDocumentExtensions) {
    assert.ok(docExtensions.includes(ext), `macOS document types must include ${ext}`);
  }
  assert.equal(packager.prune, false, 'Electron packages must use the explicit asset allowlist instead of npm prune');
  assert.equal(packager.win32metadata?.ProductName, 'VoxelLab');

  assert.ok(devDependencies['@electron-forge/cli'], 'missing @electron-forge/cli devDependency');
  assert.ok(devDependencies['@electron-forge/maker-zip'], 'missing macOS zip maker devDependency');
  assert.ok(devDependencies['@electron-forge/maker-dmg'], 'missing macOS dmg maker devDependency');
  assert.ok(devDependencies['@electron-forge/maker-squirrel'], 'missing Windows squirrel maker devDependency');
  assert.ok(devDependencies['@electron-forge/plugin-auto-unpack-natives'], 'missing native unpack plugin devDependency');

  assert.equal(typeof packager.asar, 'object');
  assert.match(packager.asar.unpack, /wasm/);
  assert.match(packager.asar.unpack, /node/);
  assert.ok(forgeConfig.plugins?.some(plugin => plugin?.name === '@electron-forge/plugin-auto-unpack-natives'), 'missing auto unpack natives plugin');

  assertMaker(forgeConfig, '@electron-forge/maker-zip', 'darwin');
  const dmg = assertMaker(forgeConfig, '@electron-forge/maker-dmg', 'darwin');
  const squirrel = assertMaker(forgeConfig, '@electron-forge/maker-squirrel', 'win32');
  assert.equal(dmg.config?.name, 'VoxelLab');
  assert.equal(dmg.config?.icon, path.join(rootDir, 'electron/assets/icon.icns'));
  assert.equal(squirrel.config?.title, 'VoxelLab');
  assert.match(squirrel.config?.iconUrl || '', /electron\/assets\/icon\.ico$/);
  assert.equal(squirrel.config?.setupIcon, path.join(rootDir, 'electron/assets/icon.ico'));

  assertForgeScripts(packageJson);

  const ignore = packager.ignore;
  assert.equal(typeof ignore, 'function', 'packagerConfig.ignore must be an explicit package allowlist');
  for (const packagePath of [
    '/.github/workflows/check.yml',
    '/.gitignore',
    '/.node-version',
    '/.git/config',
    '/.claude/settings.local.json',
    '/.codex/session.json',
    '/.codex-simplify-active.diff',
    '/.flow',
    '/.flow/root.yaml',
    '/.flow.yaml',
    '/.playwright-mcp/state.json',
    '/electron/.flow.yaml',
    '/js/.flow.yaml',
    '/AGENTS.md',
    '/CLAUDE.md',
    '/FLOW_INDEX.md',
    '/MISSION.md',
    '/ARCHITECTURE.md',
    '/README.md',
    '/python/ai_runtime.py',
    '/config.local.json',
    '/demo_packs/catalog.json',
    '/docs/plans/plan.md',
    '/eslint.config.js',
    '/forge.config.cjs',
    '/node_modules/.bin/electron-forge',
    '/node_modules/@electron-forge/cli/package.json',
    '/node_modules/@eslint/js/package.json',
    '/node_modules/@playwright/test/package.json',
    '/node_modules/dcmjs/.github/workflows/ci.yml',
    '/node_modules/dcmjs/test/sample-dicom.json',
    '/node_modules/electron/package.json',
    '/node_modules/eslint/package.json',
    '/node_modules/globals/package.json',
    '/node_modules/dcmjs/build/dcmjs.es.js.map',
    '/node_modules/onnxruntime-web/dist/cjs/ort.min.js',
    '/node_modules/onnxruntime-web/docs/api/index.md',
    '/node_modules/pako/dist/pako.js',
    '/node_modules/three/build/three.cjs',
    '/node_modules/three/examples/jsm/loaders/OBJLoader.js',
    '/scripts/check_electron_package.mjs',
    '/scripts/check_desktop_make_outputs.mjs',
    '/scripts/check_release_workflow.mjs',
    '/tests/viewer.test.mjs',
    '/test-results/report.json',
    '/lab-readiness-report.json',
    '/.pytest_cache/CACHEDIR.TAG',
    '/data/manifest.json',
    '/data/demo/0000.png',
    '/data_compressed/example.bin',
    '/synthseg_repo/README.md',
    '/public-export/manifest.json',
    '/public-release-workspace/package.json',
    '/out/forge/package/VoxelLab.app',
  ]) {
    assertIgnored(ignore, packagePath);
  }

  for (const packagePath of [
    '/index.html',
    '/package.json',
    '/viewer.js',
    '/sw.js',
    '/config.json',
    '/css/app.css',
    '/js/bootstrap.js',
    '/templates/viewer-shell.html',
    '/electron/main/index.js',
    '/electron/assets/icon.png',
    '/electron/assets/icon.icns',
    '/electron/assets/icon.ico',
    '/electron/entitlements/darwin-helper.plist',
    '/electron/entitlements/darwin-main.plist',
    '/electron/preload/index.cjs',
    '/electron/shared/desktop-contracts.js',
    '/node_modules/onnxruntime-web/dist/ort-wasm.wasm',
    '/node_modules/@cornerstonejs/codec-openjpeg/dist/openjpegwasm.wasm',
    '/node_modules/@cornerstonejs/codec-charls/dist/charlswasm.wasm',
    '/node_modules/dcmjs/build/dcmjs.es.js',
    '/node_modules/fzstd/esm/index.mjs',
    '/node_modules/pako/dist/pako.esm.mjs',
    '/node_modules/three/build/three.module.js',
    '/node_modules/three/examples/jsm/controls/TrackballControls.js',
  ]) {
    assertIncluded(ignore, packagePath);
  }

  return {
    appBundleId: packager.appBundleId,
    makers: forgeConfig.makers.map(maker => maker.name),
    productName: packager.name,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkElectronPackageConfig();
  console.log(`OK: Electron Forge packaging config for ${result.productName} (${result.appBundleId})`);
}
