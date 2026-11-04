// "Translate document". The text of each page is split into paragraphs, the
// paragraphs are translated, and the result is either put on the pages in place
// of the original text (covered with its background color, set in a matching
// font, color and size; one undoable step) or saved as a text file.
import { store } from '../store';
import { getLang, t } from '../i18n';
import { busy, dialog, downloadBlob, field, h, select, toast } from '../ui/dom';
import { rawTextContent } from '../text';
import { pageInfo, pdfPage } from '../pages';
import { ensureCssFont, measureLines } from '../fonts';
import { analyzeInk } from '../colors';
import { inflate, rectFromFrame } from '../geometry';
import { emptyState, uid, type Annotation, type CoverAnn, type DocPage, type FontKey, type TextAnn } from '../model';
import { fitText, isTranslatable, pageBlocks, placeText, roomFor, type TextBlock, type TextItemIn, type TextStyleIn } from '../translate/layout';
import { deviceAvailable, deviceEngine, detectLanguage, googleEngine, TranslateError, type Engine, type EngineId } from '../translate/engines';
import { deviceCode, fontFor, pdfWritable, sortedLangs } from '../translate/languages';
import { httpGet } from './native';
import { addSource } from './documents';
import { forgetCurrent } from './recent';
import { suggestedName } from './save';

type Output = 'replace' | 'text';

interface Prefs {
  from: string;
  to: string;
  engine: EngineId;
  output: Output;
}

interface Job extends Prefs {
  pages: number[];
}

/** How the original paragraph looks, to set the translation the same way. */
interface Look {
  font: FontKey;
  bold: boolean;
  fg: string;
  bg: string;
}

interface PageResult {
  page: DocPage;
  index: number;
  items: { block: TextBlock; translated: string | null; look?: Look }[];
}

const PREFS_KEY = 'pr.translate';
let deviceProbe: Promise<boolean> | null = null;

function loadPrefs(): Prefs {
  const ui = getLang();
  // The offline translator is preferred wherever the browser has one.
  const def: Prefs = { from: 'auto', to: ui, engine: 'device', output: 'replace' };
  try {
    return { ...def, ...(JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as Partial<Prefs>) };
  } catch {
    return def;
  }
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

export async function translateDialog(current: number): Promise<void> {
  if (!store.isOpen) return;
  const prefs = loadPrefs();
  const ui = getLang();
  const langs = sortedLangs(ui).map((l): [string, string] => [l.code, l.name]);
  const from = select([['auto', t('langDetect')], ...langs], prefs.from);
  const to = select(langs, prefs.to);
  const range = select(
    [
      ['all', t('allPages')],
      ['current', t('currentPage')],
    ],
    'all',
  );
  const output = select(
    [
      ['replace', t('translateReplace')],
      ['text', t('translateTextFile')],
    ],
    prefs.output,
  );
  const engine = select(
    [
      ['device', t('engineDevice')],
      ['google', t('engineGoogle')],
    ],
    prefs.engine,
  );
  // The choice of translator shows up once the browser confirms it has one built in.
  const engineField = field(t('translateEngine'), engine);
  engineField.hidden = true;
  engine.value = 'google';
  deviceProbe ??= deviceAvailable();
  void deviceProbe.then((ok) => {
    if (!ok || !engineField.isConnected) return;
    engineField.hidden = false;
    engine.value = prefs.engine;
    sync();
  });
  const outputNote = h('p.tr-note');
  const engineNote = h('p.tr-note');
  let wanted = output.value as Output;
  const sync = () => {
    const pdfOk = pdfWritable(to.value);
    output.options[0].disabled = !pdfOk;
    output.value = pdfOk ? wanted : 'text';
    outputNote.textContent = !pdfOk ? t('translateNoPdfFont') : output.value === 'replace' ? t('translateReplaceNote') : '';
    outputNote.hidden = !outputNote.textContent;
    engineNote.textContent = engine.value === 'device' ? t('translateDeviceNote') : t('translateOnlineNote');
    engineNote.classList.toggle('tr-online', engine.value === 'google');
  };
  output.addEventListener('change', () => {
    wanted = output.value as Output;
    sync();
  });
  to.addEventListener('change', sync);
  engine.addEventListener('change', sync);
  sync();

  const ok = await dialog<boolean>({
    title: t('translate'),
    body: h(
      'div.tr-form',
      {},
      h('div.row', {}, field(t('translateFrom'), from), field(t('translateTo'), to)),
      field(t('translatePages'), range),
      field(t('translateOutput'), output),
      outputNote,
      engineField,
      engineNote,
    ),
    actions: [
      { label: t('cancel'), value: false },
      { label: t('translateRun'), value: true, primary: true },
    ],
  });
  if (!ok) return;
  const job: Job = {
    from: from.value,
    to: to.value,
    engine: engine.value as EngineId,
    output: output.value as Output,
    pages: range.value === 'current' ? [current] : store.state.pages.map((_, i) => i),
  };
  // The translator is remembered only when there was a choice.
  savePrefs({ from: job.from, to: job.to, engine: engineField.hidden ? prefs.engine : job.engine, output: wanted });
  if (job.from === job.to) {
    toast(t('translateSameLang'));
    return;
  }
  await run(job);
}

// ---------------- progress ----------------

function progressBox(onCancel: () => void) {
  const label = h('div.tr-progress-text', {}, t('translatePreparing'));
  const fill = h('div.tr-progress-fill');
  const bar = h('div.tr-progress', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 }, fill);
  const cancel = h('button.btn', { type: 'button' }, t('cancel'));
  const stop = () => {
    cancel.disabled = true;
    label.textContent = t('translateStopping');
    onCancel();
  };
  cancel.addEventListener('click', stop);
  const box = h(
    'div.modal',
    { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('translating') },
    h('div.modal-header', {}, h('h2', {}, t('translating'))),
    h('div.modal-body', {}, label, bar),
    h('div.modal-footer', {}, cancel),
  );
  const backdrop = h('div.modal-backdrop', {}, box);
  const onKey = (e: KeyboardEvent) => {
    const open = document.querySelectorAll('.modal-backdrop');
    if (e.key === 'Escape' && open[open.length - 1] === backdrop) {
      e.stopPropagation();
      if (!cancel.disabled) stop();
    }
  };
  document.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  cancel.focus();
  return {
    set(text: string, fraction: number) {
      if (cancel.disabled) return;
      label.textContent = text;
      const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
      fill.style.width = `${pct}%`;
      bar.setAttribute('aria-valuenow', String(pct));
    },
    close() {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
    },
  };
}

