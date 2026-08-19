// Shell-only DOM: mobile drawers, desktop column collapse.
import { initMobileShell } from './shell-mobile.js';
import { initToolbarScrubberResize } from './toolbar-scrubber-resize.js';

initMobileShell();
// Toolbar markup is injected after initDesktopSidebarToggles(); wire the handle here.
initToolbarScrubberResize();
