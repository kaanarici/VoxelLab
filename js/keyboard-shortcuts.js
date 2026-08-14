const STORAGE_KEY = 'voxellab.keyboardShortcuts.v1';

const commands = new Map();
const order = [];
const listeners = new Set();
let overrides = readOverrides();

const isMac = () => /Mac|iPhone|iPad|iPod/i.test(globalThis.navigator?.platform || '');

function readOverrides() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function writeOverrides() {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Local storage can be unavailable in hardened browser contexts.
  }
}

function emitChange() {
  for (const listener of listeners) listener();
}

function keyToken(raw) {
  const key = String(raw || '').trim();
  if (!key) return '';
  const lower = key.toLowerCase();
  if (lower === ' ') return 'Space';
  if (lower === 'esc') return 'Escape';
  if (lower === 'return') return 'Enter';
  if (lower === 'cmd' || lower === 'command' || key === '⌘') return 'Meta';
  if (lower === 'control') return 'Ctrl';
  if (lower === 'option' || key === '⌥') return 'Alt';
  if (key === '⇧') return 'Shift';
  if (key.length === 1 && /[a-z]/i.test(key)) return key.toUpperCase();
  return key.length === 1 ? key : key[0].toUpperCase() + key.slice(1);
}

export function normalizeShortcut(value) {
  if (!value) return '';
  const cleaned = String(value)
    .replaceAll('⌘', 'Meta+')
    .replaceAll('⌃', 'Ctrl+')
    .replaceAll('⌥', 'Alt+')
    .replaceAll('⇧', 'Shift+')
    .replace(/\s*\+\s*/g, '+')
    .trim();
  const parts = cleaned.split('+').filter(Boolean);
  const mods = new Set();
  let key = '';
  for (const part of parts) {
    const token = keyToken(part);
    const lower = token.toLowerCase();
    if (lower === 'mod') mods.add(isMac() ? 'Meta' : 'Ctrl');
    else if (lower === 'meta') mods.add('Meta');
    else if (lower === 'ctrl') mods.add('Ctrl');
    else if (lower === 'alt') mods.add('Alt');
    else if (lower === 'shift') mods.add('Shift');
    else key = token;
  }
  if (!key) return '';
  return ['Meta', 'Ctrl', 'Alt', 'Shift'].filter((mod) => mods.has(mod)).concat(key).join('+');
}

function keyFromEvent(e) {
  if (!e?.key || ['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return '';
  if (e.key === ' ') return 'Space';
  if (e.key === 'Esc') return 'Escape';
  if (e.key.length === 1 && /[a-z]/i.test(e.key)) return e.key.toUpperCase();
  return e.key;
}

export function shortcutFromEvent(e) {
  const key = keyFromEvent(e);
  if (!key) return '';
  const ignoreShift = key === '?';
  const mods = [];
  if (e.metaKey) mods.push('Meta');
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey && !ignoreShift) mods.push('Shift');
  return mods.concat(key).join('+');
}

export function displayShortcutParts(shortcut) {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return [];
  return normalized.split('+').map((part) => {
    if (part === 'Meta') return isMac() ? '⌘' : 'Meta';
    if (part === 'Alt') return isMac() ? '⌥' : 'Alt';
    if (part === 'Shift') return isMac() ? '⇧' : 'Shift';
    return part.length === 1 ? part.toUpperCase() : part;
  });
}

export function registerShortcutCommand(command) {
  if (!command?.id) return;
  const existing = commands.get(command.id);
  const normalized = normalizeShortcut(command.shortcut);
  commands.set(command.id, {
    ...existing,
    ...command,
    defaultShortcut: normalized,
  });
  if (!order.includes(command.id)) order.push(command.id);
  emitChange();
}

export function registerShortcutCommands(list) {
  list.forEach(registerShortcutCommand);
}

export function onShortcutsChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getShortcut(commandId) {
  if (!commands.has(commandId)) return '';
  if (Object.hasOwn(overrides, commandId)) return normalizeShortcut(overrides[commandId]);
  return commands.get(commandId).defaultShortcut || '';
}

export function isShortcutCustomized(commandId) {
  return Object.hasOwn(overrides, commandId);
}

export function shortcutRows() {
  return order.map((id) => {
    const command = commands.get(id);
    const shortcut = getShortcut(id);
    return {
      ...command,
      shortcut,
      isCustomized: isShortcutCustomized(id),
      description: command.description || command.keywords || '',
    };
  });
}

export function commandForShortcut(shortcut, exceptId = '') {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return null;
  for (const id of order) {
    if (id === exceptId) continue;
    if (getShortcut(id) === normalized) return commands.get(id);
  }
  return null;
}

export function setShortcut(commandId, shortcut) {
  const normalized = normalizeShortcut(shortcut);
  if (!commands.has(commandId) || !normalized) return { ok: false };
  const conflict = commandForShortcut(normalized, commandId);
  if (conflict) return { ok: false, conflict };
  overrides = { ...overrides, [commandId]: normalized };
  writeOverrides();
  emitChange();
  return { ok: true };
}

export function clearShortcut(commandId) {
  if (!commands.has(commandId)) return;
  overrides = { ...overrides, [commandId]: '' };
  writeOverrides();
  emitChange();
}

export function resetShortcut(commandId) {
  if (!commands.has(commandId)) return;
  const next = { ...overrides };
  delete next[commandId];
  overrides = next;
  writeOverrides();
  emitChange();
}

export function matchCommandShortcutEvent(e, commandId) {
  return getShortcut(commandId) === shortcutFromEvent(e);
}

export function runShortcutEvent(e) {
  const command = commandForShortcut(shortcutFromEvent(e));
  if (!command?.action) return false;
  e.preventDefault();
  e.stopPropagation();
  command.action();
  return true;
}
