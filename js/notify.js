import { escapeHtml } from './dom.js';
import {
  confirmDuration,
  pickEviction,
  resolveKind,
  shouldAutoDismiss,
} from './notify-policy.js';

const MAX_TOASTS = 4;
const DEFAULT_EXIT_MS = 350;
let _container = null;
let _statusLive = null;
let _alertLive = null;

function notifyIdSelector(id) {
  const escaped = globalThis.CSS?.escape instanceof Function
    ? globalThis.CSS.escape(id)
    : String(id).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `[data-notify-id="${escaped}"]`;
}

function exitDurationMs() {
  if (!(globalThis.getComputedStyle instanceof Function) || !document?.documentElement) return DEFAULT_EXIT_MS;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--panel-close-dur').trim();
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_EXIT_MS;
}

function ensureLiveRegion(id, role) {
  let el = document.getElementById(id);
  if (el?.isConnected) return el;
  el = document.createElement('div');
  el.id = id;
  el.className = 'notify-live';
  el.setAttribute('role', role);
  el.setAttribute('aria-live', role === 'alert' ? 'assertive' : 'polite');
  el.setAttribute('aria-atomic', 'true');
  return el;
}

function ensureContainer() {
  if (_container?.isConnected) {
    if (!_statusLive?.isConnected) _statusLive = ensureLiveRegion('notify-live-status', 'status');
    if (!_alertLive?.isConnected) _alertLive = ensureLiveRegion('notify-live-alert', 'alert');
    if (!_statusLive.parentNode) _container.prepend(_statusLive);
    if (!_alertLive.parentNode) _container.prepend(_alertLive);
    return _container;
  }
  const existing = [...document.querySelectorAll('#notify-container')];
  if (existing.length) {
    _container = existing[0];
    for (const extra of existing.slice(1)) {
      while (extra.firstChild) _container.appendChild(extra.firstChild);
      extra.remove();
    }
  } else {
    _container = document.createElement('div');
    _container.id = 'notify-container';
    document.body.appendChild(_container);
  }
  _statusLive = ensureLiveRegion('notify-live-status', 'status');
  _alertLive = ensureLiveRegion('notify-live-alert', 'alert');
  if (_statusLive.parentNode !== _container) _container.prepend(_statusLive);
  if (_alertLive.parentNode !== _container) _container.prepend(_alertLive);
  return _container;
}

function announce(kind, message) {
  const live = kind === 'error' ? _alertLive : _statusLive;
  if (!live) return;
  live.textContent = '';
  live.textContent = message;
}

function clearTimer(el) {
  clearTimeout(el._dismissTimer);
  el._dismissTimer = null;
  el._paused = false;
  el._remaining = 0;
  el._dismissAt = 0;
}

function armTimer(el, ms) {
  clearTimeout(el._dismissTimer);
  el._paused = false;
  if (!(ms > 0)) {
    el._dismissTimer = null;
    el._remaining = 0;
    el._dismissAt = 0;
    return;
  }
  el._remaining = ms;
  el._dismissAt = Date.now() + ms;
  el._dismissTimer = setTimeout(() => dismissEl(el), ms);
}

function pauseTimer(el) {
  if (el._paused || !el._dismissTimer) return;
  clearTimeout(el._dismissTimer);
  el._dismissTimer = null;
  el._remaining = Math.max(0, (el._dismissAt || 0) - Date.now());
  el._paused = true;
}

function resumeTimer(el) {
  if (!el._paused) return;
  el._paused = false;
  if (el._remaining > 0) armTimer(el, el._remaining);
}

function toastKeepsPause(el, related) {
  return (related && el.contains(related)) || el.contains(document.activeElement);
}

function applyTimer(el, kind, opts) {
  if (shouldAutoDismiss(kind, opts)) {
    armTimer(el, confirmDuration(opts));
    return;
  }
  clearTimer(el);
}

function dismissEl(el) {
  if (!el?.isConnected || el.classList.contains('exiting')) return;
  el.classList.add('exiting');
  clearTimer(el);
  setTimeout(() => el.remove(), exitDurationMs());
}

function shake(el) {
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
}

function syncProgress(el, progress) {
  let bar = el.querySelector('.notify-progress');
  if (progress && !bar) {
    bar = document.createElement('div');
    bar.className = 'notify-progress';
    bar.innerHTML = '<div class="notify-progress-bar"></div>';
    el.querySelector('.notify-body')?.appendChild(bar);
  } else if (!progress && bar) {
    bar.remove();
  }
}