// ---------------- running ----------------

function errorText(e: unknown): string {
  if (e instanceof TranslateError) {
    switch (e.code) {
      case 'offline':
        return t('translateOffline');
      case 'limit':
        return t('translateLimit');
      case 'pair':
        return t('translatePair');
      case 'detect':
        return t('translateDetect');
      case 'same':
        return t('translateSameLang');
      default:
        return t('translateFailed', { msg: e.message });
    }
  }
  return t('translateFailed', { msg: String((e as Error)?.message ?? e) });
}

/** A bit of the document's text, for telling its language. */
async function sampleText(pages: number[]): Promise<string> {
  let s = '';
  for (const i of pages.slice(0, 5)) {
    const p = store.state.pages[i];
    // Always the original text, also on pages translated before.
    const raw = (await rawTextContent({ src: p.src, index: p.index })) as { items: TextItemIn[] };
    s += ' ' + raw.items.map((it) => it.str ?? '').join(' ');
    if (s.length > 1500) break;
  }
  return s.replace(/\s+/g, ' ').trim().slice(0, 2000);
}

async function run(job: Job): Promise<void> {
  const ctrl = new AbortController();
  const signal = ctrl.signal;
  const prog = progressBox(() => ctrl.abort());
  let engine: Engine | null = null;
  const results: PageResult[] = [];
  let failure: unknown = null;
  try {
    let from = job.from;
    if (job.engine === 'device') {
      if (from === 'auto') {
        from = (await detectLanguage(await sampleText(job.pages), signal)) ?? '';
        if (!from) throw new TranslateError('detect');
      }
      if (deviceCode(from) === deviceCode(job.to)) throw new TranslateError('same');
      engine = await deviceEngine(from, job.to, signal, (f) => prog.set(t('translateDownloading', { p: Math.round(f * 100) }), f));
    } else {
      engine = googleEngine(from, job.to, httpGet);
    }
    for (const [k, i] of job.pages.entries()) {
      prog.set(t('translatingPage', { n: k + 1, total: job.pages.length }), k / job.pages.length);
      results.push(await translatePage(i, engine, job.output === 'replace', signal));
    }
  } catch (e) {
    failure = e;
  } finally {
    prog.close();
    engine?.dispose();
  }

  if (signal.aborted) {
    toast(t('translateCancelled'));
    return;
  }
  if (failure) {
    console.warn('translation', failure);
    const msg = errorText(failure);
    const done = results.filter((r) => r.items.some((x) => x.translated));
    if (!done.length) {
      toast(msg, 'error', 7000);
      return;
    }
    const keep = await dialog<boolean>({
      title: t('translate'),
      body: h('div', {}, h('p', {}, t('translateStopped', { n: job.pages[results.length] + 1, msg })), h('p', {}, t('translateKeepAsk'))),
      actions: [
        { label: t('cancel'), value: false },
        { label: t('translateKeep'), value: true, primary: true },
      ],
      dismissValue: false,
    });
    if (!keep) return;
  }
  if (job.output === 'replace') await applyOnPages(results, job.to);
  else saveText(results, job.to);
}

