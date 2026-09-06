import { loadTemplate } from './template-loader.js';
import { initDesktopSidebarToggles } from './shell/shell-layout-toggles.js';
import { syncThemeIcons } from './theme-icons.js';

if (globalThis.voxellabDesktop?.getWindowState) {
  const { initDesktopWindowChrome } = await import('./shell/desktop-window-chrome.js');
  initDesktopWindowChrome();
}

await Promise.all([
  loadTemplate('./templates/sidebar.html', 'left-shell-root'),
  loadTemplate('./templates/viewer-shell.html', 'main-shell-root'),
  loadTemplate('./templates/panels.html', 'right-panels-root'),
  loadTemplate('./templates/command-palette.html', 'cmdk-root'),
  loadTemplate('./templates/modals-shell.html', 'modal-root'),
]);

initDesktopSidebarToggles();

syncThemeIcons();

const { wireCollapsiblePanels } = await import('./collapsible-sidebar.js');
wireCollapsiblePanels();

await loadTemplate('./templates/toolbar.html', 'toolbar-root');

await import('./shell/chrome-shell.js');
await import('../viewer.js');
