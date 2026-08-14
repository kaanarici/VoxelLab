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

function assertActionsPinned(source, label) {
  for (const match of source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)$/gm)) {
    const target = match[1];
    if (target.startsWith('./')) continue;
    const separator = target.lastIndexOf('@');
    assert.ok(separator > 0, `${label} action must include an immutable ref: ${target}`);
    assert.match(target.slice(separator + 1), /^[0-9a-f]{40}$/, `${label} action must use a full commit SHA: ${target}`);
  }
}

assertActionsPinned(checkWorkflow, 'check workflow');
assertActionsPinned(workflow, 'release workflow');

requireText("tags:\n      - 'v*'", 'release workflow must run for v* tags');
requireText('permissions:\n  contents: read', 'release verification jobs must default to read-only repository access');
requireText('concurrency:\n  group: release-${{ github.ref }}\n  cancel-in-progress: false', 'release runs for the same tag must serialize so reused tags cannot race publication');
requireText('publish:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n      id-token: write\n      attestations: write', 'only the release publication job may write repository contents and attestations');
requireText('FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"', 'release workflow must opt JavaScript actions into Node 24');
requireWorkflowText(checkWorkflow, 'FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"', 'check workflow must opt JavaScript actions into Node 24');
requireWorkflowText(checkWorkflow, 'workflow_call:', 'canonical checks must be reusable from the release workflow');
requireWorkflowText(checkWorkflow, 'npm run check:supply-chain', 'canonical checks must reject production advisories and unreviewed build-graph advisories');
requireWorkflowText(checkWorkflow, 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262', 'canonical checks must pin checkout to a reviewed commit');
requireWorkflowText(checkWorkflow, 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020', 'canonical checks must pin Node setup to a reviewed commit');
requireWorkflowText(checkWorkflow, 'actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065', 'canonical checks must pin Python setup to a reviewed commit');
requireText('verify-canonical:\n    uses: ./.github/workflows/check.yml', 'release workflow must run the canonical check workflow');
requireText('verify-lab-readiness:\n    runs-on: ubuntu-latest', 'release workflow must verify lab readiness before building release artifacts');
requireText('needs:\n      - verify-canonical', 'release lab readiness must wait for the canonical checks');
requireWorkflowText(checkWorkflow, 'python -m pip install --require-hashes -r requirements/ci.lock', 'canonical checks must install the reviewed hash-locked Python graph');
requireText('python -m pip install --require-hashes -r requirements/ci.lock', 'release lab readiness must install the reviewed hash-locked Python graph');
requireText('node scripts/check_release_version.mjs "$GITHUB_REF_NAME"', 'release workflow must reject tags that do not match package metadata');
requireText('Reject an already-published release tag', 'release workflow must reject mutable/reused release identities');
requireText('Release $GITHUB_REF_NAME already exists; release tags and assets are immutable.', 'release workflow must fail closed when the tag already has a release');
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
requireText('node scripts/check_release_signing_env.mjs darwin', 'macOS release builds must reject partial signing credentials and require explicit unsigned mode');
requireText('codesign --verify --deep --strict --verbose=2', 'macOS release builds must verify the packaged application signature');
requireText('spctl --assess --type execute --verbose=4', 'signed macOS release builds must pass Gatekeeper assessment');
requireText('npm run desktop:make:win', 'release workflow must build Windows desktop artifacts');
requireText('node scripts/check_desktop_make_outputs.mjs out/forge/make win32', 'release workflow must validate Windows desktop make outputs before upload');
requireText('npm run desktop:smoke:packaged:win', 'release workflow must launch the packaged Windows app before upload');
requireText('node scripts/check_release_signing_env.mjs win32', 'Windows release builds must reject partial signing credentials and require explicit unsigned mode');
requireText('Get-AuthenticodeSignature', 'signed Windows release builds must verify Authenticode signatures');
requireText('uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02', 'release workflow must pin artifact uploads to a reviewed commit');
requireText('name: voxellab-macos', 'release workflow must name the macOS artifact bundle');
requireText('name: voxellab-windows', 'release workflow must name the Windows artifact bundle');
requireText('if-no-files-found: error', 'release artifact uploads must fail when no desktop assets are produced');
requireText('out/forge/make/**/*.dmg', 'macOS release artifacts must include DMG installers');
requireText('out/forge/make/**/*.zip', 'macOS release artifacts must include ZIP archives');
requireText('out/forge/make/**/*.exe', 'Windows release artifacts must include setup EXEs');
requireText('out/forge/make/**/*.nupkg', 'Windows release artifacts must include NuGet packages');
requireText('out/forge/make/**/RELEASES', 'Windows release artifacts must include Squirrel RELEASES metadata');
requireText('uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093', 'release workflow must pin artifact downloads to a reviewed commit');
requireText('publish:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n      id-token: write\n      attestations: write\n    needs:\n      - verify-lab-readiness\n      - build-macos\n      - build-windows', 'release publication must wait for lab readiness and both desktop build jobs');
requireText('path: release-assets', 'release workflow must collect artifacts into the release-assets directory');
requireText('find release-assets -maxdepth 5 -type f -print', 'release workflow must print release assets before publication');
requireText('node scripts/check_release_assets.mjs release-assets', 'release workflow must validate the collected release assets before publication');
requireText('node scripts/write_release_checksums.mjs release-assets release-assets/SHA256SUMS', 'release workflow must publish end-user-verifiable SHA-256 checksums');
requireText('actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8', 'release workflow must pin GitHub build provenance attestation to a reviewed commit');
requireText('subject-checksums: release-assets/SHA256SUMS', 'release provenance must cover the checksummed release subjects');
requireText('node scripts/extract_release_notes.mjs CHANGELOG.md release-notes.md', 'release workflow must extract human-authored notes for the current package version');
requireText('softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65', 'release workflow must pin release publication to a reviewed commit');
requireText('body_path: release-notes.md', 'release publication must use the human-authored changelog section');
assert.equal(workflow.includes('generate_release_notes: true'), false, 'release publication must not rely on generated compare notes across rewritten public history');
requireText('fail_on_unmatched_files: true', 'release publication must fail if artifact globs do not match');
requireText('files: release-assets/**/*', 'release publication must attach collected desktop artifacts');

console.log('OK: release workflow contract verified — its YAML requires canonical checks, full lab readiness, desktop builds, release asset validation, and downloadable artifacts (static inspection; the steps run in CI, not here)');
