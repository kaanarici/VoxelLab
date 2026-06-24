/* global console, URL */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url));
const workflow = readFileSync(workflowPath, 'utf8');
const checkWorkflowPath = fileURLToPath(new URL('../.github/workflows/check.yml', import.meta.url));
const checkWorkflow = readFileSync(checkWorkflowPath, 'utf8');

function requireWorkflowText(source, text, message) {
  assert.ok(source.includes(text), message);
}

function requireText(text, message) {
  requireWorkflowText(workflow, text, message);
}

requireText("tags:\n      - 'v*'", 'release workflow must run for v* tags');
requireText('permissions:\n  contents: write', 'release workflow must be allowed to publish GitHub releases');
requireText('FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"', 'release workflow must opt JavaScript actions into Node 24');
requireWorkflowText(checkWorkflow, 'FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"', 'check workflow must opt JavaScript actions into Node 24');
// Code-health checking lives in the Check workflow (on push). The release builds
// + smoke-tests the packaged desktop app, so it isn't gated on the full check
// suite — it ships a built, smoke-verified artifact.
requireText('build-macos:\n    runs-on: macos-latest', 'release workflow must build macOS on macos-latest');
requireText('build-windows:\n    runs-on: windows-latest', 'release workflow must build Windows on windows-latest');
requireText('npm run desktop:make:mac', 'release workflow must build macOS desktop artifacts');
requireText('node scripts/check_desktop_make_outputs.mjs out/forge/make darwin', 'release workflow must validate macOS desktop make outputs before upload');
requireText('npm run desktop:smoke:packaged:mac', 'release workflow must launch the packaged macOS app before upload');
requireText('npm run desktop:smoke:release:mac', 'release workflow must mount/extract macOS release artifacts before upload');
requireText('npm run desktop:make:win', 'release workflow must build Windows desktop artifacts');
requireText('node scripts/check_desktop_make_outputs.mjs out/forge/make win32', 'release workflow must validate Windows desktop make outputs before upload');
requireText('uses: actions/upload-artifact@v4', 'release workflow must upload desktop build artifacts');
requireText('name: voxellab-macos', 'release workflow must name the macOS artifact bundle');
requireText('name: voxellab-windows', 'release workflow must name the Windows artifact bundle');
requireText('if-no-files-found: error', 'release artifact uploads must fail when no desktop assets are produced');
requireText('out/forge/make/**/*.dmg', 'macOS release artifacts must include DMG installers');
requireText('out/forge/make/**/*.zip', 'macOS release artifacts must include ZIP archives');
requireText('out/forge/make/**/*.exe', 'Windows release artifacts must include setup EXEs');
requireText('out/forge/make/**/*.nupkg', 'Windows release artifacts must include NuGet packages');
requireText('out/forge/make/**/RELEASES', 'Windows release artifacts must include Squirrel RELEASES metadata');
requireText('uses: actions/download-artifact@v4', 'release workflow must gather build artifacts before publishing');
requireText('publish:\n    runs-on: ubuntu-latest\n    needs:\n      - build-macos\n      - build-windows', 'release publication must wait for both desktop build jobs');
requireText('path: release-assets', 'release workflow must collect artifacts into the release-assets directory');
requireText('find release-assets -maxdepth 5 -type f -print', 'release workflow must print release assets before publication');
requireText('softprops/action-gh-release@v2', 'release workflow must publish a GitHub release');
requireText('fail_on_unmatched_files: true', 'release publication must fail if artifact globs do not match');
requireText('files: release-assets/**/*', 'release publication must attach collected desktop artifacts');

console.log('OK: release workflow contract verified — its YAML requires checks, desktop builds, a packaged macOS launch step, installable macOS artifacts, and downloadable artifacts (static inspection; the steps run in CI, not here)');
