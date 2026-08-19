const listeners = new Set();

const session = {
  mode: false,
  pen: false,
  marquee: null,
  history: [],
};

function emit() {
  for (const fn of listeners) fn(session);
}

export function getAskSession() {
  return session;
}

export function subscribeAsk(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setAskMode(enabled) {
  session.mode = !!enabled;
  if (!session.mode) {
    session.marquee = null;
    session.pen = false;
  }
  emit();
  return session.mode;
}

export function setAskPen(enabled) {
  session.pen = !!enabled && session.mode;
  emit();
  return session.pen;
}

export function setAskMarquee(marquee) {
  session.marquee = marquee ? { ...marquee } : null;
  emit();
  return session.marquee;
}

export function setAskHistory(entries) {
  session.history = Array.isArray(entries) ? entries : [];
  emit();
  return session.history;
}
