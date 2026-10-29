import { $, escapeHtml, releaseFocus, trapFocus } from './dom.js';
import {
  displayShortcutParts,
  getShortcut,
  matchCommandShortcutEvent,
  onShortcutsChange,
  isStudyFreeCommand,
  registerShortcutCommand,
} from './keyboard-shortcuts.js';
import { state } from './core/state.js';

const commands = [];

export function registerCommand(cmd) {
  if (!commands.find(c => c.id === cmd.id)) commands.push(cmd);
  registerShortcutCommand(cmd);
}

export function registerCommands(list) {
  list.forEach(registerCommand);
}

registerShortcutCommand({
  id: 'command-palette',
  label: 'Search actions',
  section: 'General',
  shortcut: 'Mod+K',
  description: 'Open the command palette',
  action: toggle,
});

const backdrop = $('cmdk');
const dialog   = $('cmdk-dialog');
const input    = $('cmdk-input');
const list     = $('cmdk-list');

let activeIdx = 0;
let filtered  = [];

function isOpen() { return backdrop.classList.contains('open'); }

export function openPalette() {
  if (isOpen()) return;
  backdrop.inert = false;
  backdrop.classList.add('open');
  input.value = '';
  activeIdx = 0;
  render();
  trapFocus(backdrop);

  requestAnimationFrame(() => input.focus());
}

export function closePalette() {
  if (!isOpen()) return;
  backdrop.classList.remove('open');
  backdrop.inert = true;
  releaseFocus(backdrop);
}

function toggle() { isOpen() ? closePalette() : openPalette(); }

function matchFilter(cmd, q) {
  if (!q) return true;
  const hay = `${cmd.label} ${cmd.section} ${cmd.keywords || ''}`.toLowerCase();
  return q.split(/\s+/).every(w => hay.includes(w));
}

function render() {
  const q = input.value.trim().toLowerCase();
  const studyLoaded = !!state.manifest?.series?.[state.seriesIdx];
  const matches = commands.filter(c => (studyLoaded || isStudyFreeCommand(c)) && matchFilter(c, q));
  const sections = [...new Set(matches.map(c => c.section))]
    .sort((a, b) => (studyLoaded ? 0 : (b === 'General') - (a === 'General')));
  filtered = sections.flatMap(sec => matches.filter(c => c.section === sec));

  if (filtered.length === 0) {
    list.innerHTML = '<div class="cmdk-empty">No matching actions</div>';
    return;
  }

  let html = '';
  let flatIdx = 0;
  for (const sec of sections) {
    html += `<div class="cmdk-section-header">${sec}</div>`;
    for (const cmd of filtered) {
      if (cmd.section !== sec) continue;
      const sc = getShortcut(cmd.id)
        ? `<span class="cmdk-row-shortcut">${displayShortcutParts(getShortcut(cmd.id)).map(k => `<kbd>${escapeHtml(k)}</kbd>`).join('')}</span>`
        : '';
      html += `<button class="cmdk-row${flatIdx === activeIdx ? ' active' : ''}" data-cmdk-idx="${flatIdx}">
        <span class="cmdk-row-icon"><svg class="ico"><use href="icons.svg#${cmd.icon}"/></svg></span>
        <span class="cmdk-row-label">${escapeHtml(cmd.label)}</span>
        ${sc}
      </button>`;
      flatIdx++;
    }
  }
  list.innerHTML = html;
}

function scrollActive() {
  const el = list.querySelector('.cmdk-row.active');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function execActive() {
  const cmd = filtered[activeIdx];
  if (cmd) {
    closePalette();
    cmd.action();
  }
}

document.addEventListener('keydown', (e) => {
  if (matchCommandShortcutEvent(e, 'command-palette')) {
    e.preventDefault();
    toggle();
    return;
  }
  if (!isOpen()) return;

  if (e.key === 'Escape') { e.stopPropagation(); closePalette(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, filtered.length - 1); render(); scrollActive(); return; }
  if (e.key === 'ArrowUp')   { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); render(); scrollActive(); return; }
  if (e.key === 'Enter')     { e.preventDefault(); execActive(); return; }
}, true);

input.addEventListener('input', () => { activeIdx = 0; render(); });

list.addEventListener('click', (e) => {
  const row = e.target.closest('.cmdk-row');
  if (row) { activeIdx = +row.dataset.cmdkIdx; execActive(); }
});

list.addEventListener('mousemove', (e) => {
  const row = e.target.closest('.cmdk-row');
  if (row) {
    const idx = +row.dataset.cmdkIdx;
    if (idx !== activeIdx) { activeIdx = idx; render(); }
  }
});

backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closePalette(); });
dialog.addEventListener('click', (e) => e.stopPropagation());

const sidebarBtn = $('btn-cmdk-open');
if (sidebarBtn) sidebarBtn.addEventListener('click', openPalette);

onShortcutsChange(() => {
  if (isOpen()) render();
});
