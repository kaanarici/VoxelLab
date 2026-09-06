export function setUploadStatus(statusEl, message, tone = 'muted', { html = false } = {}) {
  statusEl.className = `upload-status${tone === 'muted' ? '' : ` is-${tone}`}`;
  statusEl.removeAttribute('aria-label');
  if (html) statusEl.innerHTML = message;
  else statusEl.textContent = message;
}

export function hasActionableIntake(intake = {}) {
  const counts = intake?.counts || {};
  return Boolean(Number(counts.openable || 0) || Number(counts.convertible || 0) || Number(counts.sidecar || 0));
}
