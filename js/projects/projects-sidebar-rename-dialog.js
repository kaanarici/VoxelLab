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
    <label class="project-rename-label" for="project-rename-input">Folder name</label>
    <input type="text" id="project-rename-input" class="project-rename-dialog-input" value="${escapeHtml(project.name)}" aria-describedby="project-rename-error" />
    <div id="project-rename-error" class="project-rename-error" role="status"></div>
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
    if (!newName) {
      input.setAttribute('aria-invalid', 'true');
      card.querySelector('.project-rename-error').textContent = 'Enter a folder name.';
      input.focus();
      return;
    }
    input.removeAttribute('aria-invalid');
    card.querySelector('.project-rename-error').textContent = '';
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
  overlay.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void save();
    }
  });
}
