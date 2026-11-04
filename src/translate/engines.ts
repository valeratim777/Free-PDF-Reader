// Translation services:
//  • "device" — the translator built into Chrome on computers. Works without the
//    internet once its language pack is downloaded; the text never leaves the device.
//  • "google" — Google Translate over the internet, available everywhere else.
//    The text of the pages (not the file) is sent to translate.googleapis.com.
import { deviceCode } from './languages';

export type EngineId = 'device' | 'google';

export interface Engine {
  /** Translations of `texts`, in the same order. */
  translate(texts: string[], signal: AbortSignal): Promise<string[]>;
  dispose(): void;
}

export type TranslateErrorCode = 'offline' | 'limit' | 'service' | 'pair' | 'detect' | 'same';

export class TranslateError extends Error {
  constructor(
    readonly code: TranslateErrorCode,
    detail = '',
  ) {
    super(detail || code);
  }
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

/** Runs `fn` over `items` with at most `limit` running at once. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ---------------- Google Translate ----------------

export type HttpGet = (url: string, signal: AbortSignal) => Promise<{ status: number; body: string }>;

const GOOGLE = 'https://translate.googleapis.com/translate_a/single';
/** Longest query sent in one request (characters after URL encoding). */
export const MAX_QUERY = 5000;

const encLen = (s: string) => encodeURIComponent(s).length;

function googleUrl(q: string, from: string, to: string): string {
  return `${GOOGLE}?client=gtx&dt=t&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&q=${encodeURIComponent(q)}`;
}

/** The translated text from a Google response: [[["перевод","original",…],…],…]. */
export function parseGoogle(body: string): string {
  const data = JSON.parse(body) as unknown;
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new TranslateError('service', 'unexpected response');
  return (data[0] as unknown[]).map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : '')).join('');
}

