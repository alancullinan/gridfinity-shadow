export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

/** Formats a number for display: at most `digits` decimals, no trailing zeros. */
export const fmt = (v: number, digits = 1) => String(Math.round(v * 10 ** digits) / 10 ** digits);

/**
 * Re-renders a container while keeping keyboard focus (and the caret in text boxes) on the
 * element with the same data-key, and keeping the scroll position.
 */
export function renderKeepingFocus(container: HTMLElement, render: () => void) {
  const active = document.activeElement as HTMLElement | null;
  const key = active && container.contains(active) ? active.dataset.key : undefined;
  let caret: [number | null, number | null] | null = null;
  if (key && active instanceof HTMLInputElement && active.type === 'text') caret = [active.selectionStart, active.selectionEnd];
  const scroll = container.scrollTop;
  render();
  container.scrollTop = scroll;
  if (!key) return;
  const el = container.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
  if (!el) return;
  el.focus({ preventScroll: true });
  if (caret && el instanceof HTMLInputElement) el.setSelectionRange(caret[0], caret[1]);
}

/** True when the keyboard event is aimed at a place where typing happens. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && !['checkbox', 'radio', 'range', 'button', 'file'].includes(target.type);
}

export function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** File-name-safe version of a design or item name. */
export const safeName = (s: string, fallback = 'design') => s.replace(/[^\w -]+/g, '_').trim() || fallback;
