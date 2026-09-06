export function syncThemeIcons() {
  if (!globalThis.document) return;
  const isLight = document.documentElement.classList.contains('light');
  const sun = document.getElementById('theme-icon-sun');
  const moon = document.getElementById('theme-icon-moon');
  if (sun) sun.classList.toggle('theme-icon-hidden', isLight);
  if (moon) moon.classList.toggle('theme-icon-hidden', !isLight);
}
