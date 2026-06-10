// Sidebar tree rendering: project folders, study-type groups, pinned + loose
// series rows, drag-and-drop, multi-select, and hover thumbnails.

import { $, escapeHtml } from '../dom.js';
import { imageUrlForStack } from '../series/series-image-stack.js';
import { state } from '../core/state.js';
import {
  expandFolderForSeriesSlug,
  getAllProjects,
  getPinnedSlugs,
  swapFolderOrder,
  toggleProjectCollapsedState,
} from './projects-store.js';
import { multiSel, thumbCache, sidebar, assignSeriesToProject, createProject, togglePin } from './projects-sidebar-state.js';
import {
  showFolderContextMenu,
  showFolderMenu,
  showSeriesContextMenu,
  showSidebarContextMenu,
  showSortPopover,
} from './projects-sidebar-context-menus.js';
import { sortSeriesArray, studyType } from './projects-sidebar-sort.js';

const INTERACTIVE_UI_BLOCKING_ESCAPE =
  '.cmdk-backdrop.open, #annot-modal.visible, #ask-modal.visible, #consult-modal.visible, #upload-modal.visible, #confirm-modal.visible, #help-modal.visible, #shortcuts-modal.visible';

const PIN_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>
</svg>`;

async function getProjectsForRender() {
  try {
    return await Promise.race([
      getAllProjects(),
      new Promise((resolve) => setTimeout(() => resolve([]), 50)),
    ]);
  } catch {
    return [];
  }
}

function setFolderSeriesRowsVisible(folderEl, visible) {
  folderEl.querySelectorAll(':scope > li').forEach((li) => {
    li.style.display = visible ? '' : 'none';
  });
}

export async function toggleProjectCollapsed(id) {
  const p = await toggleProjectCollapsedState(id);
  if (!p) return;
  const el = document.querySelector(`[data-project-id="${id}"]`);
  if (el) {
    if (p.collapsed) {
      el.classList.add('collapsed');
      setFolderSeriesRowsVisible(el, false);
      return;
    }
    if (el.querySelector(':scope > li')) {
      el.classList.remove('collapsed');
      setFolderSeriesRowsVisible(el, true);
      return;
    }
  }
  sidebar.onUpdate();
}

export async function expandFolderForSeries(slug) {
  await expandFolderForSeriesSlug(slug);
  sidebar.onUpdate();
}

// { "CT": true, ... } — which study-type buckets are collapsed (study-type sort only)
const STUDY_TYPE_COLLAPSED_KEY = 'mri-viewer/studyTypeCollapsed/v1';

function studyTypeCollapsedMap() {
  try {
    const raw = localStorage.getItem(STUDY_TYPE_COLLAPSED_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persistStudyTypeCollapsed(groupKey, collapsed) {
  const m = studyTypeCollapsedMap();
  if (collapsed) m[groupKey] = true;
  else delete m[groupKey];
  try {
    localStorage.setItem(STUDY_TYPE_COLLAPSED_KEY, JSON.stringify(m));
  } catch {
    /* ignore quota */
  }
}

function pruneStudyTypeCollapsed(liveKeys) {
  const m = studyTypeCollapsedMap();
  let changed = false;
  for (const k of Object.keys(m)) if (!liveKeys.has(k)) { delete m[k]; changed = true; }
  if (!changed) return;
  try {
    localStorage.setItem(STUDY_TYPE_COLLAPSED_KEY, JSON.stringify(m));
  } catch {
    /* ignore quota */
  }
}

function scheduleStudiesFadeIn(seriesList, pinnedList) {
  const fade = (el) => {
    if (!el) return;
    el.classList.remove('studies-fade-in');
    if (!el.querySelector('li[data-series-slug]')) return;
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    void el.offsetWidth;
    requestAnimationFrame(() => {
      el.classList.add('studies-fade-in');
    });
  };
  fade(seriesList);
  fade(pinnedList);
}

function renderImmediateSeriesList(list, pinnedList, manifest, activeSlug) {
  list.innerHTML = '';
  if (pinnedList) pinnedList.innerHTML = '';
  sidebar.flatOrder = [];
  for (const s of manifest.series) {
    const li = createSeriesItem(s, s.slug === activeSlug, false);
    sidebar.flatOrder.push(s.slug);
    li.draggable = true;
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', dragPayload(s.slug).join(','));
      e.dataTransfer.effectAllowed = 'move';
    });
    list.appendChild(li);
  }
  wireSeriesThumbnailTooltip();
  wireSidebarOnce();
}

export async function renderProjectsSidebar(manifest, currentSeriesIdx) {
  const list = $('series-list');
  if (!list) return;

  const pinnedList = $('pinned-list');
  const hadStudyRows =
    !!list.querySelector('li[data-series-slug]')
    || !!(pinnedList && pinnedList.querySelector('li[data-series-slug]'));

  sidebar.manifest = manifest;
  const activeSlug = manifest.series[currentSeriesIdx]?.slug || '';

  // Drop in-memory state for slugs no longer in the manifest (e.g. study switch).
  // Keyed by slug: thumbCache holds pre-loaded Images, multiSel holds multi-select.
  const liveSlugs = new Set(manifest.series.map(s => s.slug));
  for (const slug of thumbCache.keys()) if (!liveSlugs.has(slug)) thumbCache.delete(slug);
  for (const slug of multiSel) if (!liveSlugs.has(slug)) multiSel.delete(slug);
  renderImmediateSeriesList(list, pinnedList, manifest, activeSlug);

  const projects = await getProjectsForRender();
  const assignedSlugs = new Set();
  projects.forEach(p => p.seriesSlugs.forEach(s => assignedSlugs.add(s)));

  const unassigned = manifest.series.filter(s => !assignedSlugs.has(s.slug));

  list.innerHTML = '';
  sidebar.flatOrder = [];

  for (const project of projects) {
    const folder = document.createElement('div');
    folder.className = 'project-folder' + (project.collapsed ? ' collapsed' : '');
    folder.dataset.projectId = project.id;

    const header = document.createElement('div');
    header.className = 'project-header';
    header.innerHTML = `
      <span class="project-toggle">
        <svg class="toggle-folder" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
        </svg>
        <svg class="toggle-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m6 9 6 6 6-6"/>
        </svg>
      </span>
      <span class="project-name">${escapeHtml(project.name)}</span>
      <button class="project-menu-btn" aria-label="Folder options">
        <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
        </svg>
      </button>
    `;

    header.addEventListener('click', (e) => {
      if (e.target.closest('.project-menu-btn')) return;
      toggleProjectCollapsed(project.id);
    });
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showFolderContextMenu(e.clientX, e.clientY, project);
    });

    const menuBtn = header.querySelector('.project-menu-btn');
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const existing = menuBtn.querySelector('.folder-menu');
      if (existing) {
        existing.remove();
        return;
      }
      showFolderMenu(menuBtn, project);
    });

    header.draggable = true;
    header.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-folder-id', project.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    folder.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('application/x-folder-id')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        folder.classList.add('drag-over');
      }
    });
    folder.addEventListener('dragleave', () => folder.classList.remove('drag-over'));
    folder.addEventListener('drop', async (e) => {
      folder.classList.remove('drag-over');
      const srcId = e.dataTransfer.getData('application/x-folder-id');
      if (!srcId || srcId === project.id) return;
      e.preventDefault();
      const ok = await swapFolderOrder(srcId, project.id);
      if (ok) sidebar.onUpdate();
    });

    folder.appendChild(header);

    if (!project.collapsed) {
      const seriesInFolder = project.seriesSlugs
        .map(slug => manifest.series.find(s => s.slug === slug))
        .filter(Boolean);
      if (sidebar.currentSort) sortSeriesArray(seriesInFolder, sidebar.currentSort);

      for (const s of seriesInFolder) {
        const li = createSeriesItem(s, s.slug === activeSlug, false);
        sidebar.flatOrder.push(s.slug);
        li.draggable = true;
        li.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', dragPayload(s.slug).join(','));
          e.dataTransfer.effectAllowed = 'move';
        });
        folder.appendChild(li);
      }
    }

    folder.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      folder.classList.add('drag-over');
    });
    folder.addEventListener('dragleave', () => folder.classList.remove('drag-over'));
    folder.addEventListener('drop', (e) => {
      e.preventDefault();
      folder.classList.remove('drag-over');
      const payload = e.dataTransfer.getData('text/plain');
      if (payload) assignSeriesToProject(payload.split(',').filter(Boolean), project.id);
    });

    list.appendChild(folder);
  }

  const pins = getPinnedSlugs();
  const pinnedSeries = pins
    .map(slug => manifest.series.find(s => s.slug === slug))
    .filter(Boolean);

  if (pinnedList) {
    pinnedList.innerHTML = '';
    for (const s of pinnedSeries) {
      const li = document.createElement('li');
      const pinnedClasses = ['pinned-row'];
      if (s.slug === activeSlug) pinnedClasses.push('active');
      if (multiSel.has(s.slug)) pinnedClasses.push('multi-selected');
      li.className = pinnedClasses.join(' ');
      li.dataset.seriesSlug = s.slug;
      li.dataset.seriesSlices = s.slices;
      sidebar.flatOrder.push(s.slug);
      li.innerHTML = `
        <button class="pin-btn" aria-label="Unpin">${PIN_ICON_SVG}</button>
        <div class="sname">${escapeHtml(s.name || '')}</div>
      `;
      li.querySelector('.pin-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        togglePin(s.slug);
      });
      li.addEventListener('mousedown', (e) => {
        if (e.shiftKey) e.preventDefault();
      });
      li.addEventListener('click', (e) => handleSeriesClick(e, s.slug));
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showSeriesContextMenu(e.clientX, e.clientY, s.slug);
      });
      pinnedList.appendChild(li);
    }
  }

  const pinnedSet = new Set(pins);
  const unpinned = unassigned.filter(s => !pinnedSet.has(s.slug));

  if (sidebar.currentSort) sortSeriesArray(unpinned, sidebar.currentSort);

  const collapsedStudy = studyTypeCollapsedMap();
  if (sidebar.currentSort === 'study-type') {
    const groups = [];
    let bucket = null;
    for (const s of unpinned) {
      const key = studyType(s);
      if (!bucket || bucket.key !== key) {
        bucket = { key, series: [] };
        groups.push(bucket);
      }
      bucket.series.push(s);
    }
    pruneStudyTypeCollapsed(new Set(groups.map(g => g.key)));
    for (const { key, series } of groups) {
      const collapsed = !!collapsedStudy[key];
      const wrap = document.createElement('div');
      wrap.className = 'study-type-group' + (collapsed ? ' collapsed' : '');
      wrap.dataset.studyTypeGroup = key;

      const header = document.createElement('div');
      header.className = 'study-type-header';
      header.setAttribute('role', 'button');
      header.setAttribute('tabindex', '0');
      header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      header.innerHTML = `
      <span class="project-toggle">
        <svg class="toggle-folder" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
        </svg>
        <svg class="toggle-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m6 9 6 6 6-6"/>
        </svg>
      </span>
      <span class="study-type-label">${escapeHtml(key)}</span>
    `;
      header.addEventListener('click', (e) => {
        if (e.target.closest('a,button')) return;
        const willCollapse = !wrap.classList.contains('collapsed');
        wrap.classList.toggle('collapsed', willCollapse);
        setFolderSeriesRowsVisible(wrap, !willCollapse);
        persistStudyTypeCollapsed(key, willCollapse);
        header.setAttribute('aria-expanded', willCollapse ? 'false' : 'true');
      });
      header.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          header.click();
        }
      });

      wrap.appendChild(header);
      for (const s of series) {
        const li = createSeriesItem(s, s.slug === activeSlug, false);
        sidebar.flatOrder.push(s.slug);
        li.draggable = true;
        li.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', dragPayload(s.slug).join(','));
          e.dataTransfer.effectAllowed = 'move';
        });
        wrap.appendChild(li);
      }
      if (collapsed) setFolderSeriesRowsVisible(wrap, false);
      list.appendChild(wrap);
    }
  } else {
    for (const s of unpinned) {
      const li = createSeriesItem(s, s.slug === activeSlug, false);
      sidebar.flatOrder.push(s.slug);
      li.draggable = true;
      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', dragPayload(s.slug).join(','));
        e.dataTransfer.effectAllowed = 'move';
      });
      list.appendChild(li);
    }
  }

  const newBtn = $('btn-new-folder');
  if (newBtn && !newBtn._wired) {
    newBtn._wired = true;
    newBtn.addEventListener('click', () => createProject());
  }
  const sortBtn = $('btn-sort-studies');
  if (sortBtn && !sortBtn._wired) {
    sortBtn._wired = true;
    sortBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showSortPopover(sortBtn, manifest);
    });
  }

  wireSeriesThumbnailTooltip();
  wireSidebarOnce();

  const hasStudyRows =
    !!list.querySelector('li[data-series-slug]')
    || !!(pinnedList && pinnedList.querySelector('li[data-series-slug]'));
  if (hasStudyRows && !hadStudyRows) {
    scheduleStudiesFadeIn(list, pinnedList);
  }
}

function wireSidebarOnce() {
  const aside = document.querySelector('aside.left');
  const scroll = document.querySelector('.series-scroll');
  if (!aside || !scroll || aside._wired) return;
  aside._wired = true;

  const clearMultiSel = () => {
    if (multiSel.size === 0) return;
    multiSel.clear();
    sidebar.lastClickedSlug = null;
    sidebar.onUpdate();
  };

  scroll.addEventListener('dragover', (e) => {
    if (e.target.closest('.project-folder')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  scroll.addEventListener('drop', (e) => {
    if (e.target.closest('.project-folder')) return;
    e.preventDefault();
    const payload = e.dataTransfer.getData('text/plain');
    if (payload) assignSeriesToProject(payload.split(',').filter(Boolean), null);
  });

  aside.addEventListener('contextmenu', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    e.preventDefault();
    showSidebarContextMenu(e.clientX, e.clientY);
  });

  aside.addEventListener('click', (e) => {
    if (e.target.closest('li[data-series-slug]')) return;
    clearMultiSel();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (document.querySelector(INTERACTIVE_UI_BLOCKING_ESCAPE)) return;
    clearMultiSel();
  });
}

function createSeriesItem(s, active, isPinned = false) {
  const li = document.createElement('li');
  const classes = [];
  if (active) classes.push('active');
  if (isPinned) classes.push('pinned');
  if (multiSel.has(s.slug)) classes.push('multi-selected');
  li.className = classes.join(' ');
  li.dataset.seriesSlug = s.slug;
  li.dataset.seriesSlices = s.slices;
  li.innerHTML = `
    <div class="sname">${escapeHtml(s.name || '')}</div>
    <div class="sdesc">${escapeHtml(s.description || '')}</div>
    <button class="pin-btn" aria-label="${isPinned ? 'Unpin' : 'Pin'}">${PIN_ICON_SVG}</button>
  `;
  li.querySelector('.pin-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    togglePin(s.slug);
  });
  li.addEventListener('mousedown', (e) => {
    if (e.shiftKey) e.preventDefault();
  });
  li.addEventListener('click', (e) => handleSeriesClick(e, s.slug));
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showSeriesContextMenu(e.clientX, e.clientY, s.slug);
  });
  return li;
}

function handleSeriesClick(e, slug) {
  if (e.metaKey || e.ctrlKey) {
    if (multiSel.has(slug)) multiSel.delete(slug);
    else multiSel.add(slug);
    sidebar.lastClickedSlug = slug;
    sidebar.onUpdate();
    return;
  }
  if (e.shiftKey && sidebar.lastClickedSlug) {
    const a = sidebar.flatOrder.indexOf(sidebar.lastClickedSlug);
    const b = sidebar.flatOrder.indexOf(slug);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) multiSel.add(sidebar.flatOrder[i]);
      sidebar.onUpdate();
      return;
    }
  }
  multiSel.clear();
  sidebar.lastClickedSlug = slug;
  const nextIdx = state.manifest.series.findIndex(series => series.slug === slug);
  if (nextIdx >= 0) sidebar.selectSeries(nextIdx);
  document.querySelector('aside.left')?.classList.remove('mobile-open');
  document.getElementById('mobile-backdrop')?.classList.remove('visible');
}

function dragPayload(slug) {
  if (multiSel.has(slug) && multiSel.size > 1) return [...multiSel];
  return [slug];
}

function wireSeriesThumbnailTooltip() {
  const tip = document.getElementById('series-thumb-tip');
  const scroll = document.querySelector('.series-scroll');
  if (!scroll || !tip || scroll._thumbWired) return;
  scroll._thumbWired = true;

  const img = tip.querySelector('img');
  const label = tip.querySelector('.thumb-label');
  let hideTimer = null;
  let currentSlug = null;

  scroll.addEventListener('mouseover', (e) => {
    const li = e.target.closest?.('li[data-series-slug]');
    if (!li) return;
    clearTimeout(hideTimer);
    if (li.dataset.seriesSlug === currentSlug) return;
    showThumb(li);
  });

  scroll.addEventListener('mouseout', (e) => {
    const li = e.target.closest?.('li[data-series-slug]');
    if (li) {
      hideTimer = setTimeout(hideThumb, 100);
    }
  });

  const sidebarEl = scroll.closest('aside');
  if (sidebarEl) {
    sidebarEl.addEventListener('mouseleave', () => {
      clearTimeout(hideTimer);
      hideThumb();
    });
  }

  function showThumb(li) {
    const slug = li.dataset.seriesSlug;
    const slices = parseInt(li.dataset.seriesSlices, 10) || 1;
    const midIdx = Math.floor(slices / 2);
    currentSlug = slug;

    const series = sidebar.manifest?.series?.find(s => s.slug === slug);
    const url = imageUrlForStack(slug, midIdx, series);

    if (thumbCache.has(slug)) {
      img.src = thumbCache.get(slug).src;
    } else {
      const cached = new Image();
      cached.src = url;
      thumbCache.set(slug, cached);
      img.src = url;
    }

    label.textContent = `Slice ${midIdx + 1} / ${slices}`;

    const r = li.getBoundingClientRect();
    const asideEl = li.closest('aside');
    const sidebarRight = asideEl ? asideEl.getBoundingClientRect().right : r.right;
    tip.style.left = `${sidebarRight + 8}px`;
    tip.style.top = `${Math.max(8, r.top + r.height / 2 - 90)}px`;
    tip.classList.add('visible');
  }

  function hideThumb() {
    tip.classList.remove('visible');
    currentSlug = null;
  }
}
