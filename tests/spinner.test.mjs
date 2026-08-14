import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const spinner = { hidden: true };
globalThis.document = {
  getElementById(id) {
    return id === 'viewer-spinner' ? spinner : null;
  },
};

const {
  clearSpinnerPendingPrefix,
  setSpinnerPending,
  __pendingSpinnerKeysForTests,
  __resetSpinnerForTests,
} = await import('../js/spinner.js');

afterEach(() => {
  __resetSpinnerForTests();
});

test('spinner pending keys are independently clearable by request', () => {
  setSpinnerPending('series-load:1', true);
  setSpinnerPending('series-load:2', true);

  setSpinnerPending('series-load:1', false);

  assert.deepEqual(__pendingSpinnerKeysForTests(), ['series-load:2']);
  setSpinnerPending('series-load:2', false);
  assert.deepEqual(__pendingSpinnerKeysForTests(), []);
});

test('spinner prefix clear removes stale request keys without touching other work', () => {
  setSpinnerPending('series-load:1', true);
  setSpinnerPending('series-load:2', true);
  setSpinnerPending('three-surface', true);

  clearSpinnerPendingPrefix('series-load');

  assert.deepEqual(__pendingSpinnerKeysForTests(), ['three-surface']);
});

test('spinner reset clears hidden state and pending timers for tests', () => {
  setSpinnerPending('three-surface', true);
  assert.deepEqual(__pendingSpinnerKeysForTests(), ['three-surface']);

  __resetSpinnerForTests();

  assert.equal(spinner.hidden, true);
  assert.deepEqual(__pendingSpinnerKeysForTests(), []);
});
