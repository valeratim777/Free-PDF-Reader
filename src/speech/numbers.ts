// Numbers written out as words, for voices that read letters (see letters.ts):
// such a voice skips digits, so "12 %" must reach it as "дванадцять відсотків".
// Only Ukrainian is needed (the one letter-reading voice). Numbers are said in
// the nominative case, as eSpeak says them for the other voices.

const ONES = ['нуль', 'один', 'два', 'три', 'чотири', "п'ять", 'шість', 'сім', 'вісім', "дев'ять"];
const TEENS = ['десять', 'одинадцять', 'дванадцять', 'тринадцять', 'чотирнадцять', "п'ятнадцять", 'шістнадцять', 'сімнадцять', 'вісімнадцять', "дев'ятнадцять"];
const TENS = ['', '', 'двадцять', 'тридцять', 'сорок', "п'ятдесят", 'шістдесят', 'сімдесят', 'вісімдесят', "дев'яносто"];
const HUNDREDS = ['', 'сто', 'двісті', 'триста', 'чотириста', "п'ятсот", 'шістсот', 'сімсот', 'вісімсот', "дев'ятсот"];

/** Word form after a number: 1 → [0], 2–4 → [1], 0 and 5–20 → [2]. */
function form(n: number, forms: [string, string, string]): string {
  const d = n % 100;
  if (d >= 11 && d <= 14) return forms[2];
  return forms[n % 10 === 1 ? 0 : n % 10 >= 2 && n % 10 <= 4 ? 1 : 2];
}

/** 1–999; `feminine` for "тисяча" (одна, дві). */
function triple(n: number, feminine = false): string[] {
  const out: string[] = [];
  if (n >= 100) out.push(HUNDREDS[Math.floor(n / 100)]);
  const r = n % 100;
  if (r >= 10 && r < 20) out.push(TEENS[r - 10]);
  else {
    if (r >= 20) out.push(TENS[Math.floor(r / 10)]);
    const u = r % 10;
    if (u) out.push(feminine && u === 1 ? 'одна' : feminine && u === 2 ? 'дві' : ONES[u]);
  }
  return out;
}

const SCALES: [number, [string, string, string], boolean][] = [
  [1e9, ['мільярд', 'мільярди', 'мільярдів'], false],
  [1e6, ['мільйон', 'мільйони', 'мільйонів'], false],
  [1e3, ['тисяча', 'тисячі', 'тисяч'], true],
];

/** A whole number in words ("2026" → "дві тисячі двадцять шість"). */
export function ukNumber(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0 || n >= 1e12) return String(n).split('').map((d) => ONES[+d] ?? d).join(' ');
  if (n === 0) return ONES[0];
  const out: string[] = [];
  let rest = n;
  for (const [size, forms, feminine] of SCALES) {
    const k = Math.floor(rest / size);
    if (k) out.push(...triple(k, feminine), form(k, forms));
    rest %= size;
  }
  if (rest) out.push(...triple(rest));
  return out.join(' ');
}

/** Every number in `text` written out; long digit runs (phone numbers, codes) digit by digit. */
export function spellNumbers(text: string): string {
  return text
    // "1 000 000" (thousands set apart by spaces) is one number.
    .replace(/(?<!\d)\d{1,3}(?:[   ]\d{3})+(?!\d)/gu, (a) => a.replace(/\D/gu, ''))
    // Dates and versions (12.11.2026, 1.2.1): each part on its own.
    .replace(/\d+(?:[.,]\d+){2,}/gu, (a) => a.split(/[.,]/u).join(' '))
    .replace(/(\d+)[.,](\d+)/gu, (_, a: string, b: string) => `${ukNumber(+a)} кома ${b.length > 3 ? digits(b) : ukNumber(+b)}`)
    .replace(/(\d+)\s*%/gu, (_, a: string) => `${ukNumber(+a)} ${form(+a, ['відсоток', 'відсотки', 'відсотків'])}`)
    .replace(/\d+/gu, (a) => (a.length > 12 || (a.length > 1 && a[0] === '0') ? digits(a) : ukNumber(+a)));
}

function digits(s: string): string {
  return s.split('').map((d) => ONES[+d]).join(' ');
}
