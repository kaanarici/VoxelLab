import { notify } from '../notify.js';
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
export function initProjects({ onUpdate, selectSeries, refreshActiveView }) {
  setSidebarCallbacks({ onUpdate, selectSeries, refreshActiveView });
}

function warnProjectsUnavailable() {
  notify('Folder organization is temporarily unavailable; series remain openable.', {
    id: 'projects-storage-warning',
    kind: 'warning',
  });
}

export function notifyProjectsChanged(currentSeriesIdx) {
  let render;
  try {
    render = sidebar.onUpdate(currentSeriesIdx);
  } catch {
    warnProjectsUnavailable();
    return undefined;
  }
  void render?.catch?.(warnProjectsUnavailable);
  return render;
}
