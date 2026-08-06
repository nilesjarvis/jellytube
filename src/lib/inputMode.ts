const tvInputQuery = window.matchMedia('(hover: none) and (pointer: coarse)');

// TV browsers (LG webOS, Samsung Tizen) report a coarse pointer with no hover
// and do not expose touch events. Phones and tablets also match the media
// query but do expose touch, so they keep the touch-oriented behavior.
export function prefersTvInput() {
  return tvInputQuery.matches && !('ontouchstart' in window);
}

export function applyTvInputClass() {
  document.documentElement.classList.toggle('tv-input', prefersTvInput());
}

export function onTvInputChange(listener: () => void) {
  const onChange = () => listener();
  tvInputQuery.addEventListener('change', onChange);
  return () => tvInputQuery.removeEventListener('change', onChange);
}
