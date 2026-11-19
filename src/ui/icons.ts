// A small, consistent stroke icon set (24 × 24 grid, drawn with currentColor).
const P: Record<string, string> = {
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  upload: '<path d="M12 16V5"/><path d="m7 10 5-5 5 5"/><path d="M5 20h14"/>',
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
  filePlus: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 11v6M9 14h6"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7 14h10"/>',
  printer: '<path d="M7 9V3.5h10V9"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v6.5H7z"/>',
  camera: '<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H8l1.6-2h4.8L16 6h1.5A2.5 2.5 0 0 1 20 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.75" r="3.5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7"/><path d="M9 7V4.5h6V7"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
  rotateCcw: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4v5h5"/>',
  rotateCw: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4v5h-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  square: '<rect x="4" y="6.5" width="16" height="11" rx="1.5"/>',
  circle: '<circle cx="12" cy="12" r="7.5"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M3 12h18M12 3v18"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M12 4v16"/>',
  cube: '<path d="M12 2.8 3.8 7.4v9.2L12 21.2l8.2-4.6V7.4z"/><path d="M3.8 7.4 12 12l8.2-4.6M12 12v9.2"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  wand: '<path d="m4 20 10.5-10.5"/><path d="m13 6.5 1.5 1.5"/><path d="M17.5 3v3M16 4.5h3M20 9v2M19 10h2M10 3v2M9 4h2"/>',
  alert: '<path d="M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5h.01"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  eraser: '<path d="M8 20 3.5 15.5a1.5 1.5 0 0 1 0-2.1L13.4 3.5a1.5 1.5 0 0 1 2.1 0l5 5a1.5 1.5 0 0 1 0 2.1L11 20z"/><path d="M8 20h12M8.5 9.5l6 6"/>',
  brush: '<path d="M4 20c2.5 0 4-1.5 4-3.5a2.5 2.5 0 0 0-5 0c0 .8-.3 2.2-1 3.5z" transform="translate(1 -1)"/><path d="m10.5 13.5 9-9a1.6 1.6 0 0 0-2.3-2.3l-9 9"/>',
  pointer: '<path d="M5 3.5 18.5 10l-6 1.8-2 6.2z"/>',
  notch: '<path d="M3 8h5.5a3.5 3.5 0 0 0 7 0H21v11H3z"/>',
  zone: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="7.5" y="9" width="6" height="6" rx="1"/>',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-4.6-2.2L3 15a1.6 1.6 0 0 1 2.4-2.1L8 15"/>',
  save: '<path d="M5 3h11l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a1 1 0 0 1 1-1z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>',
};

/** SVG markup for an icon. */
export function icon(name: string, cls = ''): string {
  return `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] ?? ''}</svg>`;
}

/** Replaces every <i data-icon="name"> (or any element with data-icon) under root with the icon. */
export function hydrateIcons(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    const svg = icon(el.dataset.icon!, el.className);
    if (el.tagName === 'I') el.outerHTML = svg;
    else {
      el.innerHTML = svg;
      el.removeAttribute('data-icon');
    }
  });
}