function syncCommand(el, command) {
  const textEl = el.querySelector('.notify-text');
  let cmd = el.querySelector('.notify-cmd');
  if (command) {
    textEl?.classList.add('has-cmd');
    if (!cmd) {
      cmd = document.createElement('div');
      cmd.className = 'notify-cmd';
      cmd.innerHTML = `<code></code><button class="notify-copy" type="button">Copy</button>`;
      textEl?.after(cmd);
      wireCopy(el, command);
    }
    const code = cmd.querySelector('code');
    if (code) code.textContent = command;
    el._notifyCommand = command;
  } else {
    textEl?.classList.remove('has-cmd');
    cmd?.remove();
    el._notifyCommand = '';
  }
}

function wireCopy(el, command) {
  const copyBtn = el.querySelector('.notify-copy');
  if (!copyBtn) return;
  copyBtn.addEventListener('click', async () => {
    const value = el._notifyCommand || command;
    try {
      await navigator.clipboard.writeText(value);
      copyBtn.textContent = 'Copied';
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
        copyBtn.classList.remove('copied');
      }, 2000);
    } catch {
      const code = el.querySelector('code');
      if (code) {
        const range = document.createRange();
        range.selectNodeContents(code);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
      }
    }
  });
}

function applyKind(el, kind) {
  el.dataset.notifyKind = kind;
}

function updateExisting(el, message, opts, kind) {
  const textEl = el.querySelector('.notify-text');
  if (textEl) textEl.textContent = message;
  applyKind(el, kind);
  syncCommand(el, opts.command);
  syncProgress(el, !!opts.progress);
  shake(el);
  applyTimer(el, kind, opts);
  announce(kind, message);
  return el;
}

function visibleItems(container) {
  return [...container.querySelectorAll('.notify-item:not(.exiting)')];
}

export function notify(message, opts = {}) {
  const kind = resolveKind(opts);
  const { command, progress, id } = opts;
  const container = ensureContainer();

  if (id) {
    const existing = container.querySelector(`${notifyIdSelector(id)}.notify-item:not(.exiting)`);
    if (existing) return updateExisting(existing, message, opts, kind);
  }

  if (!id) {
    for (const child of visibleItems(container)) {
      const textEl = child.querySelector('.notify-text');
      if (textEl && textEl.textContent === message) {
        return updateExisting(child, message, opts, kind);
      }
    }
  }

  const items = visibleItems(container);
  if (items.length >= MAX_TOASTS) {
    const evictAt = pickEviction(items.map(item => ({ kind: item.dataset.notifyKind || 'confirm' })));
    if (evictAt >= 0) dismissEl(items[evictAt]);
  }

  const el = document.createElement('div');
  el.className = 'notify-item';
  applyKind(el, kind);
  if (id) el.dataset.notifyId = id;

  let bodyHtml = `<div class="notify-text${command ? ' has-cmd' : ''}">${escapeHtml(message)}</div>`;
  if (command) {
    bodyHtml += `
      <div class="notify-cmd">
        <code>${escapeHtml(command)}</code>
        <button class="notify-copy" type="button">Copy</button>
      </div>
    `;
  }
  if (progress) {
    bodyHtml += `<div class="notify-progress"><div class="notify-progress-bar"></div></div>`;
  }
  el.innerHTML = `<div class="notify-body">${bodyHtml}</div><button class="notify-dismiss" type="button" aria-label="Dismiss">×</button>`;
  el._notifyCommand = command || '';

  el.querySelector('.notify-dismiss').addEventListener('click', () => dismissEl(el));
  if (command) wireCopy(el, command);
  el.addEventListener('pointerenter', () => pauseTimer(el));
  el.addEventListener('pointerleave', (event) => {
    if (!toastKeepsPause(el, event.relatedTarget)) resumeTimer(el);
  });
  el.addEventListener('focusin', () => pauseTimer(el));
  el.addEventListener('focusout', (event) => {
    if (!toastKeepsPause(el, event.relatedTarget)) resumeTimer(el);
  });

  container.appendChild(el);
  applyTimer(el, kind, opts);
  announce(kind, message);
  return el;
}

export function dismissNotify(id) {
  const container = ensureContainer();
  const el = container.querySelector(notifyIdSelector(id));
  if (el) dismissEl(el);
}
