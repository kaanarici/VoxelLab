/* global console */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workflow = readFileSync(fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url)), 'utf8');
const checkWorkflow = readFileSync(fileURLToPath(new URL('../.github/workflows/check.yml', import.meta.url)), 'utf8');

function requireText(source, text, message) {
  assert.ok(source.includes(text), message);
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

requireText(workflow, 'workflow_dispatch:\n    inputs:\n      tag:', 'release workflow must require an explicit manual tag');
assert.equal(workflow.includes("tags:\n      - 'v*'"), false, 'pushing a tag must not publish a release');
requireText(workflow, 'permissions:\n  contents: read', 'release jobs must default to read-only access');
requireText(workflow, 'concurrency:\n  group: release-${{ inputs.tag }}\n  cancel-in-progress: false', 'same-tag release runs must serialize');
requireText(workflow, 'RELEASE_TAG: ${{ inputs.tag }}', 'release jobs must share the requested tag');
requireText(workflow, 'verify-canonical:\n    uses: ./.github/workflows/check.yml', 'release must reuse canonical checks');
requireText(checkWorkflow, 'npm run check:supply-chain', 'canonical checks must include the supply-chain gate');
requireText(workflow, 'run: test "$GITHUB_REF" = refs/heads/main', 'release must run from protected main');
requireText(workflow, 'node scripts/check_release_version.mjs "$RELEASE_TAG"', 'requested tag must match package metadata');
assert.equal(workflow.match(/node scripts\/check_release_identity\.mjs/g)?.length, 2, 'release identity must be checked before builds and publication');

requireText(workflow, 'name: voxellab-lab-readiness', 'lab evidence must remain available as a CI artifact');
requireText(workflow, 'retention-days: 14', 'internal lab evidence must expire from Actions');
requireText(workflow, 'path: lab-readiness-report.json', 'lab evidence upload must contain the report');
assert.equal(workflow.includes('name: voxellab-lab-readiness\n          path: release-inputs'), false, 'lab evidence must not enter public release inputs');

requireText(workflow, 'npm run desktop:make:mac', 'release must build the macOS installer');
requireText(workflow, 'npm run desktop:smoke:release:mac', 'release must mount and launch the DMG');
requireText(workflow, "grep -q 'Signature=adhoc'", 'macOS release must verify its intentional ad-hoc signature');
requireText(workflow, 'path: out/forge/make/**/*.dmg', 'macOS artifact upload must contain only the DMG glob');
assert.equal(workflow.includes('out/forge/make/**/*.zip'), false, 'release must not build or upload a redundant macOS ZIP');

requireText(workflow, 'npm run desktop:make:win -- --arch=x64', 'release must build the supported Windows x64 installer');
requireText(workflow, 'npm run desktop:smoke:packaged:win', 'release must launch the packaged Windows app');
requireText(workflow, "Where-Object Status -ne 'NotSigned'", 'Windows release must verify its intentional unsigned state');
requireText(workflow, 'path: out/forge/make/**/*Setup*.exe', 'Windows artifact upload must contain only the installer EXE');
assert.equal(workflow.includes('out/forge/make/**/*.nupkg'), false, 'release must not upload unused updater packages');
assert.equal(workflow.includes('out/forge/make/**/RELEASES'), false, 'release must not upload unused updater metadata');

for (const forbidden of [
  'check_release_signing_env',
  'VOXELLAB_ALLOW_UNSIGNED_RELEASE',
  'VOXELLAB_MACOS_CERTIFICATE',
  'VOXELLAB_OSX_IDENTITY',
  'VOXELLAB_APPLE_API',
  'VOXELLAB_WINDOWS_CERTIFICATE',
  'spctl --assess',
]) {
  assert.equal(workflow.includes(forbidden), false, `unsigned-only release workflow must not retain signing path: ${forbidden}`);
}

requireText(workflow, 'name: voxellab-macos\n          path: release-inputs', 'publication must download the macOS installer input');
requireText(workflow, 'name: voxellab-windows\n          path: release-inputs', 'publication must download the Windows installer input');
requireText(workflow, 'node scripts/prepare_public_release_assets.mjs release-inputs public-assets "$RELEASE_TAG"', 'publication must create versioned public filenames');
requireText(workflow, 'node scripts/write_release_checksums.mjs public-assets public-assets/SHA256SUMS', 'checksums must cover only public installers');
requireText(workflow, 'node scripts/check_release_assets.mjs public-assets "$RELEASE_TAG"', 'exact public assets must be checked before release');
requireText(workflow, 'subject-checksums: public-assets/SHA256SUMS', 'provenance must cover the public installers');
requireText(workflow, 'node scripts/extract_release_notes.mjs CHANGELOG.md release-notes.md', 'release must use human-authored notes');
requireText(workflow, 'tag_name: ${{ inputs.tag }}', 'publication must create exactly the approved tag');
requireText(workflow, 'target_commitish: ${{ github.sha }}', 'tag must bind to the verified main commit');
requireText(workflow, 'files: public-assets/*', 'GitHub Release must attach only the curated public directory');
assert.equal(workflow.includes('files: release-assets/**/*'), false, 'GitHub Release must not publish internal CI staging');
requireText(workflow, 'publish:\n    runs-on: ubuntu-latest\n    environment:\n      name: release', 'publication must require release-environment approval');

console.log('OK: release workflow is manual, unsigned-only, approval-gated, and publishes exactly two installers plus checksums');
