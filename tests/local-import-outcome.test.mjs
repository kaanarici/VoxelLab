import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localImportOutcomeNotice } from '../js/projects/microscopy-sidecars.js';

test('localImportOutcomeNotice joins import parts and marks skips as warnings', () => {
  assert.equal(localImportOutcomeNotice([]), null);
  assert.deepEqual(
    localImportOutcomeNotice(['Imported 1 SEG overlay onto the referenced source series.']),
    {
      message: 'Imported 1 SEG overlay onto the referenced source series.',
      kind: 'info',
    },
  );
  assert.deepEqual(
    localImportOutcomeNotice([
      'Imported 1 ImageJ ROI onto the active microscopy series.',
      'Skipped 1 ImageJ ROI entry: missing.roi (did not fit active series).',
    ]),
    {
      message: 'Imported 1 ImageJ ROI onto the active microscopy series. Skipped 1 ImageJ ROI entry: missing.roi (did not fit active series).',
      kind: 'warning',
    },
  );
  assert.deepEqual(
    localImportOutcomeNotice(['cells.czi: converter used a fallback reader']),
    {
      message: 'cells.czi: converter used a fallback reader',
      kind: 'warning',
    },
  );
});
