// Printing, exporting pages as images or text, and reading aloud.
import { zipSync } from 'fflate';
import { store } from '../store';
import { exportPdf, loadExported, share, suggestedName } from './save';
import { isNativeApp } from './native';
import { pageText } from '../text';
import { busy, dialog, downloadBlob, field, h, icon, iconButton, select, toast } from '../ui/dom';
import { t } from '../i18n';
import { Pause, Play, Square } from 'lucide';
import type { Viewer } from '../viewer/viewer';

async function renderPages(bytes: Uint8Array, pages: number[], dpi: number, mime: string, quality = 0.92): Promise<Blob[]> {
  const pdf = await loadExported(bytes);
  const out: Blob[] = [];
  try {
    for (const n of pages) {
      const page = await pdf.getPage(n + 1);
      const vp = page.getViewport({ scale: dpi / 72 });
      const c = document.createElement('canvas');
      const maxPx = 40_000_000;
      const k = Math.min(1, Math.sqrt(maxPx / (vp.width * vp.height)));
      const v2 = k < 1 ? page.getViewport({ scale: (dpi / 72) * k }) : vp;
      c.width = Math.ceil(v2.width);
      c.height = Math.ceil(v2.height);
      await page.render({ canvas: c, viewport: v2, background: '#ffffff' }).promise;
      out.push(await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), mime, quality)));
      c.width = 0;
      page.cleanup();
    }
  } finally {
    await pdf.loadingTask.destroy();
  }
  return out;
}

export async function printDocument(): Promise<void> {
  if (!store.isOpen) return;
  // Android's WebView has no print dialog; the share sheet offers "Print" instead.
  if (isNativeApp()) {
    toast(t('printViaShare'));
    return share();
  }
  busy(true, t('loading'));
  const root = document.getElementById('print-root')!;
  const urls: string[] = [];
  try {
    const bytes = await exportPdf({ noProtection: true });
    const blobs = await renderPages(bytes, store.state.pages.map((_, i) => i), 150, 'image/jpeg', 0.95);
    root.replaceChildren();
    for (const b of blobs) {
      const url = URL.createObjectURL(b);
      urls.push(url);
      root.append(h('div.print-page', {}, h('img', { src: url, alt: '' })));
    }
    await Promise.all(Array.from(root.querySelectorAll('img')).map((img) => img.decode().catch(() => {})));
  } catch (e) {
    toast(String((e as Error).message), 'error');
    return;
  } finally {
    busy(false);
  }
  const cleanup = () => {
    root.replaceChildren();
    urls.forEach((u) => URL.revokeObjectURL(u));
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
}

export async function exportImagesDialog(current: number): Promise<void> {
  if (!store.isOpen) return;
  const fmt = select(
    [
      ['image/png', 'PNG'],
      ['image/jpeg', 'JPEG'],
    ],
    'image/png',
  );
  const dpi = select(
    [
      ['72', '72'],
      ['150', '150'],
      ['300', '300'],
    ],
    '150',
  );
  const range = select(
    [
      ['current', t('currentPage')],
      ['all', t('allPages')],
    ],
    'current',
  );
  const ok = await dialog<boolean>({
    title: t('exportImages'),
    body: h('div', {}, field(t('format'), fmt), field(t('resolution'), dpi), field(t('pages'), range)),
    actions: [
      { label: t('cancel'), value: false },
      { label: t('download'), value: true, primary: true },
    ],
  });
  if (!ok) return;
  busy(true);
  try {
    const bytes = await exportPdf({ noProtection: true });
    const pages = range.value === 'all' ? store.state.pages.map((_, i) => i) : [current];
    const blobs = await renderPages(bytes, pages, +dpi.value, fmt.value);
    const ext = fmt.value === 'image/png' ? 'png' : 'jpg';
    const base = suggestedName().replace(/\.pdf$/i, '');
    if (blobs.length === 1) {
      downloadBlob(blobs[0], `${base}-${pages[0] + 1}.${ext}`);
    } else {
      const files: Record<string, Uint8Array> = {};
      for (let i = 0; i < blobs.length; i++) files[`${base}-${pages[i] + 1}.${ext}`] = new Uint8Array(await blobs[i].arrayBuffer());
      const zip = zipSync(files, { level: 0 });
      downloadBlob(new Blob([zip.slice()], { type: 'application/zip' }), `${base}-images.zip`);
    }
  } catch (e) {
    toast(String((e as Error).message), 'error');
  } finally {
    busy(false);
  }
}

export async function exportText(): Promise<void> {
  if (!store.isOpen) return;
  busy(true);
  try {
    const parts: string[] = [];
    for (let i = 0; i < store.state.pages.length; i++) {
      const pt = await pageText(store.state.pages[i]);
      parts.push(`--- ${t('page')} ${i + 1} ---\n${pt.text.trim()}\n`);
    }
    downloadBlob(new Blob([parts.join('\n')], { type: 'text/plain;charset=utf-8' }), suggestedName().replace(/\.pdf$/i, '.txt'));
  } finally {
    busy(false);
  }
}

// ---- read aloud ----

let speaking: { stop(): void } | null = null;

export function readAloud(viewer: Viewer, host: HTMLElement): void {
  if (!('speechSynthesis' in window)) {
    toast(t('speechUnsupported'), 'error');
    return;
  }
  speaking?.stop();
  const synth = window.speechSynthesis;
  synth.cancel();
  let page = viewer.current;
  let stopped = false;
  let paused = false;
  const label = h('span', { style: 'font-size:13px;padding:0 6px;white-space:nowrap' });
  const pauseBtn = iconButton(Pause, t('pause'), () => {
    paused = !paused;
    if (paused) synth.pause();
    else synth.resume();
    pauseBtn.replaceChildren(icon(paused ? Play : Pause));
    pauseBtn.title = paused ? t('resume') : t('pause');
  });
  const rate = h('select.zoom-select', { title: t('speed') });
  for (const r of ['0.75', '1', '1.25', '1.5', '2']) rate.append(new Option(`${r}×`, r, false, r === '1'));
  const bar = h('div#speechbar', {}, label, pauseBtn, rate, iconButton(Square, t('stop'), () => stop()));
  host.append(bar);
  const stop = () => {
    stopped = true;
    synth.cancel();
    bar.remove();
    speaking = null;
  };
  speaking = { stop };
  const voiceFor = (text: string) => {
    const lang = /[а-яё]/i.test(text) ? 'ru' : (document.documentElement.lang || 'en').slice(0, 2);
    return synth.getVoices().find((v) => v.lang.toLowerCase().startsWith(lang)) ?? null;
  };
  const speakPage = async () => {
    if (stopped) return;
    if (page >= store.state.pages.length) return stop();
    label.textContent = `${t('page')} ${page + 1}`;
    viewer.scrollToPage(page, { smooth: true });
    const text = (await pageText(store.state.pages[page])).text.replace(/\s+/g, ' ').trim();
    if (!text) {
      page++;
      return speakPage();
    }
    // Long pages are split into sentences; some engines stop after ~200 words.
    const chunks = text.match(/[^.!?…]+[.!?…]*\s*/g) ?? [text];
    let i = 0;
    const next = () => {
      if (stopped) return;
      if (i >= chunks.length) {
        page++;
        void speakPage();
        return;
      }
      const u = new SpeechSynthesisUtterance(chunks[i++]);
      const v = voiceFor(text);
      if (v) {
        u.voice = v;
        u.lang = v.lang;
      }
      u.rate = +rate.value;
      u.onend = next;
      u.onerror = () => !stopped && next();
      synth.speak(u);
    };
    next();
  };
  void speakPage();
}
