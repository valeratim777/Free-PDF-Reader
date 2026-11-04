// Languages offered for translation (codes as Google Translate uses them).
import type { FontKey } from '../model';

export const TRANSLATE_LANGS = [
  'en', 'ru', 'uk', 'be', 'kk', 'uz', 'ky', 'tg', 'tt', 'az', 'hy', 'ka', 'mn',
  'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'cs', 'sk', 'sl', 'hr', 'sr', 'bs', 'mk', 'bg', 'ro', 'hu',
  'el', 'tr', 'sv', 'no', 'da', 'fi', 'is', 'et', 'lv', 'lt', 'sq', 'ca', 'eu', 'gl', 'ga', 'cy', 'la', 'eo',
  'af', 'sw', 'id', 'ms', 'tl', 'vi',
  'zh-CN', 'zh-TW', 'ja', 'ko', 'ar', 'he', 'fa', 'ur', 'hi', 'bn', 'th',
];

/**
 * Languages whose letters the fonts built into the app have, so a translation into
 * them can be written into the PDF. Right-to-left scripts and the scripts of
 * China, Japan, Korea, India and Thailand are only offered as a text file.
 */
const NOT_IN_PDF = new Set(['zh-CN', 'zh-TW', 'ja', 'ko', 'ar', 'he', 'fa', 'ur', 'hi', 'bn', 'th']);

/** The monospaced font lacks some letters of these languages; the sans one is used instead. */
const NOT_IN_MONO = new Set(['vi', 'tg', 'hy', 'ka']);

export function pdfWritable(code: string): boolean {
  return !NOT_IN_PDF.has(code);
}

export function fontFor(code: string, wanted: FontKey): FontKey {
  return wanted === 'mono' && NOT_IN_MONO.has(code) ? 'sans' : wanted;
}

/** Code for the translator built into Chrome (BCP 47). */
export function deviceCode(code: string): string {
  if (code === 'zh-CN') return 'zh';
  if (code === 'zh-TW') return 'zh-Hant';
  return code;
}

let names: Intl.DisplayNames | null = null;
let namesLang = '';

/** Name of the language in the interface language ("Немецкий", "German"). */
export function langName(code: string, ui: string): string {
  try {
    if (!names || namesLang !== ui) {
      names = new Intl.DisplayNames([ui], { type: 'language' });
      namesLang = ui;
    }
    const n = names.of(code);
    if (n && n !== code) return n.charAt(0).toLocaleUpperCase(ui) + n.slice(1);
  } catch {
    /* fall through */
  }
  return code;
}

/** Languages sorted by their names in the interface language. */
export function sortedLangs(ui: string): { code: string; name: string }[] {
  return TRANSLATE_LANGS.map((code) => ({ code, name: langName(code, ui) })).sort((a, b) => a.name.localeCompare(b.name, ui));
}
