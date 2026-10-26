import { createElement, type IconNode } from 'lucide';
import { t } from '../i18n';

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;

/** Tiny element builder: h('div.cls#id', {title: 'x', onclick: fn}, ...children). */
export function h<K extends keyof HTMLElementTagNameMap>(sel: K | `${K}.${string}` | `${K}#${string}`, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const m = /^([a-z0-9-]+)((?:[.#][\w-]+)*)$/i.exec(sel);
  const tag = (m ? m[1] : sel) as K;
  const el = document.createElement(tag);
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g) ?? []) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (v === true) el.setAttribute(k, '');
    else if (k in el && typeof v !== 'boolean' && k !== 'list' && k !== 'form') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function icon(node: IconNode, size = 20): SVGElement {
  const el = createElement(node, { width: size, height: size, 'stroke-width': 1.8, 'aria-hidden': 'true' });
  el.classList.add('icon');
  return el;
}

export function iconButton(node: IconNode, label: string, onclick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  const b = h('button', { class: `icon-btn ${cls}`.trim(), type: 'button', title: label, 'aria-label': label });
  b.append(icon(node));
  b.addEventListener('click', onclick);
  return b;
}

// ---- toasts ----

let toastHost: HTMLElement | null = null;

export function toast(msg: string, kind: 'info' | 'error' | 'success' = 'info', ms = 3200): void {
  if (!toastHost) {
    toastHost = h('div.toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const el = h('div', { class: `toast toast-${kind}` }, msg);
  toastHost.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

// ---- modal dialogs ----

export interface DialogAction<T> {
  label: string;
  value: T | (() => T | undefined | Promise<T | undefined>);
  primary?: boolean;
  danger?: boolean;
}

export interface DialogOptions<T> {
  title: string;
  body?: Node | string;
  actions?: DialogAction<T>[];
  wide?: boolean;
  /** Value resolved when the dialog is dismissed (Escape, backdrop, close button). */
  dismissValue?: T;
  onOpen?: (dlg: HTMLElement) => void;
}

const stack: HTMLElement[] = [];

export function dialog<T>(opts: DialogOptions<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    const backdrop = h('div.modal-backdrop');
    const box = h('div', { class: `modal${opts.wide ? ' modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title });
    const close = () => finish(opts.dismissValue);
    const header = h('div.modal-header', {}, h('h2', {}, opts.title));
    const closeBtn = h('button.icon-btn', { type: 'button', title: t('close'), 'aria-label': t('close'), onclick: close }, '✕');
    header.append(closeBtn);
    const body = h('div.modal-body');
    if (opts.body) body.append(opts.body);
    box.append(header, body);
    let done = false;
    const finish = (v: T | undefined) => {
      if (done) return;
      done = true;
      backdrop.remove();
      stack.splice(stack.indexOf(backdrop), 1);
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    if (opts.actions?.length) {
      const footer = h('div.modal-footer');
      for (const a of opts.actions) {
        const btn = h('button', { type: 'button', class: `btn${a.primary ? ' btn-primary' : ''}${a.danger ? ' btn-danger' : ''}` }, a.label);
        btn.addEventListener('click', async () => {
          if (typeof a.value === 'function') {
            const v = await (a.value as () => T | undefined | Promise<T | undefined>)();
            if (v !== undefined) finish(v);
          } else finish(a.value);
        });
        footer.append(btn);
      }
      box.append(footer);
    }
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== backdrop) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
        const primary = box.querySelector<HTMLButtonElement>('.modal-footer .btn-primary');
        if (primary) {
          e.preventDefault();
          primary.click();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) close();
    });
    backdrop.append(box);
    document.body.append(backdrop);
    stack.push(backdrop);
    opts.onOpen?.(box);
    const first = box.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select');
    (first ?? box.querySelector<HTMLElement>('.btn-primary'))?.focus();
  });
}

export async function confirmDialog(message: string, okLabel = t('ok'), danger = false): Promise<boolean> {
  const r = await dialog<boolean>({
    title: t('appName'),
    body: h('p', {}, message),
    actions: [
      { label: t('cancel'), value: false },
      { label: okLabel, value: true, primary: !danger, danger },
    ],
    dismissValue: false,
  });
  return !!r;
}

export async function promptDialog(title: string, label: string, value = '', type = 'text', okLabel = t('ok')): Promise<string | null> {
  const input = h('input', { type, value, class: 'input', autocomplete: type === 'password' ? 'current-password' : 'off' });
  const r = await dialog<string | null>({
    title,
    body: h('label.field', {}, h('span', {}, label), input),
    actions: [
      { label: t('cancel'), value: null },
      { label: okLabel, value: () => input.value, primary: true },
    ],
    dismissValue: null,
  });
  return r ?? null;
}

export function field(label: string, control: HTMLElement): HTMLLabelElement {
  return h('label.field', {}, h('span', {}, label), control);
}

export function select(options: [string, string][], value: string): HTMLSelectElement {
  const s = h('select.input');
  for (const [v, l] of options) s.append(new Option(l, v, false, v === value));
  return s;
}

// ---- popup menus ----

export interface MenuItem {
  label: string;
  icon?: IconNode;
  action: () => void;
  checked?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  /** Starts a titled section. */
  section?: string;
  /** Right-aligned secondary text, e.g. a keyboard shortcut. */
  hint?: string;
}

export function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
  document.querySelector('.menu')?.remove();
  const menu = h('div.menu', { role: 'menu' });
  items.forEach((it, i) => {
    if (it.section) {
      if (i > 0) menu.append(h('div.menu-sep'));
      menu.append(h('div.menu-section', { role: 'presentation' }, it.section));
    } else if (it.separatorBefore) menu.append(h('div.menu-sep'));
    const b = h('button.menu-item', { type: 'button', role: it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem', disabled: !!it.disabled });
    if (it.checked !== undefined) b.setAttribute('aria-checked', String(it.checked));
    b.append(it.icon ? icon(it.icon, 18) : h('span.menu-icon-pad'), h('span.menu-label', {}, it.label));
    if (it.hint) b.append(h('span.menu-hint', {}, it.hint));
    if (it.checked) b.append(h('span.menu-check', {}, '✓'));
    b.addEventListener('click', () => {
      cleanup();
      it.action();
    });
    menu.append(b);
  });
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = Math.min(window.innerWidth - mw - 8, Math.max(8, r.right - mw));
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  if (r.left < 120 && r.right - mw < 8) left = Math.max(8, r.left);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  const onDown = (e: Event) => {
    if (!menu.contains(e.target as Node)) cleanup();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      cleanup();
      anchor.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const list = Array.from(menu.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)'));
      const i = list.indexOf(document.activeElement as HTMLButtonElement);
      list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
    }
  };
  const cleanup = () => {
    menu.remove();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  });
  menu.querySelector<HTMLElement>('.menu-item')?.focus();
}

export function downloadBlob(blob: Blob, name: string): void {
  // Inside the Android app there is no download manager: write to Documents instead.
  if ((window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()) {
    void import('../features/native')
      .then((m) => m.nativeSave(blob, name))
      .then((path) => path && toast(t('savedTo', { path }), 'success', 5000))
      .catch((e) => toast(String((e as Error)?.message ?? e), 'error'));
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, style: 'display:none' });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 4000);
}

export function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: 'display:none' });
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

export function busy(on: boolean, label = t('loading')): void {
  let el = document.getElementById('busy');
  if (on) {
    if (!el) {
      el = h('div#busy', {}, h('div.spinner'), h('span', {}, label));
      document.body.append(el);
    } else el.querySelector('span')!.textContent = label;
  } else el?.remove();
}