/** Cuts a text that is too long for one request at sentence ends (or spaces, or anywhere). */
export function splitLong(text: string, max = MAX_QUERY): string[] {
  if (encLen(text) <= max) return [text];
  const parts: string[] = [];
  let cur = '';
  const add = (piece: string) => {
    if (cur && encLen(cur + piece) > max) {
      parts.push(cur.trim());
      cur = '';
    }
    cur += piece;
  };
  for (const sentence of text.match(/[^.!?…]+[.!?…]*\s*/gu) ?? [text]) {
    if (encLen(sentence) <= max) {
      add(sentence);
      continue;
    }
    for (const word of sentence.split(/(?<=\s)/u)) {
      if (encLen(word) <= max) {
        add(word);
        continue;
      }
      for (const ch of word) add(ch);
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Groups texts so that each group, joined with line breaks, fits one request. */
export function batches(texts: string[], max = MAX_QUERY): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  let len = 0;
  texts.forEach((t, i) => {
    const l = encLen(t);
    // "%0A" (3 characters) separates the texts.
    if (cur.length && len + 3 + l > max) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    len += (cur.length ? 3 : 0) + l;
    cur.push(i);
  });
  if (cur.length) out.push(cur);
  return out;
}

export function googleEngine(from: string, to: string, http: HttpGet): Engine {
  const request = async (q: string, signal: AbortSignal): Promise<string> => {
    for (let attempt = 0; ; attempt++) {
      let res: { status: number; body: string };
      try {
        res = await http(googleUrl(q, from, to), signal);
      } catch (e) {
        if (signal.aborted) throw abortError();
        if (attempt < 2) {
          await sleep(1000 * 2 ** attempt, signal);
          continue;
        }
        throw new TranslateError('offline', String((e as Error)?.message ?? e));
      }
      if (res.status === 200) return parseGoogle(res.body);
      // Too many requests or a hiccup on the server: wait and try again.
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await sleep(1500 * 2 ** attempt, signal);
        continue;
      }
      throw new TranslateError(res.status === 429 ? 'limit' : 'service', `HTTP ${res.status}`);
    }
  };

  return {
    async translate(texts, signal) {
      // Long texts are cut into pieces; pieces are sent together, one per line.
      const pieces: { owner: number; text: string }[] = [];
      texts.forEach((t, owner) => {
        for (const text of splitLong(t.replace(/\s*\n\s*/g, ' ').trim())) pieces.push({ owner, text });
      });
      const done: string[] = new Array(pieces.length).fill('');
      await pool(batches(pieces.map((p) => p.text)), 2, async (group) => {
        if (signal.aborted) throw abortError();
        const joined = await request(group.map((i) => pieces[i].text).join('\n'), signal);
        const lines = joined.split('\n');
        if (lines.length === group.length) {
          group.forEach((i, k) => (done[i] = lines[k].trim()));
          return;
        }
        // The service merged or split lines: translate these one by one.
        for (const i of group) done[i] = (await request(pieces[i].text, signal)).replace(/\s*\n\s*/g, ' ').trim();
      });
      const out = texts.map(() => [] as string[]);
      pieces.forEach((p, i) => out[p.owner].push(done[i]));
      return out.map((parts) => parts.join(' ').trim());
    },
    dispose() {},
  };
}

// ---------------- Translator built into Chrome ----------------

interface ChromeTranslator {
  translate(text: string, opts?: { signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface TranslatorApi {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>;
  create(o: { sourceLanguage: string; targetLanguage: string; signal?: AbortSignal; monitor?: (m: EventTarget) => void }): Promise<ChromeTranslator>;
}

interface DetectorApi {
  availability(): Promise<Availability>;
  create(o?: { signal?: AbortSignal }): Promise<{
    detect(text: string, opts?: { signal?: AbortSignal }): Promise<{ detectedLanguage: string; confidence: number }[]>;
    destroy?(): void;
  }>;
}

function api<T>(name: string): T | null {
  return ((globalThis as Record<string, unknown>)[name] as T | undefined) ?? null;
}

/**
 * Browsers built from Chromium without Chrome's translation component (the
 * desktop app, test browsers) have the API but never answer; give up after a while.
 */
function inTime<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

/** True when the browser has a working built-in translator (Chrome on a computer). */
export async function deviceAvailable(): Promise<boolean> {
  const T = api<TranslatorApi>('Translator');
  if (!T) return false;
  try {
    return (await inTime(T.availability({ sourceLanguage: 'en', targetLanguage: 'es' }), 3000, 'unavailable')) !== 'unavailable';
  } catch {
    return false;
  }
}

/** Language of `sample` according to the browser's built-in detector, or null. */
export async function detectLanguage(sample: string, signal: AbortSignal): Promise<string | null> {
  const D = api<DetectorApi>('LanguageDetector');
  if (!D || !sample.trim()) return null;
  try {
    if ((await inTime(D.availability(), 5000, 'unavailable')) === 'unavailable') return null;
    const detector = await D.create({ signal });
    const found = await detector.detect(sample, { signal });
    detector.destroy?.();
    const top = found[0];
    return top && top.detectedLanguage !== 'und' && top.confidence >= 0.4 ? top.detectedLanguage : null;
  } catch {
    if (signal.aborted) throw abortError();
    return null;
  }
}

/**
 * The built-in translator for one pair of languages. The language pack may need to
 * be downloaded first (reported through `onDownload` as a fraction 0…1).
 */
export async function deviceEngine(from: string, to: string, signal: AbortSignal, onDownload: (fraction: number) => void): Promise<Engine> {
  const T = api<TranslatorApi>('Translator');
  if (!T) throw new TranslateError('pair');
  const pair = { sourceLanguage: deviceCode(from), targetLanguage: deviceCode(to) };
  if ((await inTime(T.availability(pair), 5000, 'unavailable')) === 'unavailable') throw new TranslateError('pair');
  const translator = await T.create({
    ...pair,
    signal,
    monitor: (m) => m.addEventListener('downloadprogress', (e) => onDownload((e as ProgressEvent).loaded)),
  });
  return {
    async translate(texts, sig) {
      const out: string[] = [];
      for (const text of texts) out.push(await translator.translate(text, { signal: sig }));
      return out;
    },
    dispose: () => translator.destroy(),
  };
}
