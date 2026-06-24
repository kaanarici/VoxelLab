function applyDesktopWindowState(state = {}) {
  const root = document.documentElement;
  const mac = state.platform === 'darwin';
  root.classList.add('desktop-runtime');
  root.classList.toggle('desktop-macos', mac);
  root.classList.toggle('desktop-fullscreen', Boolean(state.fullscreen));
  const inset = Number(state.trafficLightInset || 0);
  if (mac && inset > 0) root.style.setProperty('--desktop-window-control-inset', `${inset}px`);
  else root.style.removeProperty('--desktop-window-control-inset');
}

export function initDesktopWindowChrome() {
  const desktop = globalThis.voxellabDesktop;
  if (!desktop?.getWindowState) return;
  const refresh = () => desktop.getWindowState().then(applyDesktopWindowState).catch(() => {});
  desktop.getWindowState().then(applyDesktopWindowState).catch(() => {});
  desktop.onWindowStateChanged?.(applyDesktopWindowState);
  window.addEventListener('resize', refresh);
  document.addEventListener('visibilitychange', refresh);
}
