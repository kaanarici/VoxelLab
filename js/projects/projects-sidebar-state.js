import {
  assignSeriesSlugsToProject,
  createProjectRecord,
  deleteProject,
  renameProjectRecord,
  togglePinSlug,
} from './projects-store.js';
import { loadSidebarSort } from './projects-sidebar-sort.js';

export const multiSel = new Set();

export const thumbCache = new Map();

export const sidebar = {
  onUpdate: () => {},
  selectSeries: () => {},
  refreshActiveView: () => {},
  lastClickedSlug: null,

  flatOrder: [],
  currentSort: loadSidebarSort(),
  manifest: null,

  structureSig: null,
};

export function setSidebarCallbacks({ onUpdate, selectSeries, refreshActiveView }) {
  if (onUpdate) sidebar.onUpdate = onUpdate;
  if (selectSeries) sidebar.selectSeries = selectSeries;
  if (refreshActiveView) sidebar.refreshActiveView = refreshActiveView;
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
