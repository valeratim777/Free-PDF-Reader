// Document-level dialogs: properties, password protection, watermark, page numbers, about.
import { store } from '../store';
import type { NumberPosition } from '../model';
import { pageInfo } from '../pages';
import { dialog, field, h, select, toast } from '../ui/dom';
import { t } from '../i18n';

function input(value: string | number, type = 'text', extra: Record<string, string | number> = {}): HTMLInputElement {
  return h('input.input', { type, value: String(value), ...extra });
}

function fmtDate(d: unknown): string {
  if (!d) return '—';
  if (typeof d === 'string') {
    const m = /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(d);
    if (m) {
      const date = new Date(Date.UTC(+m[1], +(m[2] ?? 1) - 1, +(m[3] ?? 1), +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)));
      return date.toLocaleString();
    }
    return d;
  }
  return String(d);
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export async function propertiesDialog(currentPage: number): Promise<void> {
  if (!store.primary) return;
  const src = store.source(store.primary);
  const meta = await src.pdf.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as Record<string, unknown>;
  const cur = store.state.meta ?? {
    title: String(info.Title ?? ''),
    author: String(info.Author ?? ''),
    subject: String(info.Subject ?? ''),
    keywords: String(info.Keywords ?? ''),
  };
  const title = input(cur.title);
  const author = input(cur.author);
  const subject = input(cur.subject);
  const keywords = input(cur.keywords);
  const p = store.state.pages[currentPage];
  let size = '—';
  if (p) {
    const pi = pageInfo(p);
    const mm = (v: number) => Math.round((v / 72) * 25.4);
    size = `${mm(pi.width)} × ${mm(pi.height)} mm (${(pi.width / 72).toFixed(2)} × ${(pi.height / 72).toFixed(2)} in)`;
  }
  const row = (k: string, v: string) => h('tr', {}, h('td', {}, k), h('td', {}, v));
  const table = h(
    'table.info-table',
    {},
    row(t('title'), store.fileName),
    row(t('fileSize'), fmtSize(src.bytes.length)),
    row(t('pages'), String(store.state.pages.length)),
    row(t('pageSize'), size),
    row(t('pdfVersion'), String(info.PDFFormatVersion ?? '—')),
    row(t('creator'), String(info.Creator ?? '—')),
    row(t('producer'), String(info.Producer ?? '—')),
    row(t('created'), fmtDate(info.CreationDate)),
    row(t('modified'), fmtDate(info.ModDate)),
  );
  const ok = await dialog<boolean>({
    title: t('properties'),
    body: h('div', {}, table, field(t('title'), title), field(t('author'), author), field(t('subject'), subject), field(t('keywords'), keywords)),
    actions: [
      { label: t('cancel'), value: false },
      { label: t('apply'), value: true, primary: true },
    ],
  });
  if (!ok) return;
  const next = { title: title.value, author: author.value, subject: subject.value, keywords: keywords.value };
  if (JSON.stringify(next) !== JSON.stringify(cur) || store.state.meta) store.commit('doc', (s) => (s.meta = next));
}

export async function protectDialog(): Promise<void> {
  const cur = store.protection;
  const user = input(cur?.userPassword ?? '', 'password', { autocomplete: 'new-password' });
  const owner = input(cur?.ownerPassword ?? '', 'password', { autocomplete: 'new-password' });
  const check = (label: string, on: boolean) => {
    const c = h('input', { type: 'checkbox', checked: on });
    return { el: h('label.check', {}, c, label), c };
  };
  const pr = check(t('allowPrint'), cur?.allowPrint ?? true);
  const cp = check(t('allowCopy'), cur?.allowCopy ?? true);
  const ed = check(t('allowEdit'), cur?.allowEdit ?? false);
  const actions: { label: string; value: string; primary?: boolean; danger?: boolean }[] = [{ label: t('cancel'), value: 'cancel' }];
  if (cur) actions.push({ label: t('removeProtection'), value: 'remove', danger: true });
  actions.push({ label: t('apply'), value: 'apply', primary: true });
  const r = await dialog<string>({
    title: t('protect'),
    body: h('div', {}, h('p', { style: 'margin-top:0;color:var(--muted)' }, t('protectHint')), field(t('openPassword'), user), field(t('ownerPassword'), owner), pr.el, cp.el, ed.el),
    actions,
  });
  if (r === 'remove') {
    store.protection = null;
    store.dirty = true;
    store.emit({ kind: 'doc' });
  } else if (r === 'apply') {
    if (!user.value && !owner.value) {
      store.protection = null;
    } else {
      store.protection = {
        userPassword: user.value,
        ownerPassword: owner.value,
        allowPrint: pr.c.checked,
        allowCopy: cp.c.checked,
        allowEdit: ed.c.checked,
      };
      toast(t('protectionOn'));
    }
    store.dirty = true;
    store.emit({ kind: 'doc' });
  }
}

