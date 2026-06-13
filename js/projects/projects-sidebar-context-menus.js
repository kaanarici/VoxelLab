// Sidebar popovers and context menus: folder menu, sort popover, and the
// series / folder / empty-sidebar right-click menus.

import { getAllProjects, getPinnedSlugs } from './projects-store.js';
import {
  assignSeriesToProject,
  createProject,
  multiSel,
  removeProject,
  sidebar,
  togglePin,
} from './projects-sidebar-state.js';
import { showRenameDialog } from './projects-sidebar-rename-dialog.js';
import { sortManifestSeries, SORT_POPOVER_OPTIONS } from './projects-sidebar-sort.js';

export function showFolderMenu(anchor, project) {
  document.querySelectorAll('.folder-menu').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'folder-menu popover-menu';

  const renameItem = document.createElement('div');
  renameItem.className = 'popover-item';
  renameItem.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
    </svg>
    <span>Rename</span>
  `;
  renameItem.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.remove();
    anchor.focus();
    showRenameDialog(project);
  });

  const deleteItem = document.createElement('div');
  deleteItem.className = 'popover-item danger';
  deleteItem.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
    </svg>
    <span>Delete</span>
  `;
  deleteItem.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.remove();
    removeProject(project.id);
  });

  menu.appendChild(renameItem);
  menu.appendChild(deleteItem);

  anchor.classList.add('project-menu-anchor');
  anchor.appendChild(menu);

  const close = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

export function showSortPopover(anchor, manifest) {
  const existing = document.querySelector('.sort-popover');
  if (existing) {
    existing.remove();
    return;
  }

  const pop = document.createElement('div');
  pop.className = 'sort-popover popover-menu';
  pop.style.zIndex = '300';

  for (const opt of SORT_POPOVER_OPTIONS) {
    const item = document.createElement('div');
    item.className = 'popover-item';
    const isActive = sidebar.currentSort === opt.key;
    item.innerHTML = `
      <span class="popover-label-grow">${opt.label}</span>
      ${isActive ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
    `;
    item.addEventListener('click', () => {
      sidebar.currentSort = opt.key;
      sortManifestSeries(manifest, opt.key);
      pop.remove();
      sidebar.onUpdate();
    });
    pop.appendChild(item);
  }

  anchor.parentElement.classList.add('project-menu-anchor');
  anchor.parentElement.appendChild(pop);
  const close = (e) => {
    if (!pop.contains(e.target) && e.target !== anchor) {
      pop.remove();
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function showContextMenu(x, y, items) {
  document.querySelectorAll('.context-menu').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'popover-menu context-menu';
  menu.style.cssText = `position:fixed; left:${x}px; top:${y}px; z-index:500;`;

  for (const it of items) {
    if (!it) {
      const sep = document.createElement('div');
      sep.className = 'popover-separator';
      menu.appendChild(sep);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'popover-item' + (it.danger ? ' danger' : '');
    row.innerHTML = (it.icon ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${it.icon}</svg>` : '')
      + `<span>${it.label}</span>`;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.remove();
      it.action();
    });
    menu.appendChild(row);
  }

  document.body.appendChild(menu);

  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth - 8) menu.style.left = `${x - r.width}px`;
  if (r.bottom > window.innerHeight - 8) menu.style.top = `${y - r.height}px`;

  const close = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('mousedown', close);
      document.removeEventListener('contextmenu', onCtx);
    }
  };
  const onCtx = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('mousedown', close);
      document.removeEventListener('contextmenu', onCtx);
    }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', close);
    document.addEventListener('contextmenu', onCtx);
  }, 0);
  return menu;
}

const CTX_ICONS = {
  folderPlus: '<path d="M12 10v6M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  moveOut: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5V20"/>',
};

export async function showSeriesContextMenu(x, y, slug) {
  if (!multiSel.has(slug)) {
    multiSel.clear();
    multiSel.add(slug);
    sidebar.onUpdate();
  }
  const slugs = [...multiSel];
  const count = slugs.length;
  const projects = await getAllProjects();
  const inFolder = projects.some(p => slugs.some(s => p.seriesSlugs.includes(s)));

  const items = [
    {
      label: count > 1 ? `New folder from ${count} items` : 'New folder from selection',
      icon: CTX_ICONS.folderPlus,
      action: async () => {
        const proj = await createProject();
        await assignSeriesToProject(slugs, proj.id);
      },
    },
  ];
  if (projects.length > 0) {
    for (const p of projects) {
      items.push({
        label: `Move to: ${p.name}`,
        icon: CTX_ICONS.folderPlus,
        action: () => assignSeriesToProject(slugs, p.id),
      });
    }
  }
  if (inFolder) {
    items.push({
      label: 'Remove from folder',
      icon: CTX_ICONS.moveOut,
      action: () => assignSeriesToProject(slugs, null),
    });
  }
  items.push(null);
  items.push({
    label: count === 1 && getPinnedSlugs().includes(slug) ? 'Unpin' : 'Pin',
    icon: CTX_ICONS.pin,
    action: () => {
      for (const s of slugs) togglePin(s);
    },
  });
  showContextMenu(x, y, items);
}

export function showFolderContextMenu(x, y, project) {
  showContextMenu(x, y, [
    { label: 'Rename', icon: CTX_ICONS.pencil, action: () => showRenameDialog(project) },
    { label: 'New folder', icon: CTX_ICONS.folderPlus, action: () => createProject() },
    null,
    { label: 'Delete folder', icon: CTX_ICONS.trash, danger: true, action: () => removeProject(project.id) },
  ]);
}

export function showSidebarContextMenu(x, y) {
  showContextMenu(x, y, [
    { label: 'New folder', icon: CTX_ICONS.folderPlus, action: () => createProject() },
  ]);
}
