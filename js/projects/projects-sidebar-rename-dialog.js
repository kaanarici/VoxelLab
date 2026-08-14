// Modal dialog for renaming a project folder. Focus-trapped overlay.

import { escapeHtml, trapFocus, releaseFocus } from '../dom.js';
import { renameProject } from './projects-sidebar-state.js';

export function showRenameDialog(project) {
  const overlay = document.createElement('div');
  overlay.className = 'project-rename-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'project-rename-title');

  const card = document.createElement('div');
  card.className = 'project-rename-card';

  card.innerHTML = `
    <div id="project-rename-title" class="project-rename-title">Rename folder</div>
    <input type="text" class="project-rename-dialog-input" value="${escapeHtml(project.name)}" />
    <div class="project-rename-actions">
      <button type="button" class="annot-btn rename-cancel">Cancel</button>
      <button type="button" class="annot-btn primary rename-save">Save</button>
    </div>
  `;

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  const input = card.querySelector('input');
  trapFocus(overlay);
  input.focus();
  input.select();

  const close = () => { releaseFocus(overlay); overlay.remove(); };
  const save = async () => {
    const newName = input.value.trim();
    const renamed = newName && newName !== project.name;
    if (renamed) {
      await renameProject(project.id, newName);
    }
    close();
    if (renamed) {
      document.querySelector(`[data-project-id="${project.id}"] .project-menu-btn`)?.focus();
    }
  };

  card.querySelector('.rename-cancel').addEventListener('click', close);
  card.querySelector('.rename-save').addEventListener('click', () => void save());
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void save();
    }
    if (e.key === 'Escape') close();
  });
}
