import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { EnvelopeValidationError, normalizeAskResult, normalizeConsultResult } from '../js/ask-envelopes.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/contract/ask-envelopes.json', import.meta.url), 'utf8'));

const normalizers = {
  'ask-result': normalizeAskResult,
  'consult-result': normalizeConsultResult,
};

test('ask/consult envelope fixture valid cases match JS normalizers', () => {
  for (const item of fixture.valid) {
    assert.deepEqual(normalizers[item.kind](item.input), item.expected, item.id);
  }
});

test('ask/consult envelope fixture invalid cases have named JS reasons', () => {
  for (const item of fixture.invalid) {
    assert.throws(
      () => normalizers[item.kind](item.input),
      (error) => {
        assert.equal(error instanceof EnvelopeValidationError, true, item.id);
        assert.equal(error.envelope, item.kind, item.id);
        assert.equal(error.reason, item.reason, item.id);
        return true;
      },
      item.id,
    );
  }
});
