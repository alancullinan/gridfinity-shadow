import { icon } from './icons';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

/** Shows a short message at the bottom of the screen. */
export function toast(message: string, kind: ToastKind = 'info', ms = 3600) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = `${icon(kind === 'success' ? 'check' : kind === 'info' ? 'info' : 'alert')}<span></span>`;
  el.querySelector('span')!.textContent = message;
  host.appendChild(el);
  while (host.children.length > 3) host.firstElementChild!.remove();
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, ms);
}
