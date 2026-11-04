// "Read aloud": the document is read paragraph by paragraph, from the current
// page on, each paragraph with a voice of its own language. What is read is the
// page as shown — for a translated page, the translation. The paragraph being
// read is marked on the page.
import { Pause, Play, Square } from 'lucide';
import { store } from '../store';
import { getLang, t } from '../i18n';
import { rawTextContent } from '../text';
import { h, icon, iconButton, toast } from '../ui/dom';
import { pageBlocks, type TextBlock, type TextItemIn, type TextStyleIn } from '../translate/layout';
import { langName } from '../translate/languages';
import { detectLang } from '../speech/lang';
import { NeuralSpeech, PcmPlayer, isDownloaded } from '../speech/neural';
import { androidSpeech, defaultChoice, neuralSupported, voiceChoices, type VoiceChoice } from '../speech/voices';
import type { Rect } from '../model';
import { isNativeApp } from './native';
import type { Viewer } from '../viewer/viewer';

interface Chunk {
  page: number;
  text: string;
  lang: string;
  rect: Rect;
}

const VOICE_KEY = 'pr.voice.';
const RATE_KEY = 'pr.readRate';

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/** Sentences of a paragraph, joined or cut so each is a comfortable piece to say. */
export function sentences(text: string, max = 280): string[] {
  const raw = text.split(/(?<=[.!?…;:])\s+(?=\S)/u).filter((s) => s.trim());
  const out: string[] = [];
  for (const s of raw) {
    // Very short pieces ("Fig. 3.") go with the next one.
    if (out.length && out[out.length - 1].length < 25) out[out.length - 1] += ' ' + s;
    else out.push(s);
  }
  return out.flatMap((s) => {
    if (s.length <= max) return [s];
    const parts: string[] = [];
    let cur = '';
    for (const piece of s.split(/(?<=[,—–])\s+/u)) {
      for (const word of piece.length > max ? piece.split(/\s+/) : [piece]) {
        if (cur && cur.length + word.length + 1 > max) {
          parts.push(cur);
          cur = '';
        }
        cur = cur ? `${cur} ${word}` : word;
      }
    }
    if (cur) parts.push(cur);
    return parts;
  });
}

type Raw = { items: TextItemIn[]; styles?: Record<string, TextStyleIn> };

function overlap(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
}

/** Paragraphs of the page as shown, in reading order. */
async function pageParagraphs(index: number): Promise<TextBlock[]> {
  const page = store.state.pages[index];
  if (!page) return [];
  const raw = (await rawTextContent(page)) as Raw;
  const blocks = pageBlocks(raw.items, raw.styles ?? {}).filter((b) => /[\p{L}\p{N}]/u.test(b.text));
  if (!page.view) return blocks;
  // A translated page lists its translations after everything else; the original page
  // knows the reading order, and each translation sits where its original paragraph was.
  const orig = (await rawTextContent({ src: page.src, index: page.index })) as Raw;
  const order = pageBlocks(orig.items, orig.styles ?? {});
  const rank = (b: TextBlock) => {
    let best = Infinity;
    let area = 0;
    for (const o of order) {
      const a = overlap(b.rect, o.rect);
      if (a > area) {
        area = a;
        best = o.order;
      }
    }
    return best;
  };
  return blocks
    .map((b) => [b, rank(b)] as const)
    .sort((x, y) => x[1] - y[1] || x[0].order - y[0].order)
    .map(([b]) => b);
}

async function pageChunks(index: number, docLang: string): Promise<Chunk[]> {
  const blocks = await pageParagraphs(index);
  const pageLang = detectLang(blocks.map((b) => b.text).join(' '), docLang);
  const chunks: Chunk[] = [];
  for (const b of blocks) {
    const letters = (b.text.match(/\p{L}/gu) ?? []).length;
    // Short paragraphs (a heading, a name) say too little about their language.
    const lang = letters >= 30 ? detectLang(b.text, pageLang) : pageLang;
    for (const text of sentences(b.text)) chunks.push({ page: index, text, lang, rect: b.rect });
  }
  return chunks;
}

let active: { stop(): void } | null = null;

