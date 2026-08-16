// Sidebar popovers and context menus: folder menu, sort popover, and the
// series / folder / empty-sidebar right-click menus.

import { $, escapeHtml, showDialog } from '../dom.js';
import { notify } from '../notify.js';
import { removeSeriesFromViewer } from '../series/remove-series.js';
import { getAllProjects, getPinnedSlugs } from './projects-store.js';
import {
  assignSeriesToProject,
  createProject,
  multiSel,
  removeProject,
  sidebar,
  togglePin,
} from './projects-sidebar-state.js';
import { sortManifestSeries, saveSidebarSort, SORT_POPOVER_OPTIONS } from './projects-sidebar-sort.js';

async function showRenameDialog(project) {
  const dialog = await import('./projects-sidebar-rename-dialog.js');
  dialog.showRenameDialog(project);
}

function confirmProjectRemoval(project) {
  const close = showDialog('Delete folder?', `
    <div class="dlg-sub-spaced">
      Delete <b>${escapeHtml(project.name || 'this folder')}</b>? Studies stay open in VoxelLab and source files on your computer are not changed.
    </div>
    <div class="dlg-actions">
      <button class="annot-btn" id="delete-folder-cancel" type="button">Cancel</button>
      <button class="annot-btn danger" id="delete-folder-confirm" type="button">Delete folder</button>
    </div>
  `);
  $('delete-folder-cancel').onclick = close;
  $('delete-folder-confirm').onclick = async () => {
    const button = $('delete-folder-confirm');
    if (button) button.disabled = true;
    try {
      await removeProject(project.id);
      close();
    } catch {
      if (button) button.disabled = false;
      notify('Could not delete the folder. Try again.', { kind: 'error' });
    }
  };
  $('delete-folder-cancel')?.focus();
}

export function showFolderMenu(anchor, project) {
  if (anchor.getAttribute('aria-expanded') === 'true') {
    anchor._dismissPopover?.(true);
    return;
  }
  const rect = anchor.getBoundingClientRect();
  showContextMenu(rect.right, rect.bottom, [
    { label: 'Rename', icon: CTX_ICONS.pencil, action: () => { void showRenameDialog(project); } },
    { label: 'Delete folder', icon: CTX_ICONS.trash, danger: true, action: () => confirmProjectRemoval(project) },
  ], { anchor, className: 'folder-menu' });
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
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'popover-item';
    const isActive = sidebar.currentSort === opt.key;
    item.innerHTML = `
      <span class="popover-label-grow">${opt.label}</span>
      ${isActive ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : ''}
    `;
    item.addEventListener('click', () => {
      sidebar.currentSort = opt.key;
      saveSidebarSort(opt.key);
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

function showContextMenu(x, y, items, { anchor = null, className = '' } = {}) {
  document.querySelectorAll('.context-menu').forEach(menu => menu._dismissPopover?.() || menu.remove());

  const menu = document.createElement('div');
  menu.className = `popover-menu context-menu${className ? ` ${className}` : ''}`;
  menu.style.cssText = `position:fixed; left:${x}px; top:${y}px; z-index:300;`;
  let close;
  let onCtx;
  const dismiss = (restoreFocus = false) => {
    menu.remove();
    document.removeEventListener('mousedown', close);
    document.removeEventListener('contextmenu', onCtx);
    if (anchor) {
      anchor.setAttribute('aria-expanded', 'false');
      anchor._dismissPopover = null;
      if (restoreFocus) anchor.focus();
    }
  };
  menu._dismissPopover = dismiss;
  if (anchor) {
    anchor.setAttribute('aria-expanded', 'true');
    anchor._dismissPopover = dismiss;
  }

  for (const it of items) {
    if (!it) {
      const sep = document.createElement('div');
      sep.className = 'popover-separator';
      menu.appendChild(sep);
      continue;
    }
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'popover-item' + (it.danger ? ' danger' : '');
    row.innerHTML = (it.icon ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${it.icon}</svg>` : '')
      + `<span>${it.label}</span>`;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss(!!anchor);
      it.action();
    });
    menu.appendChild(row);
  }

  document.body.appendChild(menu);
  menu.querySelector('.popover-item')?.focus();

  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth - 8) menu.style.left = `${x - r.width}px`;
  if (r.bottom > window.innerHeight - 8) menu.style.top = `${y - r.height}px`;

  close = (ev) => {
    if (!menu.contains(ev.target)) {
      dismiss();
    }
  };
  onCtx = (ev) => {
    if (!menu.contains(ev.target)) {
      dismiss();
    }
  };
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    dismiss(!!anchor);
  });
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

function confirmSeriesRemoval(slugs) {
  const series = (sidebar.manifest?.series || []).filter(item => slugs.includes(item.slug));
  if (!series.length) return;
  const count = series.length;
  const label = count === 1 ? series[0].name || series[0].slug : `${count} selected series`;
  const close = showDialog('Remove from viewer?', `
    <div class="dlg-sub-spaced">
      Remove <b>${escapeHtml(label)}</b> from VoxelLab? Source files on your computer will not be changed or deleted.
    </div>
    <div class="dlg-actions">
      <button class="annot-btn" id="remove-series-cancel" type="button">Cancel</button>
      <button class="annot-btn danger" id="remove-series-confirm" type="button">Remove</button>
    </div>
  `);
  $('remove-series-cancel').onclick = close;
  $('remove-series-confirm').onclick = async () => {
    const button = $('remove-series-confirm');
    if (button) button.disabled = true;
    try {
      const result = await removeSeriesFromViewer(slugs, {
        selectSeries: sidebar.selectSeries,
        onUpdate: sidebar.onUpdate,
        refreshActiveView: sidebar.refreshActiveView,
      });
      multiSel.clear();
      close();
      notify(
        result.organizationCleanupFailed
          ? `Removed ${result.removed} series, but folder and pin cleanup could not be saved. Source files were left untouched.`
          : `Removed ${result.removed} series from VoxelLab. Source files were left untouched.`,
        result.organizationCleanupFailed ? { kind: 'warning' } : undefined,
      );
    } catch {
      if (button) button.disabled = false;
      notify('Could not remove the selected series. Try again.', { kind: 'error' });
    }
  };
  $('remove-series-cancel')?.focus();
}

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
  items.push(null);
  items.push({
    label: count > 1 ? `Remove ${count} series from viewer` : 'Remove from viewer',
    icon: CTX_ICONS.trash,
    danger: true,
    action: () => confirmSeriesRemoval(slugs),
  });
  showContextMenu(x, y, items);
}

export function showFolderContextMenu(x, y, project) {
  showContextMenu(x, y, [
    { label: 'Rename', icon: CTX_ICONS.pencil, action: () => { void showRenameDialog(project); } },
    { label: 'New folder', icon: CTX_ICONS.folderPlus, action: () => createProject() },
    null,
    { label: 'Delete folder', icon: CTX_ICONS.trash, danger: true, action: () => confirmProjectRemoval(project) },
  ]);
}

export function showSidebarContextMenu(x, y) {
  showContextMenu(x, y, [
    { label: 'New folder', icon: CTX_ICONS.folderPlus, action: () => createProject() },
  ]);
}
