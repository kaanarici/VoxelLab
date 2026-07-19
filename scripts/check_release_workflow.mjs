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
requireText('permissions:\n  contents: read', 'release verification jobs must default to read-only repository access');
requireText('publish:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write', 'only the release publication job may write repository contents');
requireText('FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"', 'release workflow must opt JavaScript actions into Node 24');
requireWorkflowText(checkWorkflow, 'FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"', 'check workflow must opt JavaScript actions into Node 24');
requireWorkflowText(checkWorkflow, 'workflow_call:', 'canonical checks must be reusable from the release workflow');
requireWorkflowText(checkWorkflow, 'npm audit --audit-level=moderate', 'canonical checks must reject vulnerable dependency graphs');
requireText('verify-canonical:\n    uses: ./.github/workflows/check.yml', 'release workflow must run the canonical check workflow');
requireText('verify-lab-readiness:\n    runs-on: ubuntu-latest', 'release workflow must verify lab readiness before building release artifacts');
requireText('needs:\n      - verify-canonical', 'release lab readiness must wait for the canonical checks');
requireText('python -m pip install -e ".[dev,pipeline,microscopy,ai,cloud]"', 'release lab readiness must install every Python dependency group used by the full proof gate');
requireText('node scripts/check_release_version.mjs "$GITHUB_REF_NAME"', 'release workflow must reject tags that do not match package metadata');
requireText('npx playwright install --with-deps chromium', 'release lab readiness must install the browser and system dependencies used by Playwright proof');
requireText('xvfb-run -a env PYTHON=python node scripts/check_lab_readiness.mjs --skip-validation-matrix --skip-public-export --report lab-readiness-report.json', 'release workflow must run every public proof lane and omit only private validation/export checks');
requireText('name: voxellab-lab-readiness', 'release workflow must upload the lab-readiness evidence bundle');
requireText('path: lab-readiness-report.json', 'release workflow must upload the lab-readiness report');
requireText('build-macos:\n    runs-on: macos-latest', 'release workflow must build macOS on macos-latest');
requireText('build-windows:\n    runs-on: windows-latest', 'release workflow must build Windows on windows-latest');
requireText('needs:\n      - verify-lab-readiness', 'desktop release builds must wait for lab-readiness proof');
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
requireText('publish:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n    needs:\n      - verify-lab-readiness\n      - build-macos\n      - build-windows', 'release publication must wait for lab readiness and both desktop build jobs');
requireText('path: release-assets', 'release workflow must collect artifacts into the release-assets directory');
requireText('find release-assets -maxdepth 5 -type f -print', 'release workflow must print release assets before publication');
requireText('node scripts/check_release_assets.mjs release-assets', 'release workflow must validate the collected release assets before publication');
requireText('node scripts/extract_release_notes.mjs CHANGELOG.md release-notes.md', 'release workflow must extract human-authored notes for the current package version');
requireText('softprops/action-gh-release@v2', 'release workflow must publish a GitHub release');
requireText('body_path: release-notes.md', 'release publication must use the human-authored changelog section');
assert.equal(workflow.includes('generate_release_notes: true'), false, 'release publication must not rely on generated compare notes across rewritten public history');
requireText('fail_on_unmatched_files: true', 'release publication must fail if artifact globs do not match');
requireText('files: release-assets/**/*', 'release publication must attach collected desktop artifacts');

console.log('OK: release workflow contract verified — its YAML requires canonical checks, full lab readiness, desktop builds, release asset validation, and downloadable artifacts (static inspection; the steps run in CI, not here)');
