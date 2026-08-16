(function () {
  var theme = localStorage.getItem('mri-viewer-theme');
  if (theme === 'light') document.documentElement.classList.add('light');
  try {
    var raw = localStorage.getItem('mri-viewer/shellLayout/v1');
    if (!raw) return;
    var layout = JSON.parse(raw);
    if (layout.leftCollapsed?.constructor !== Boolean || layout.rightCollapsed?.constructor !== Boolean) return;
    if (layout.leftCollapsed) document.documentElement.setAttribute('data-shell-left-collapsed', 'true');
    if (layout.rightCollapsed) document.documentElement.setAttribute('data-shell-right-collapsed', 'true');
    if (Number.isFinite(layout.leftWidth)) {
      var cs = getComputedStyle(document.documentElement);
      var min = parseFloat(cs.getPropertyValue('--rail-left-min'));
      var max = parseFloat(cs.getPropertyValue('--rail-right-w'));
      if (!Number.isFinite(min)) min = 208;
      if (!Number.isFinite(max)) max = 312;
      var w = Math.round(layout.leftWidth);
      if (w < min) w = min;
      if (w > max) w = max;
      document.documentElement.style.setProperty('--rail-left-w', w + 'px');
    }
  } catch {
    /* ignore */
  }
})();
