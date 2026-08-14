const WIRED_RAILS = new WeakSet();

export function initHorizontalScrollFades(wrap, rail) {
  if (!wrap || !rail || WIRED_RAILS.has(rail)) return;
  WIRED_RAILS.add(rail);

  let frame = 0;
  const update = () => {
    frame = 0;
    const max = rail.scrollWidth - rail.clientWidth;
    const left = rail.scrollLeft;
    wrap.classList.toggle('has-overflow-left', left > 1);
    wrap.classList.toggle('has-overflow-right', left < max - 1);
  };
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(update);
  };

  rail.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(schedule).observe(rail);
  requestAnimationFrame(() => requestAnimationFrame(update));
  setTimeout(update, 120);
}
