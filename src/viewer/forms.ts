// Interactive layer for fillable form fields and hyperlinks. Field values are
// kept in the store (by field name) and written into the PDF on save.
import { store } from '../store';
import type { FormValue } from '../model';

type PageViewport = { convertToViewportPoint(x: number, y: number): number[]; scale: number };

// The subset of pdf.js annotation data used here.
export interface AnnotData {
  subtype: string;
  rect: number[];
  id?: string;
  fieldType?: string;
  fieldName?: string;
  fieldValue?: string | string[];
  readOnly?: boolean;
  hidden?: boolean;
  multiLine?: boolean;
  maxLen?: number;
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  exportValue?: string;
  buttonValue?: string;
  options?: { exportValue: string; displayValue: string }[];
  combo?: boolean;
  multiSelect?: boolean;
  textAlignment?: number;
  comb?: boolean;
  password?: boolean;
  defaultAppearanceData?: { fontSize?: number };
  url?: string;
  unsafeUrl?: string;
  dest?: unknown;
  action?: string;
}

export interface LinkHandler {
  (dest: unknown): void;
}

function viewRect(vp: PageViewport, rect: number[]) {
  const [x1, y1] = vp.convertToViewportPoint(rect[0], rect[1]);
  const [x2, y2] = vp.convertToViewportPoint(rect[2], rect[3]);
  return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

export function currentValue(a: AnnotData): FormValue {
  const name = a.fieldName ?? '';
  const v = store.state.form[name];
  if (v !== undefined) return v;
  return a.fieldValue ?? '';
}

function setValue(name: string, value: FormValue, final: boolean): void {
  if (final) {
    store.updateTransient('form', (s) => (s.form[name] = value));
    store.endTransient();
  } else {
    store.updateTransient('form', (s) => (s.form[name] = value));
  }
}

export function buildFormLayer(
  container: HTMLElement,
  annots: AnnotData[],
  vp: PageViewport,
  interactiveForms: boolean,
  onLink: LinkHandler,
): void {
  container.replaceChildren();
  for (const a of annots) {
    if (a.hidden) continue;
    const box = viewRect(vp, a.rect);
    if (box.width < 2 || box.height < 2) continue;
    if (a.subtype === 'Link') {
      const link = document.createElement('a');
      link.className = 'pdf-link';
      Object.assign(link.style, px(box));
      const url = a.url ?? a.unsafeUrl;
      if (url) {
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.title = url;
      } else if (a.dest !== undefined) {
        link.href = '#';
        link.addEventListener('click', (e) => {
          e.preventDefault();
          onLink(a.dest);
        });
      } else continue;
      container.appendChild(link);
      continue;
    }
    if (!interactiveForms || a.subtype !== 'Widget' || !a.fieldName) continue;
    const el = buildField(a, box.height, vp.scale);
    if (!el) continue;
    el.classList.add('form-field');
    el.dataset.field = a.fieldName;
    Object.assign(el.style, px(box));
    container.appendChild(el);
  }
}

function px(b: { left: number; top: number; width: number; height: number }) {
  return { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` };
}

function buildField(a: AnnotData, height: number, scale: number): HTMLElement | null {
  const name = a.fieldName!;
  const value = currentValue(a);
  const fontSize = a.defaultAppearanceData?.fontSize
    ? Math.max(6, a.defaultAppearanceData.fontSize * scale)
    : Math.max(8, Math.min(height * 0.7, 14 * scale));
  if (a.fieldType === 'Tx') {
    const input = a.multiLine ? document.createElement('textarea') : document.createElement('input');
    if (input instanceof HTMLInputElement) input.type = a.password ? 'password' : 'text';
    input.value = Array.isArray(value) ? value.join(', ') : value;
    if (a.maxLen) input.maxLength = a.maxLen;
    input.disabled = !!a.readOnly;
    input.style.fontSize = `${a.defaultAppearanceData?.fontSize === 0 ? Math.min(height * 0.7, 14 * scale) : fontSize}px`;
    input.style.textAlign = ['left', 'center', 'right'][a.textAlignment ?? 0] ?? 'left';
    input.addEventListener('input', () => setValue(name, input.value, false));
    input.addEventListener('change', () => setValue(name, input.value, true));
    return input;
  }
  if (a.fieldType === 'Btn') {
    if (a.pushButton) return null;
    const input = document.createElement('input');
    if (a.radioButton) {
      input.type = 'radio';
      input.name = `radio:${name}`;
      input.value = a.buttonValue ?? '';
      input.checked = value === a.buttonValue;
      input.addEventListener('change', () => input.checked && setValue(name, a.buttonValue ?? '', true));
    } else {
      input.type = 'checkbox';
      const on = a.exportValue ?? 'Yes';
      input.dataset.on = on;
      input.checked = value !== '' && value !== 'Off' && (value === on || !a.exportValue);
      input.addEventListener('change', () => setValue(name, input.checked ? on : 'Off', true));
    }
    input.disabled = !!a.readOnly;
    return input;
  }
  if (a.fieldType === 'Ch') {
    const sel = document.createElement('select');
    const values = Array.isArray(value) ? value : [value];
    if (!a.combo) {
      sel.multiple = !!a.multiSelect;
      sel.size = Math.max(2, Math.min(a.options?.length ?? 2, 6));
    }
    if (a.combo) sel.appendChild(new Option('', ''));
    for (const o of a.options ?? []) {
      const opt = new Option(o.displayValue || o.exportValue, o.exportValue);
      opt.selected = values.includes(o.exportValue) || values.includes(o.displayValue);
      sel.appendChild(opt);
    }
    sel.disabled = !!a.readOnly;
    sel.style.fontSize = `${fontSize}px`;
    sel.addEventListener('change', () => {
      const chosen = Array.from(sel.selectedOptions).map((o) => o.value);
      setValue(name, sel.multiple ? chosen : (chosen[0] ?? ''), true);
    });
    return sel;
  }
  return null;
}

/** Refreshes inputs after a value changed elsewhere (another page, undo…). */
export function syncFormLayer(container: HTMLElement, annots: AnnotData[]): void {
  const byName = new Map<string, AnnotData>();
  for (const a of annots) if (a.fieldName) byName.set(a.fieldName, a);
  for (const el of container.querySelectorAll<HTMLElement>('.form-field')) {
    if (el === document.activeElement) continue;
    const a = byName.get(el.dataset.field ?? '');
    if (!a) continue;
    const v = currentValue(a);
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox') el.checked = v !== '' && v !== 'Off' && v === (el.dataset.on ?? v);
      else if (el.type === 'radio') el.checked = v === el.value;
      else el.value = Array.isArray(v) ? v.join(', ') : v;
    } else if (el instanceof HTMLTextAreaElement) {
      el.value = Array.isArray(v) ? v.join(', ') : v;
    } else if (el instanceof HTMLSelectElement) {
      const vals = Array.isArray(v) ? v : [v];
      for (const o of el.options) o.selected = vals.includes(o.value);
    }
  }
}
