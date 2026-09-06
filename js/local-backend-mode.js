import { $ } from './dom.js';
import { viewerAiFlags } from './config.js';

export function applyLocalBackendMode() {
  const flags = viewerAiFlags();
  const hideAiControls = !flags.localAiActionsEnabled;

  for (const id of ['btn-ask', 'btn-consult']) {
    const el = $(id);
    if (el) el.classList.toggle('hidden', hideAiControls);
  }
  $('help-ai-row')?.classList.toggle('hidden', hideAiControls);
  $('help-ai-foot')?.classList.toggle('hidden', hideAiControls);
}