async function translatePage(index: number, engine: Engine, wantLook: boolean, signal: AbortSignal): Promise<PageResult> {
  const page = store.state.pages[index];
  // The original text, also when the page was translated before (no translation of a translation).
  const raw = (await rawTextContent({ src: page.src, index: page.index })) as {
    items: TextItemIn[];
    styles?: Record<string, TextStyleIn & { fontFamily?: string }>;
  };
  const styles = raw.styles ?? {};
  const blocks = pageBlocks(raw.items, styles);
  const todo = blocks.filter((b) => isTranslatable(b.text));
  const translated = todo.length ? await engine.translate(todo.map((b) => b.text), signal) : [];
  const byBlock = new Map(todo.map((b, i) => [b, translated[i] ?? null]));
  const looks = wantLook && todo.length ? await sampleLooks(page, todo, styles) : null;
  return { page, index, items: blocks.map((block) => ({ block, translated: byBlock.get(block) ?? null, look: looks?.get(block) })) };
}

/** Renders the page off screen and reads the colors, weight and family of each paragraph. */
async function sampleLooks(page: DocPage, blocks: TextBlock[], styles: Record<string, { fontFamily?: string }>): Promise<Map<TextBlock, Look>> {
  const proxy = await pdfPage(page.src, page.index);
  const unit = proxy.getViewport({ scale: 1, rotation: 0 });
  const scale = Math.min(2, Math.sqrt(4_000_000 / Math.max(1, unit.width * unit.height)));
  const vp = proxy.getViewport({ scale, rotation: 0 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(vp.width));
  canvas.height = Math.max(1, Math.ceil(vp.height));
  const out = new Map<TextBlock, Look>();
  try {
    await proxy.render({ canvas, viewport: vp, background: '#ffffff' }).promise;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const fonts = (proxy as unknown as { commonObjs?: { has(id: string): boolean; get(id: string): { bold?: boolean; black?: boolean } } }).commonObjs;
    for (const b of blocks) {
      const r = b.rect;
      const [xa, ya] = vp.convertToViewportPoint(r.x1, r.y1) as number[];
      const [xb, yb] = vp.convertToViewportPoint(r.x2, r.y2) as number[];
      const x = Math.max(0, Math.floor(Math.min(xa, xb)));
      const y = Math.max(0, Math.floor(Math.min(ya, yb)));
      const w = Math.max(1, Math.min(canvas.width - x, Math.ceil(Math.abs(xb - xa))));
      const hh = Math.max(1, Math.min(canvas.height - y, Math.ceil(Math.abs(yb - ya))));
      let ink = { bg: '#ffffff', fg: '#000000', stem: 0 };
      try {
        ink = analyzeInk(ctx.getImageData(x, y, w, hh).data, w, hh, b.size * scale);
      } catch {
        /* keep black on white */
      }
      let bold: boolean | null = null;
      try {
        if (fonts?.has(b.font)) {
          const f = fonts.get(b.font);
          bold = !!(f?.bold || f?.black);
        }
      } catch {
        /* fall back to the stroke width */
      }
      const family = (styles[b.font]?.fontFamily ?? '').toLowerCase();
      const font: FontKey = /mono|courier|consol/.test(family) ? 'mono' : /serif|times|georgia|roman|garamond/.test(family) && !/sans/.test(family) ? 'serif' : 'sans';
      out.set(b, { font, bold: bold ?? ink.stem > 0.13, fg: ink.fg, bg: ink.bg });
    }
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
  return out;
}

function isLight(hex: string): boolean {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return !!m && [m[1], m[2], m[3]].every((c) => parseInt(c, 16) >= 235);
}

/** File name of the translation: "report.pdf" → "report-de.pdf" (a new translation replaces the suffix). */
let renamed: { from: string; to: string } | null = null;
function translatedName(code: string): string {
  const base = renamed && store.fileName === renamed.to ? renamed.from : suggestedName();
  const name = base.replace(/(\.pdf)?$/i, `-${code}.pdf`);
  renamed = { from: base, to: name };
  return name;
}

async function applyOnPages(all: PageResult[], to: string): Promise<void> {
  // Pages removed (or another document opened) in the meantime are skipped.
  const results = all.filter((r) => store.page(r.page.id));
  const covers: CoverAnn[] = [];
  const texts: TextAnn[] = [];
  const now = Date.now();
  const used = new Set<string>();
  for (const r of results) for (const x of r.items) if (x.look) used.add(`${fontFor(to, x.look.font)}|${x.look.bold}`);
  // Text is measured with the same fonts that draw it on screen and in the PDF.
  await Promise.all([...used].map((k) => ensureCssFont(k.split('|')[0] as FontKey, k.endsWith('true')).catch(() => {})));
  let count = 0;
  for (const r of results) {
    const blocks = r.items.map((x) => x.block);
    const view = pageInfo(r.page).view;
    for (const { block, translated, look } of r.items) {
      const text = translated?.replace(/\s+/g, ' ').trim();
      if (!text || !look || text === block.text) continue;
      const font = fontFor(to, look.font);
      // On a plain light background a longer translation may use the free space around
      // the paragraph; on a colored panel it stays inside the original area.
      const room = isLight(look.bg) ? roomFor(block, blocks, view) : undefined;
      const fit = fitText(text, block, (s) => measureLines(s, font, look.bold, 1)[0], room);
      const base = { pageId: r.page.id, opacity: 1, created: now, generated: 'translation' as const };
      covers.push({ ...base, id: uid('a'), type: 'whiteout', color: look.bg, rect: inflate(block.rect, 0.6) });
      for (const p of placeText(block, fit)) {
        texts.push({
          ...base,
          id: uid('a'),
          type: 'text',
          color: look.fg,
          rect: rectFromFrame(p.origin.x, p.origin.y, p.width, p.height, block.rot),
          rot: block.rot,
          text: p.text,
          font,
          bold: look.bold,
          size: fit.size,
          bg: null,
          pad: 0,
        });
      }
      count++;
    }
  }
  if (!count) {
    const hadText = results.some((r) => r.items.some((x) => x.translated));
    toast(hadText ? t('translateSameLang') : t('translateNothing'), hadText ? 'info' : 'error', 6000);
    return;
  }
  const pageIds = new Set(results.map((r) => r.page.id));
  // All covers first, so no paragraph's cover hides the translation of its neighbor.
  const added: Annotation[] = [...covers, ...texts];
  const translatedIds = [...new Set(texts.map((a) => a.pageId))];
  const name = translatedName(to);
  // The translated pages written out as a PDF of their own, exactly as a save makes
  // them. The screen shows these, so the translation is real text: it can be selected,
  // copied, searched and read aloud. Saving still starts from the original pages.
  let view: { id: string } | null = null;
  busy(true, t('translating'));
  try {
    const { buildPdf } = await import('../export/exporter');
    const pages = translatedIds.map((id) => {
      const p = store.page(id)!;
      return { id, src: p.src, index: p.index, rot: 0 as const };
    });
    const bytes = await buildPdf(
      { state: { ...emptyState(), pages, anns: added }, sources: store.sources, primary: null, assets: store.assets, pageInfo: (p) => pageInfo(p) },
      { producer: 'PDF Reader' },
    );
    view = await addSource(bytes, name);
  } catch (e) {
    // The translation is still shown, drawn over the original page.
    console.warn('translated pages', e);
  } finally {
    busy(false);
  }
  // The original file stays as it is: saving writes a new one.
  store.fileName = name;
  store.fileHandle = null;
  forgetCurrent();
  store.commit('pages', (s) => {
    s.anns = s.anns.filter((a) => !(a.generated === 'translation' && pageIds.has(a.pageId)));
    s.anns.push(...added);
    s.pages = s.pages.map((p) => {
      if (!pageIds.has(p.id)) return p;
      const { view: _old, ...rest } = p;
      void _old;
      const k = translatedIds.indexOf(p.id);
      return view && k >= 0 ? { ...rest, view: { src: view.id, index: k } } : rest;
    });
  });
  toast(t('translateDone', { n: count, p: translatedIds.length }), 'success', 8000);
}

function saveText(results: PageResult[], to: string): void {
  if (!results.some((r) => r.items.some((x) => x.translated))) {
    toast(t('translateNothing'), 'error', 6000);
    return;
  }
  const parts = results.map((r) => {
    const body = r.items.map((x) => x.translated?.trim() || x.block.text).join('\n\n');
    return `--- ${t('page')} ${r.index + 1} ---\n${body}\n`;
  });
  downloadBlob(new Blob([parts.join('\n')], { type: 'text/plain;charset=utf-8' }), suggestedName().replace(/\.pdf$/i, `-${to}.txt`));
}
