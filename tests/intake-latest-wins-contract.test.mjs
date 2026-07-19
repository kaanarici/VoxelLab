import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { createLatestDesktopIntakeDrain } from '../js/desktop-bridge.js';

function source(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

test('desktop microscopy sidecar-only intake stays in one actionable dialog', () => {
  const desktopBridge = source('../js/desktop-bridge.js');

  assert.match(desktopBridge, /showDesktopIntakeDialog\(\s*'Open microscopy image first',[\s\S]*?chooseOtherFiles: true/);
  assert.doesNotMatch(desktopBridge, /showStudyUploadModal\(selectSeries\);\s+if \(!isCurrentIntake\(\)/);
});

test('desktop intake preserves a close-blocked cloud job modal', () => {
  const desktopBridge = source('../js/desktop-bridge.js');

  assert.match(desktopBridge, /uploadModal\.dataset\.closeBlocked !== 'true'/);
  assert.match(desktopBridge, /voxellab:modal-close-blocked/);
  assert.match(desktopBridge, /if \(cloudJobBlocksDesktopIntake\(\)\) return;/);
});

test('desktop retry action restores one error surface when the native picker rejects', () => {
  const desktopBridge = source('../js/desktop-bridge.js');

  assert.match(desktopBridge, /await desktop\.openFiles\(\);\s*} catch \(error\) {/);
  assert.match(desktopBridge, /'File open failed'/);
});

test('desktop upload zone opens the native file picker while browser intake keeps the file input', () => {
  const uploadModal = source('../js/projects/study-upload-modal.js');

  assert.match(uploadModal, /if \(isDesktopHost && typeof desktop\.openFiles === 'function'\)[\s\S]*?desktop\.openFiles\(\)/);
  assert.match(uploadModal, /if \(isDesktopHost && typeof desktop\.openFiles === 'function'\)[\s\S]*?return;\s*}\s*input\.click\(\)/);
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
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, [
    'start:first:true',
    'finish:first:false',
    'start:latest:true',
    'finish:latest:true',
  ]);
  assert.equal(activeSeries, 'latest');
  assert.equal(busy, false);
});

test('post-selection microscopy sidecars remain bound to the imported series', () => {
  const uploadModal = source('../js/projects/study-upload-modal.js');

  assert.match(uploadModal, /const isSelectedSeriesActive = \(\) => \(/);
  assert.match(uploadModal, /await selectSeries\(selectedIndex\);\s+if \(!isSelectedSeriesActive\(\)\) return;/);
  assert.match(uploadModal, /importImageJRoiSidecarsForActiveSeries\([^;]+isActive: isSelectedSeriesActive/);
  assert.match(uploadModal, /applyRecipeSidecarsForActiveSeries\([^;]+isActive: isSelectedSeriesActive/);
  assert.match(uploadModal, /importRoiSidecarsForActiveSeries\([^;]+isActive: isSelectedSeriesActive/);
});
