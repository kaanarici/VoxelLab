  import { initHorizontalScrollFades } from './horizontal-scroll-fades.js';

  const MOBILE_MQ = '(max-width: 1100px)';

  export function initMobileShell() {
    const left = document.querySelector('aside.left');
    const right = document.querySelector('aside.right');
    const backdrop = document.getElementById('mobile-backdrop');
    const btnShowLeft = document.getElementById('btn-show-left');
    const btnShowRight = document.getElementById('btn-show-right');
    const btnToggleLeft = document.getElementById('btn-toggle-left');
    const btnClosePanel = document.getElementById('btn-close-panel');
    if (!left || !right || !backdrop) return;

    const isMobile = () => window.matchMedia(MOBILE_MQ).matches;

    const closeAll = () => {
      left.classList.remove('mobile-open');
      right.classList.remove('mobile-open');
      backdrop.classList.remove('visible');
    };

    const openLeft = () => {
      closeAll();
      left.classList.add('mobile-open');
      backdrop.classList.add('visible');
    };
    const openRight = () => {
      closeAll();
      right.classList.add('mobile-open');
      backdrop.classList.add('visible');
    };

    btnShowLeft?.addEventListener('click', () => {
      if (!isMobile()) return;
      left.classList.contains('mobile-open') ? closeAll() : openLeft();
    });
    btnShowRight?.addEventListener('click', () => {
      if (!isMobile()) return;
      right.classList.contains('mobile-open') ? closeAll() : openRight();
    });

    btnToggleLeft?.addEventListener('click', () => {
      if (isMobile() && left.classList.contains('mobile-open')) closeAll();
    });
    btnClosePanel?.addEventListener('click', closeAll);
    backdrop.addEventListener('click', closeAll);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAll();
    });

    window.addEventListener('resize', () => {
      if (!isMobile()) closeAll();
    });

    const wrap = document.getElementById('tool-rail-wrap');
    const rail = document.getElementById('tool-rail');
    initHorizontalScrollFades(wrap, rail);
  }
