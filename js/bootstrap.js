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

// Move theme / show-panel controls into the correct host before first paint (chrome-shell runs later).
initDesktopSidebarToggles();
// Match sun/moon to html.light (theme-init.js) after the button is in its final host.
syncThemeIcons();

// Apply persisted collapse state before viewer init paints — avoids collapsed/expanded flash on reload.
const { wireCollapsiblePanels } = await import('./collapsible-sidebar.js');
wireCollapsiblePanels();

await loadTemplate('./templates/toolbar.html', 'toolbar-root');

await import('./shell/chrome-shell.js');
await import('../viewer.js');
