// Shared mutable singletons and store-wrapping mutation actions for the
// projects sidebar modules (tree-render, context-menus, rename-dialog) and the
// projects-sidebar.js entrypoint. Kept DOM-free and dependency-leaf so the
// split modules read/write the same state and trigger the same actions without
// import cycles. Persistence: projects-store.js.

import {
  assignSeriesSlugsToProject,
  createProjectRecord,
  deleteProject,
  renameProjectRecord,
  togglePinSlug,
} from './projects-store.js';

// Multi-selected series slugs (Cmd/Ctrl + Shift click). Keyed by slug.
export const multiSel = new Set();

// Pre-loaded hover-thumbnail Images, keyed by series slug.
export const thumbCache = new Map();

export const sidebar = {
  onUpdate: () => {},
  selectSeries: () => {},
  lastClickedSlug: null,
  // Flat top-to-bottom order of rendered series slugs, used for shift-range select.
  flatOrder: [],
  currentSort: '',
  manifest: null,
  // Signature of the last-rendered tree structure (series set + folder
  // membership/order/collapse + pins + sort + multi-select), excluding the
  // active slug. Lets a pure selection change skip the full rebuild.
  structureSig: null,
};

export function setSidebarCallbacks({ onUpdate, selectSeries }) {
  if (onUpdate) sidebar.onUpdate = onUpdate;
  if (selectSeries) sidebar.selectSeries = selectSeries;
}

export async function createProject(name) {
  const project = await createProjectRecord(name);
  sidebar.onUpdate();
  return project;
}

export async function renameProject(id, name) {
  if (await renameProjectRecord(id, name)) await sidebar.onUpdate();
}

export async function removeProject(id) {
  await deleteProject(id);
  sidebar.onUpdate();
}

export async function assignSeriesToProject(slugOrSlugs, projectId) {
  await assignSeriesSlugsToProject(slugOrSlugs, projectId);
  multiSel.clear();
  sidebar.onUpdate();
}

export function togglePin(slug) {
  togglePinSlug(slug);
  sidebar.onUpdate();
}
