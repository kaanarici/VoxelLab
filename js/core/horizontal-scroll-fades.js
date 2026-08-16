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

  const revealFocusedControl = (event) => {
    const target = event.target;
    if (!(target instanceof Element) || !rail.contains(target)) return;
    const railRect = rail.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    let nextLeft = rail.scrollLeft;
    if (targetRect.left < railRect.left) {
      nextLeft -= railRect.left - targetRect.left;
    } else if (targetRect.right > railRect.right) {
      nextLeft += targetRect.right - railRect.right;
    }
    if (nextLeft !== rail.scrollLeft) rail.scrollTo({ left: nextLeft, behavior: 'instant' });
    schedule();
  };

  rail.addEventListener('scroll', schedule, { passive: true });
  rail.addEventListener('focusin', revealFocusedControl);
  window.addEventListener('resize', schedule);
  const Observer = globalThis.ResizeObserver;
  if (Observer) new Observer(schedule).observe(rail);
  requestAnimationFrame(() => requestAnimationFrame(update));
  setTimeout(update, 120);
}
