// Projects sidebar entrypoint (folders, pins, DnD, menus). Composes the split
// modules and re-exports them under the original projects-sidebar.js surface so
// importers are unaffected:
//   - projects-sidebar-state.js     shared singletons + store-wrapping actions
//   - projects-sidebar-sort.js      sort options and ordering helpers
//   - projects-sidebar-tree-render.js  folder/group/row rendering, DnD, thumbs
//   - projects-sidebar-context-menus.js  folder menu, sort popover, right-click menus
//   - projects-sidebar-rename-dialog.js  rename-folder modal
// Persistence: projects-store.js.

import { sidebar, setSidebarCallbacks } from './projects-sidebar-state.js';

export {
  createProject,
  renameProject,
  removeProject,
  assignSeriesToProject,
  togglePin,
} from './projects-sidebar-state.js';
export {
  renderProjectsSidebar,
  toggleProjectCollapsed,
  expandFolderForSeries,
} from './projects-sidebar-tree-render.js';
export {
  showFolderMenu,
  showSortPopover,
  showSeriesContextMenu,
  showFolderContextMenu,
  showSidebarContextMenu,
} from './projects-sidebar-context-menus.js';
export { showRenameDialog } from './projects-sidebar-rename-dialog.js';

export function initProjects({ onUpdate, selectSeries }) {
  setSidebarCallbacks({ onUpdate, selectSeries });
}

export function notifyProjectsChanged(currentSeriesIdx) {
  sidebar.onUpdate(currentSeriesIdx);
}
