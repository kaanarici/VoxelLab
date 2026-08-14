import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertReviewedNpmAudit,
  REVIEWED_BUILD_ADVISORIES,
} from '../scripts/check_npm_release_audit.mjs';

function auditPayload(urls, { critical = 0 } = {}) {
  return {
    metadata: { vulnerabilities: { total: urls.length, critical } },
    vulnerabilities: {
      dependency: {
        via: urls.map(url => ({ url })),
      },
    },
  };
}

test('release npm audit accepts only the reviewed build-only advisories', () => {
  const urls = Object.keys(REVIEWED_BUILD_ADVISORIES);
  assert.deepEqual(assertReviewedNpmAudit(auditPayload(urls)), {
    reviewedAdvisories: urls.sort(),
    vulnerablePackages: 3,
  });
});

test('release npm audit rejects a newly introduced advisory', () => {
  assert.throws(
    () => assertReviewedNpmAudit(auditPayload(['https://github.com/advisories/GHSA-new-risk'])),
    /unreviewed npm advisories/,
  );
});

test('release npm audit rejects critical findings even if reviewed', () => {
  assert.throws(
    () => assertReviewedNpmAudit(auditPayload([Object.keys(REVIEWED_BUILD_ADVISORIES)[0]], { critical: 1 })),
    /no critical vulnerabilities/,
  );
});
