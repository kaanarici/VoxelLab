import assert from 'node:assert/strict';
import { test } from 'node:test';

const { handleLocalImport } = await import('../js/projects/study-upload-modal.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function statusElement() {
  return {
    className: '',
    textContent: '',
    innerHTML: '',
    removeAttribute() {},
  };
}

function workflowSidecar({ name = 'workflow.json', textPromise = null, onText = () => {} } = {}) {
  return {
    name,
    async text() {
      onText();
      return textPromise ? await textPromise : JSON.stringify({ schema: 'voxellab.microscopyWorkflowRecipe.v1' });
    },
  };
}

test('handleLocalImport is single-flight and resets after the in-flight import settles', async () => {
  const status = statusElement();
  const firstText = deferred();
  const firstTextStarted = deferred();
  let firstTextCalls = 0;
  const firstSidecar = workflowSidecar({
    textPromise: firstText.promise,
    onText() {
      firstTextCalls += 1;
      firstTextStarted.resolve();
    },
  });
  const firstBusyEvents = [];
  const firstImport = handleLocalImport(
    [firstSidecar],
    status,
    null,
    async () => {},
    value => firstBusyEvents.push(value),
  );

  await firstTextStarted.promise;
  assert.deepEqual(firstBusyEvents, [true]);

  let secondTextCalls = 0;
  await handleLocalImport(
    [workflowSidecar({ name: 'second-workflow.json', onText: () => { secondTextCalls += 1; } })],
    status,
    null,
    async () => {},
    undefined,
  );

  assert.equal(secondTextCalls, 0);
  assert.equal(status.textContent, 'An import is already in progress.');
  assert.match(status.className, /is-warning/);
  assert.deepEqual(firstBusyEvents, [true]);

  firstText.resolve(JSON.stringify({ schema: 'voxellab.microscopyWorkflowRecipe.v1' }));
  await firstImport;

  assert.equal(firstTextCalls, 1);
  assert.deepEqual(firstBusyEvents, [true, false]);

  let thirdTextCalls = 0;
  const thirdBusyEvents = [];
  await handleLocalImport(
    [workflowSidecar({ name: 'third-workflow.json', onText: () => { thirdTextCalls += 1; } })],
    statusElement(),
    null,
    async () => {},
    value => thirdBusyEvents.push(value),
  );

  assert.equal(thirdTextCalls, 1);
  assert.deepEqual(thirdBusyEvents, [true, false]);
});