export async function watermarkDialog(): Promise<void> {
  const cur = store.state.watermark ?? { text: t('stampConfidential'), size: 64, color: '#9ca3af', opacity: 0.35, angle: 45 };
  const text = input(cur.text);
  const size = input(cur.size, 'number', { min: 8, max: 300 });
  const color = h('input.color-input', { type: 'color', value: cur.color });
  const opacity = input(Math.round(cur.opacity * 100), 'range', { min: 5, max: 100 });
  const angle = input(cur.angle, 'number', { min: -180, max: 180 });
  const actions: { label: string; value: string; primary?: boolean; danger?: boolean }[] = [{ label: t('cancel'), value: 'cancel' }];
  if (store.state.watermark) actions.push({ label: t('remove'), value: 'remove', danger: true });
  actions.push({ label: t('apply'), value: 'apply', primary: true });
  const r = await dialog<string>({
    title: t('watermark'),
    body: h(
      'div',
      {},
      field(t('watermarkText'), text),
      h('div.row', {}, field(t('size'), size), field(t('angle'), angle)),
      h('div.row', {}, field(t('color'), color), field(t('opacity'), opacity)),
    ),
    actions,
  });
  if (r === 'remove') store.commit('doc', (s) => (s.watermark = null));
  else if (r === 'apply' && text.value.trim()) {
    store.commit('doc', (s) => {
      s.watermark = { text: text.value, size: Math.max(4, +size.value || 64), color: color.value, opacity: +opacity.value / 100, angle: +angle.value || 0 };
    });
  }
}

export async function numberingDialog(): Promise<void> {
  const cur = store.state.numbering ?? { format: `${t('page')} {n} ${t('pageOf')} {total}`, position: 'bottom-center' as NumberPosition, size: 10, start: 1, color: '#111827' };
  const format = input(cur.format);
  const pos = select(
    [
      ['bottom-center', t('posBottomCenter')],
      ['bottom-right', t('posBottomRight')],
      ['bottom-left', t('posBottomLeft')],
      ['top-center', t('posTopCenter')],
      ['top-right', t('posTopRight')],
      ['top-left', t('posTopLeft')],
    ],
    cur.position,
  );
  const size = input(cur.size, 'number', { min: 5, max: 72 });
  const start = input(cur.start, 'number', { min: 0 });
  const color = h('input.color-input', { type: 'color', value: cur.color });
  const actions: { label: string; value: string; primary?: boolean; danger?: boolean }[] = [{ label: t('cancel'), value: 'cancel' }];
  if (store.state.numbering) actions.push({ label: t('remove'), value: 'remove', danger: true });
  actions.push({ label: t('apply'), value: 'apply', primary: true });
  const r = await dialog<string>({
    title: t('pageNumbers'),
    body: h('div', {}, field(t('numberFormat'), format), field(t('position'), pos), h('div.row', {}, field(t('size'), size), field(t('startAt'), start), field(t('color'), color))),
    actions,
  });
  if (r === 'remove') store.commit('doc', (s) => (s.numbering = null));
  else if (r === 'apply') {
    store.commit('doc', (s) => {
      s.numbering = {
        format: format.value || '{n}',
        position: pos.value as NumberPosition,
        size: Math.max(4, +size.value || 10),
        start: Number.isFinite(+start.value) ? +start.value : 1,
        color: color.value,
      };
    });
  }
}

export async function authorDialog(): Promise<void> {
  let cur = '';
  try {
    cur = localStorage.getItem('pr.author') || '';
  } catch {
    /* ignore */
  }
  const name = input(cur);
  const ok = await dialog<boolean>({
    title: t('settings'),
    body: field(t('authorName'), name),
    actions: [
      { label: t('cancel'), value: false },
      { label: t('ok'), value: true, primary: true },
    ],
  });
  if (ok) {
    try {
      localStorage.setItem('pr.author', name.value.trim());
    } catch {
      /* ignore */
    }
  }
}

export async function aboutDialog(): Promise<void> {
  const lib = (name: string, license: string, url: string) => h('li', {}, h('a', { href: url, target: '_blank', rel: 'noopener' }, name), ` — ${license}`);
  await dialog({
    title: t('about'),
    body: h(
      'div',
      {},
      h('p', { style: 'margin-top:0' }, t('aboutText')),
      h('h3', { style: 'font-size:14px;margin-bottom:4px' }, t('licenses')),
      h(
        'ul',
        { style: 'padding-left:18px;margin-top:4px;color:var(--muted)' },
        lib('PDF.js (Mozilla)', 'Apache-2.0', 'https://github.com/mozilla/pdf.js'),
        lib('pdf-lib (@cantoo/pdf-lib)', 'MIT', 'https://github.com/cantoo-scribe/pdf-lib'),
        lib('fontkit (@cantoo/fontkit)', 'MIT', 'https://github.com/cantoo-scribe/fontkit'),
        lib('DejaVu Fonts', 'Bitstream Vera / Public Domain', 'https://dejavu-fonts.github.io/'),
        lib('Lucide icons', 'ISC', 'https://lucide.dev'),
        lib('fflate', 'MIT', 'https://github.com/101arrowz/fflate'),
      ),
    ),
    actions: [{ label: t('ok'), value: true, primary: true }],
  });
}
