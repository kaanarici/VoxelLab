import { $, closeModal, openModal } from './dom.js';
import {
  clearShortcut,
  displayShortcutParts,
  resetShortcut,
  setShortcut,
  shortcutFromEvent,
  shortcutRows,
} from './keyboard-shortcuts.js';

let initialized = false;
let editingId = '';
let conflictText = '';

function keycaps(shortcut) {
  const parts = displayShortcutParts(shortcut);
  const node = document.createElement('span');
  if (!parts.length) {
    node.className = 'shortcut-unassigned';
    node.textContent = 'Unassigned';
    return node;
  }
  node.className = 'shortcut-keycaps';
  for (const part of parts) {
    const key = document.createElement('kbd');
    key.textContent = part;
    node.appendChild(key);
  }
  return node;
}

function iconButton(label, paths, className = '') {
  const button = document.createElement('button');
  button.className = `shortcut-icon-btn ${className}`.trim();
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.dataset.tip = label;
  button.dataset.tipPos = 'top';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  button.appendChild(svg);
  return button;
}

function renderRow(row) {
  const isEditing = editingId === row.id;
  const hasShortcut = Boolean(row.shortcut);
  const root = document.createElement('div');
  root.className = `shortcut-row${isEditing ? ' editing' : ''}`;
  root.dataset.shortcutId = row.id;

  const command = document.createElement('div');
  command.className = 'shortcut-command';
  const title = document.createElement('div');
  title.className = 'shortcut-name';
  title.textContent = row.label;
  const description = document.createElement('div');
  description.className = 'shortcut-description';
  description.textContent = row.description;
  command.append(title, description);
  if (isEditing && conflictText) {
    const conflict = document.createElement('div');
    conflict.className = 'shortcut-conflict';
    conflict.textContent = conflictText;
    command.appendChild(conflict);
  }

  const binding = document.createElement('div');
  binding.className = 'shortcut-binding';
  if (isEditing) {
    const capture = document.createElement('div');
    capture.className = 'shortcut-capture';
    capture.setAttribute('role', 'status');
    capture.textContent = 'Press shortcut';
    const cancel = document.createElement('button');
    cancel.className = 'shortcut-cancel';
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    binding.append(capture, cancel);
  } else {
    binding.append(
      keycaps(row.shortcut),
      iconButton(`Edit shortcut for ${row.label}`, ['M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z'], 'shortcut-edit'),
    );
  }

  const actions = document.createElement('div');
  actions.className = 'shortcut-actions';
  actions.appendChild(iconButton(`Clear shortcut for ${row.label}`, [
    'M3 6h18',
    'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6',
    'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2',
  ], hasShortcut ? 'shortcut-clear' : 'shortcut-clear is-disabled'));
  if (row.isCustomized) {
    actions.appendChild(iconButton(`Reset shortcut for ${row.label}`, [
      'M3 12a9 9 0 1 0 3-6.7',
      'M3 4v6h6',
    ], 'shortcut-reset'));
  }
  root.append(command, binding, actions);
  return root;
}

function render() {
  const list = $('shortcuts-list');
  if (!list) return;
  list.replaceChildren(...shortcutRows().map(renderRow));
}

function startEdit(id) {
  editingId = id;
  conflictText = '';
  render();
}

function finishEdit() {
  editingId = '';
  conflictText = '';
  render();
}

function init() {
  if (initialized) return;
  initialized = true;
  const modal = $('shortcuts-modal');
  const list = $('shortcuts-list');
  $('shortcuts-close')?.addEventListener('click', () => closeModal('shortcuts-modal'));
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeModal('shortcuts-modal');
  });
  list?.addEventListener('click', (e) => {
    const row = e.target.closest('.shortcut-row');
    if (!row) return;
    const id = row.dataset.shortcutId;
    if (e.target.closest('.shortcut-edit')) startEdit(id);
    else if (e.target.closest('.shortcut-cancel')) finishEdit();
    else if (e.target.closest('.shortcut-clear') && !e.target.closest('.is-disabled')) {
      clearShortcut(id);
      if (editingId === id) finishEdit();
      else render();
    } else if (e.target.closest('.shortcut-reset')) {
      resetShortcut(id);
      render();
    }
  });
  window.addEventListener('keydown', (e) => {
    if (!editingId || !$('shortcuts-modal')?.classList.contains('visible')) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      finishEdit();
      return;
    }
    const shortcut = shortcutFromEvent(e);
    if (!shortcut) return;
    const result = setShortcut(editingId, shortcut);
    if (result.ok) {
      finishEdit();
      return;
    }
    conflictText = result.conflict
      ? `Already assigned to ${result.conflict.label}. Clear that shortcut first.`
      : 'Press a key or key combination.';
    render();
  }, true);
}

export function openShortcutsModal() {
  init();
  render();
  openModal('shortcuts-modal');
}
