// Persist and restore the main window's size, position, and maximized/fullscreen
// state across launches. Bounds are validated against the current displays so a
// window saved on a now-disconnected monitor never restores off-screen.
import { screen } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_BOUNDS = Object.freeze({ width: 1440, height: 960 });
const MIN_SIZE = Object.freeze({ width: 1024, height: 720 });

function stateFile(app) {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readState(app) {
  try {
    return JSON.parse(readFileSync(stateFile(app), 'utf8'));
  } catch {
    return null;
  }
}

function boundsOnScreen(bounds) {
  if (!bounds || !Number.isInteger(bounds.x) || !Number.isInteger(bounds.y)) return false;
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return bounds.x < area.x + area.width
      && bounds.x + bounds.width > area.x
      && bounds.y < area.y + area.height
      && bounds.y + bounds.height > area.y;
  });
}

// Bounds + flags to pass into `new BrowserWindow(...)`. Size is always honored
// (clamped to the minimum); position is only restored when still on a display.
export function restoredWindowOptions(app) {
  const state = readState(app);
  const width = Math.max(MIN_SIZE.width, Math.round(Number(state?.width) || DEFAULT_BOUNDS.width));
  const height = Math.max(MIN_SIZE.height, Math.round(Number(state?.height) || DEFAULT_BOUNDS.height));
  const options = { width, height };
  if (state && boundsOnScreen({ x: state.x, y: state.y, width, height })) {
    options.x = state.x;
    options.y = state.y;
  }
  return { options, maximized: Boolean(state?.isMaximized), fullScreen: Boolean(state?.isFullScreen) };
}

function debounce(fn, ms) {
  let timer = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

// Save the window's normal (non-maximized) bounds plus the maximized/fullscreen
// flags, debounced on resize/move and flushed on state changes and close.
export function trackWindowState(window, app) {
  let normalBounds = window.getBounds();
  const persist = () => {
    if (window.isDestroyed()) return;
    if (!window.isMaximized() && !window.isFullScreen() && !window.isMinimized()) {
      normalBounds = window.getBounds();
    }
    try {
      mkdirSync(app.getPath('userData'), { recursive: true });
      writeFileSync(stateFile(app), JSON.stringify({
        ...normalBounds,
        isMaximized: window.isMaximized(),
        isFullScreen: window.isFullScreen(),
      }));
    } catch {
      // Best-effort; a transient write failure must never break the window.
    }
  };
  const debounced = debounce(persist, 400);
  window.on('resize', debounced);
  window.on('move', debounced);
  window.on('maximize', persist);
  window.on('unmaximize', persist);
  window.on('enter-full-screen', persist);
  window.on('leave-full-screen', persist);
  window.on('close', persist);
}