export function readAloud(viewer: Viewer, host: HTMLElement): void {
  active?.stop();
  const onAndroid = isNativeApp();
  const neuralOk = !onAndroid && neuralSupported();
  if (!onAndroid && !neuralOk && !('speechSynthesis' in window)) {
    toast(t('speechUnsupported'), 'error');
    return;
  }

  let stopped = false;
  let paused = false;
  let resumeWait: (() => void) | null = null;
  const neural = neuralOk ? new NeuralSpeech() : null;
  const player = new PcmPlayer();
  const choices = new Map<string, Promise<VoiceChoice[]>>();
  const chosen = new Map<string, VoiceChoice | null>();
  const prepared = new Set<string>();
  const failed = new Set<string>();
  const warned = new Set<string>();
  const audio = new Map<string, Promise<{ pcm: Float32Array; rate: number }>>();
  let shownLang = '';
  let mark: HTMLElement | null = null;

  // ---- the bar ----
  const label = h('span.speech-label');
  const voiceSel = h('select.zoom-select.speech-voice', { title: t('voice'), 'aria-label': t('voice') });
  const pauseBtn = iconButton(Pause, t('pause'), () => (paused ? resume() : pause()));
  const rate = h('select.zoom-select', { title: t('speed'), 'aria-label': t('speed') });
  const savedRate = stored(RATE_KEY) ?? '1';
  for (const r of ['0.75', '1', '1.25', '1.5', '2']) rate.append(new Option(`${r}×`, r, false, r === savedRate));
  if (!rate.value) rate.value = '1';
  const bar = h('div#speechbar', {}, label, voiceSel, pauseBtn, rate, iconButton(Square, t('stop'), () => stop()));
  host.append(bar);

  const speed = () => +rate.value || 1;
  rate.addEventListener('change', () => {
    remember(RATE_KEY, rate.value);
    audio.clear();
  });
  voiceSel.addEventListener('change', () => {
    void (async () => {
      const list = await choicesFor(shownLang);
      const c = list.find((x) => x.key === voiceSel.value) ?? null;
      chosen.set(shownLang, c);
      if (c) remember(VOICE_KEY + shownLang, c.key);
      audio.clear();
    })();
  });

  const labels = {
    neural: (v: { name: string; female: boolean }) => `${v.name} (${v.female ? t('voiceFemale') : t('voiceMale')}, ${t('voiceNeural')})`,
    device: (n: number, network: boolean) => (network ? `${t('voiceDevice', { n })} · ${t('voiceOnline')}` : t('voiceDevice', { n })),
  };

  function choicesFor(lang: string): Promise<VoiceChoice[]> {
    let c = choices.get(lang);
    if (!c) {
      c = voiceChoices(lang, { android: onAndroid, neural: !!neural, labels });
      choices.set(lang, c);
    }
    return c;
  }

  async function voiceFor(lang: string): Promise<VoiceChoice | null> {
    if (!chosen.has(lang)) {
      const list = (await choicesFor(lang)).filter((c) => !(c.kind === 'neural' && failed.has(lang)));
      chosen.set(lang, defaultChoice(list, stored(VOICE_KEY + lang)));
    }
    return chosen.get(lang) ?? null;
  }

  async function showVoices(lang: string): Promise<void> {
    if (shownLang === lang) return;
    shownLang = lang;
    const list = (await choicesFor(lang)).filter((c) => !(c.kind === 'neural' && failed.has(lang)));
    const current = chosen.get(lang);
    voiceSel.replaceChildren(...list.map((c) => new Option(c.label, c.key, false, c.key === current?.key)));
    voiceSel.hidden = list.length < 2;
    if (!list.length && !warned.has(lang)) {
      warned.add(lang);
      toast(t('voiceMissing', { lang: langName(lang, getLang()) }), 'info', 6000);
    }
  }

  function showPage(page: number): void {
    label.textContent = `${t('page')} ${page + 1}`;
  }

  function markChunk(c: Chunk): void {
    const pv = viewer.views.get(store.state.pages[c.page]?.id ?? '');
    if (!pv) return;
    const v = pv.rectToView(c.rect);
    if (!mark) mark = h('div.read-mark', { 'aria-hidden': 'true' });
    Object.assign(mark.style, { left: `${v.left - 3}px`, top: `${v.top - 2}px`, width: `${v.width + 6}px`, height: `${v.height + 4}px` });
    if (mark.parentElement !== pv.uiDiv) pv.uiDiv.append(mark);
    mark.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ---- speaking ----

  function synth(c: Chunk, v: VoiceChoice): Promise<{ pcm: Float32Array; rate: number }> {
    const key = `${c.page}|${c.text}|${v.key}|${speed()}`;
    let p = audio.get(key);
    if (!p) {
      p = neural!.synth(v.neural!, c.text, speed());
      p.catch(() => audio.delete(key));
      audio.set(key, p);
      // Only the pieces about to be read are kept.
      if (audio.size > 4) audio.delete(audio.keys().next().value!);
    }
    return p;
  }

  async function prepare(v: VoiceChoice): Promise<void> {
    if (!v.neural || prepared.has(v.neural.model)) return;
    const nv = v.neural;
    const fresh = !(await isDownloaded(nv));
    label.textContent = t('voicePreparing');
    await neural!.prepare(nv, (f) => {
      if (fresh) label.textContent = t('voiceDownloading', { name: nv.name, p: Math.round(f * 100), size: nv.size });
    });
    prepared.add(nv.model);
  }

  function speakSystem(c: Chunk, v: VoiceChoice | null): Promise<void> {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(c.text);
      u.lang = v?.system?.lang ?? c.lang;
      if (v?.system) u.voice = v.system;
      u.rate = speed();
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }

  /** Says one piece; false when it was cut short by a pause and must be said again. */
  async function say(c: Chunk, next: Chunk | undefined): Promise<boolean> {
    const v = await voiceFor(c.lang);
    if (onAndroid) {
      const r = await (await androidSpeech()).speak({ text: c.text, lang: c.lang, voice: v?.device?.id, rate: speed() });
      return !r?.interrupted;
    }
    if (v?.kind === 'neural' && neural) {
      try {
        await prepare(v);
        if (stopped) return true;
        showPage(c.page);
        const sound = synth(c, v);
        // Prepare the next sentence while this one is playing.
        if (next && next.lang === c.lang) void synth(next, v).catch(() => {});
        const { pcm, rate: sampleRate } = await sound;
        if (stopped) return true;
        await player.play(pcm, sampleRate);
        return true;
      } catch (e) {
        if (stopped) return true;
        console.warn('neural voice', e);
        failed.add(c.lang);
        chosen.delete(c.lang);
        shownLang = '';
        toast(t('voiceFailed', { msg: String((e as Error)?.message ?? e) }), 'error', 7000);
        await showVoices(c.lang);
        return say(c, next);
      }
    }
    await speakSystem(c, v);
    return true;
  }

  function pause(): void {
    paused = true;
    pauseBtn.replaceChildren(icon(Play));
    pauseBtn.title = t('resume');
    player.pause();
    if (onAndroid) void androidSpeech().then((s) => s.stop());
    else if ('speechSynthesis' in window) speechSynthesis.pause();
  }

  function resume(): void {
    paused = false;
    pauseBtn.replaceChildren(icon(Pause));
    pauseBtn.title = t('pause');
    player.resume();
    if (!onAndroid && 'speechSynthesis' in window) speechSynthesis.resume();
    resumeWait?.();
    resumeWait = null;
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    player.close();
    neural?.dispose();
    if (onAndroid) void androidSpeech().then((s) => s.stop());
    else if ('speechSynthesis' in window) speechSynthesis.cancel();
    resumeWait?.();
    mark?.remove();
    bar.remove();
    active = null;
  }
  active = { stop };

  void (async () => {
    const docLang = getLang();
    for (let page = viewer.current; page < store.state.pages.length && !stopped; page++) {
      const chunks = await pageChunks(page, docLang).catch(() => [] as Chunk[]);
      if (!chunks.length) continue;
      showPage(page);
      viewer.scrollToPage(page, { smooth: true });
      for (let i = 0; i < chunks.length && !stopped; ) {
        const c = chunks[i];
        await voiceFor(c.lang);
        await showVoices(c.lang);
        markChunk(c);
        const done = await say(c, chunks[i + 1]);
        if (stopped) break;
        if (paused) await new Promise<void>((r) => (resumeWait = r));
        if (done) i++;
      }
    }
    stop();
  })().catch((e) => {
    console.warn('read aloud', e);
    toast(String((e as Error)?.message ?? e), 'error');
    stop();
  });
}
