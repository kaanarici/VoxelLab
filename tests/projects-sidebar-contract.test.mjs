import assert from 'node:assert/strict';
import { test } from 'node:test';

import { initProjects, notifyProjectsChanged } from '../js/projects/projects-sidebar.js';

test('notifyProjectsChanged exposes the sidebar render promise to selection callers', async () => {
  let finishRender;
  const renderPromise = new Promise(resolve => { finishRender = resolve; });
  initProjects({ onUpdate: () => renderPromise, selectSeries: async () => {} });

  const notified = notifyProjectsChanged(4);

  assert.equal(notified, renderPromise);
  finishRender();
  await notified;
});
