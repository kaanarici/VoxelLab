const selectUis = new WeakMap();
let listenersReady = false;

export function enhanceSelectLikeDropdowns(root = document) {
  root.querySelectorAll?.('select.select-like').forEach(enhanceSelectLikeDropdown);
}

function enhanceSelectLikeDropdown(select) {
  let ui = selectUis.get(select);
  if (!ui) {
    ui = buildSelectUi(select);
    selectUis.set(select, ui);
  }
  syncSelectUi(select, ui);
}

function buildSelectUi(select) {
  const wrap = document.createElement('div');
  wrap.className = 'select-dropdown';
  select.before(wrap);
  wrap.append(select);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'select-dropdown-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const label = document.createElement('span');
  label.className = 'select-dropdown-label';
  const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chevron.classList.add('select-dropdown-chevron');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', 'icons.svg#i-chevron-down');
  chevron.append(use);
  trigger.append(label, chevron);

  const menu = document.createElement('div');
  menu.className = 'select-dropdown-menu';
  menu.setAttribute('role', 'listbox');
  wrap.append(trigger, menu);

  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.addEventListener('change', () => syncSelectUi(select, { wrap, trigger, menu }));
  select.addEventListener('focus', () => trigger.focus());
  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    if (select.disabled) return;
    closeSelectDropdowns(wrap);
    setOpen(wrap, trigger, !wrap.classList.contains('open'));
  });
  ensureDocumentListeners();
  return { wrap, trigger, menu };
}

function syncSelectUi(select, ui) {
  const { wrap, trigger, menu } = ui;
  const label = trigger.querySelector('.select-dropdown-label');
  const selected = select.selectedOptions?.[0] || select.options?.[select.selectedIndex];
  label.textContent = selected?.textContent || '';
  trigger.disabled = select.disabled;
  trigger.setAttribute('aria-label', select.getAttribute('aria-label') || label.textContent || 'Select');
  menu.replaceChildren(...Array.from(select.options).map((option) => optionButton(select, ui, option)));
  wrap.classList.toggle('disabled', select.disabled);
}

function optionButton(select, ui, option) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'select-dropdown-item';
  item.textContent = option.textContent;
  item.disabled = option.disabled;
  item.setAttribute('role', 'option');
  item.setAttribute('aria-selected', option.selected ? 'true' : 'false');
  if (option.selected) item.classList.add('active');
  item.addEventListener('click', (event) => {
    event.stopPropagation();
    if (option.disabled || select.value === option.value) {
      setOpen(ui.wrap, ui.trigger, false);
      return;
    }
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    setOpen(ui.wrap, ui.trigger, false);
  });
  return item;
}

function ensureDocumentListeners() {
  if (listenersReady) return;
  listenersReady = true;
  document.addEventListener('click', () => closeSelectDropdowns());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSelectDropdowns();
  });
}

function closeSelectDropdowns(except = null) {
  document.querySelectorAll('.select-dropdown.open').forEach((wrap) => {
    if (wrap !== except) setOpen(wrap, wrap.querySelector('.select-dropdown-trigger'), false);
  });
}

function setOpen(wrap, trigger, open) {
  wrap.classList.toggle('open', open);
  trigger?.setAttribute('aria-expanded', open ? 'true' : 'false');
}
