import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLatestDesktopIntakeDrain } from '../js/desktop-bridge.js';
import { openDesktopOrBrowserFilePicker } from '../js/projects/study-upload-modal.js';
import { nextTask } from './helpers/node/wait.mjs';
import { installViewerGlobals } from './helpers/node/viewer-globals.mjs';

installViewerGlobals();

const {
  applyRecipeSidecarsForActiveSeries,
  importImageJRoiSidecarsForActiveSeries,
  importRoiSidecarsForActiveSeries,
} = await import('../js/projects/microscopy-sidecars.js');
const { handleLocalImport } = await import('../js/intake/run-local-import.js');

function statusElement() {
  return { className: '', textContent: '', innerHTML: '', removeAttribute() {} };
}

test('desktop upload uses the native picker while browser intake clicks the file input', async () => {
  const calls = [];
  assert.equal(await openDesktopOrBrowserFilePicker({
    isDesktopHost: true,
    desktop: { openFiles: async () => calls.push('desktop') },
    input: { click: () => calls.push('browser') },
  }), 'desktop');
  assert.equal(await openDesktopOrBrowserFilePicker({
    isDesktopHost: false,
    desktop: null,
    input: { click: () => calls.push('browser') },
  }), 'browser');
  assert.deepEqual(calls, ['desktop', 'browser']);
});

test('desktop intake drain runs only the latest queued payload after active work settles', async () => {
  let releaseFirst;
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
  const events = [];
  let busy = false;
  let activeSeries = '';
  const enqueue = createLatestDesktopIntakeDrain(async (payload, isCurrent) => {
    assert.equal(busy, false, `${payload.id} must not overlap another import`);
    busy = true;
    events.push(`start:${payload.id}:${isCurrent()}`);
    if (payload.id === 'first') await firstBlocked;
    if (isCurrent()) activeSeries = payload.id;
    events.push(`finish:${payload.id}:${isCurrent()}`);
    busy = false;
  });

  enqueue({ id: 'first' });
  await Promise.resolve();
  enqueue({ id: 'second' });
  enqueue({ id: 'latest' });
  await Promise.resolve();
  assert.deepEqual(events, ['start:first:true']);

  releaseFirst();
  await nextTask();
  assert.deepEqual(events, [
    'start:first:true',
    'finish:first:false',
    'start:latest:true',
    'finish:latest:true',
  ]);
  assert.equal(activeSeries, 'latest');
  assert.equal(busy, false);
});

test('desktop intake drain drops queued payloads and keeps draining after a failure', async () => {
  const seen = [];
  let releaseFirst;
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
  const enqueue = createLatestDesktopIntakeDrain(async (payload) => {
    seen.push(payload.id);
    if (payload.id === 'first') await firstBlocked;
    if (payload.id === 'boom') throw new Error('import failed');
  });

  const inFlight = enqueue({ id: 'first' });
  await Promise.resolve();
  const queued = enqueue({ id: 'queued' });
  const winner = enqueue({ id: 'latest' });

  assert.equal(await queued, false, 'a payload replaced before it starts never runs');
  releaseFirst();
  assert.equal(await inFlight, false, 'in-flight work that lost the race reports itself superseded');
  assert.equal(await winner, true);
  assert.deepEqual(seen, ['first', 'latest']);

  await assert.rejects(enqueue({ id: 'boom' }), /import failed/);
  assert.equal(await enqueue({ id: 'after-failure' }), true, 'a failed intake must not wedge the drain');
  assert.deepEqual(seen, ['first', 'latest', 'boom', 'after-failure']);
});

test('a superseded local import stops before touching status, busy state, or the file list', async () => {
  const status = statusElement();
  const busyEvents = [];
  let readFiles = 0;
  const sidecar = {
    name: 'workflow.json',
    async text() {
      readFiles += 1;
      return JSON.stringify({ schema: 'voxellab.microscopyWorkflowRecipe.v1' });
    },
  };

  await handleLocalImport(
    [sidecar],
    status,
    null,
    async () => { throw new Error('a superseded import must not select a series'); },
    value => busyEvents.push(value),
    { isActive: () => false },
  );

  assert.equal(readFiles, 0);
  assert.equal(status.textContent, '');
  assert.deepEqual(busyEvents, []);
});

test('sidecar imports report stale instead of applying to a series that changed', async () => {
  const roiSidecar = { name: 'rois.json', bundle: { schema: 'voxellab.roiResults.v1', rows: [] } };
  const recipeSidecar = { name: 'workflow.json', recipe: { schema: 'voxellab.microscopyWorkflowRecipe.v1' } };
  const imageJSidecar = { name: 'cell.roi', rois: [] };
  const isActive = () => false;

  assert.deepEqual(
    await importRoiSidecarsForActiveSeries([roiSidecar], { isActive }),
    { applied: 0, skipped: 0, stale: true },
  );
  assert.deepEqual(
    await applyRecipeSidecarsForActiveSeries([recipeSidecar], { isActive }),
    { applied: 0, skipped: 0, stale: true },
  );
  assert.deepEqual(
    await importImageJRoiSidecarsForActiveSeries([imageJSidecar], { isActive }),
    { applied: 0, skipped: 0, stale: true },
  );
});

test('sidecar imports stay inert with nothing to apply and never report staleness', async () => {
  for (const importSidecars of [
    importRoiSidecarsForActiveSeries,
    applyRecipeSidecarsForActiveSeries,
    importImageJRoiSidecarsForActiveSeries,
  ]) {
    assert.deepEqual(await importSidecars([], { isActive: () => true }), { applied: 0, skipped: 0 });
    assert.deepEqual(await importSidecars(), { applied: 0, skipped: 0 });
  }
});
