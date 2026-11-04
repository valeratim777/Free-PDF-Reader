// Which language a piece of text is in, so it is read with a voice of that
// language: a Ukrainian paragraph with a Ukrainian voice, an English quote in an
// otherwise Russian document with an English one. Script first (Cyrillic, Latin,
// Greek…), then the letters and common words that tell languages of one script apart.

const SCRIPTS: [RegExp, string][] = [
  [/\p{Script=Greek}/u, 'el'],
  [/\p{Script=Arabic}/u, 'ar'],
  [/\p{Script=Hebrew}/u, 'he'],
  [/\p{Script=Hangul}/u, 'ko'],
  [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, 'ja'],
  [/\p{Script=Han}/u, 'zh'],
  [/\p{Script=Devanagari}/u, 'hi'],
  [/\p{Script=Thai}/u, 'th'],
  [/\p{Script=Armenian}/u, 'hy'],
  [/\p{Script=Georgian}/u, 'ka'],
];

/** Frequent short words; a handful of hits is enough to tell the language. */
const WORDS: Record<string, string[]> = {
  en: ['the', 'and', 'of', 'to', 'is', 'in', 'that', 'it', 'for', 'with', 'was', 'on', 'are', 'this', 'be', 'by', 'you', 'not', 'have', 'from', 'or', 'which', 'we', 'an', 'at', 'as'],
  es: ['el', 'la', 'de', 'que', 'y', 'los', 'las', 'en', 'por', 'una', 'un', 'para', 'con', 'del', 'se', 'es', 'su', 'al', 'lo', 'como', 'más', 'pero', 'sus', 'le', 'ya', 'o', 'este', 'sí', 'porque', 'esta', 'entre', 'cuando', 'muy', 'sin', 'sobre', 'también', 'hay', 'donde', 'han', 'fue', 'son', 'está'],
  de: ['der', 'die', 'und', 'das', 'ist', 'nicht', 'ein', 'eine', 'zu', 'den', 'mit', 'sich', 'des', 'auf', 'für', 'im', 'dem', 'auch', 'es', 'an', 'werden', 'aus', 'er', 'hat', 'dass', 'sie', 'nach', 'wird', 'bei', 'einer', 'um', 'noch', 'wie', 'über', 'oder', 'sind'],
  fr: ['le', 'la', 'les', 'de', 'des', 'et', 'est', 'un', 'une', 'du', 'que', 'qui', 'dans', 'pour', 'pas', 'au', 'sur', 'ne', 'se', 'ce', 'il', 'elle', 'par', 'avec', 'sont', 'nous', 'vous', 'mais', 'ou', 'aux', 'cette', 'été'],
  it: ['il', 'di', 'che', 'e', 'la', 'per', 'un', 'una', 'non', 'in', 'sono', 'del', 'della', 'le', 'gli', 'con', 'si', 'da', 'al', 'ha', 'lo', 'come', 'anche', 'nel', 'nella', 'questo', 'più', 'ma', 'dei', 'alla'],
  pt: ['o', 'a', 'de', 'que', 'e', 'do', 'da', 'em', 'um', 'uma', 'para', 'com', 'não', 'os', 'as', 'no', 'na', 'se', 'por', 'mais', 'dos', 'das', 'como', 'mas', 'foi', 'ao', 'ele', 'ela', 'seu', 'sua', 'ou', 'são', 'está'],
  nl: ['de', 'het', 'een', 'en', 'van', 'is', 'dat', 'op', 'te', 'zijn', 'met', 'voor', 'niet', 'aan', 'er', 'ook', 'als', 'bij', 'door', 'maar', 'om', 'wordt', 'naar', 'uit', 'kan', 'tot'],
  pl: ['i', 'w', 'nie', 'na', 'się', 'jest', 'z', 'do', 'to', 'że', 'o', 'jak', 'ale', 'po', 'co', 'tak', 'za', 'od', 'są', 'przez', 'dla', 'czy', 'tym', 'jego', 'tylko', 'być', 'może'],
};

/** Letters that only (or mostly) occur in one language of the Latin script. */
const LETTERS: [RegExp, string, number][] = [
  [/[ñ¿¡]/giu, 'es', 3],
  [/[ãõ]/giu, 'pt', 3],
  [/[ß]/giu, 'de', 3],
  [/[äöü]/giu, 'de', 1],
  [/[èêàçœ]/giu, 'fr', 1],
  [/[ąęłśżźćń]/giu, 'pl', 3],
];

/**
 * Language of `text` as a two-letter code. `fallback` is used when the text says
 * too little (a number, a name), and is preferred when it fits the script.
 */
export function detectLang(text: string, fallback = 'en'): string {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 2) return fallback;
  const sample = letters.join('');
  for (const [re, code] of SCRIPTS) {
    const n = (sample.match(new RegExp(re.source, 'gu')) ?? []).length;
    if (n > letters.length * 0.3) return code;
  }
  const cyr = (sample.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  if (cyr > letters.length * 0.5) return cyrillicLang(text, fallback);
  return latinLang(text, fallback);
}

function cyrillicLang(text: string, fallback: string): string {
  const count = (re: RegExp) => (text.match(re) ?? []).length;
  const uk = count(/[іїєґІЇЄҐ]/gu);
  const ru = count(/[ыэъёЫЭЪЁ]/gu);
  const be = count(/[ўЎ]/gu);
  const sr = count(/[ђћџјљњЂЋЏЈЉЊ]/gu);
  if (be && be >= uk) return 'be';
  if (sr > 1) return 'sr';
  if (uk > ru) return 'uk';
  if (ru > uk) return 'ru';
  return ['ru', 'uk', 'be', 'bg', 'sr', 'mk', 'kk'].includes(fallback) ? fallback : 'ru';
}

function latinLang(text: string, fallback: string): string {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const score: Record<string, number> = {};
  for (const [lang, list] of Object.entries(WORDS)) {
    const set = new Set(list);
    score[lang] = words.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
  }
  for (const [re, lang, weight] of LETTERS) score[lang] = (score[lang] ?? 0) + (text.match(re) ?? []).length * weight;
  // Accented vowels lean Spanish (é alone is just as French).
  score.es += (text.match(/[áíóú]/giu) ?? []).length * 0.5;
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (!best || best[1] < 2 || best[1] === second?.[1]) return Object.keys(WORDS).includes(fallback) ? fallback : 'en';
  return best[0];
}
