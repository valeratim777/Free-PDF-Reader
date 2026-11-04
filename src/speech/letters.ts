// Some Piper voices were trained on letters rather than on eSpeak phonemes
// ("phoneme_type": "text" in their settings, e.g. the shared Ukrainian model).
// Such a voice must get the letters themselves, numbered by its own table, the
// way Piper does it: lower case, each letter split into its base and marks
// (й → и + ˘), a pad between symbols, start and end marks around. Fed eSpeak
// phonemes instead, it mumbles.

export type IdMap = Record<string, number[]>;

/** Look-alike characters the tables do not have, written the way they do. */
const SAME: Record<string, string> = {
  '’': "'", // ’ (Ukrainian apostrophe: м’ята)
  'ʼ': "'", // ʼ
  '‘': "'",
  '`': "'",
  '–': '—', // – → —
  '…': '...', // …
};

export function letterIds(text: string, map: IdMap): number[] {
  const symbols: string[] = [];
  for (const raw of text.toLocaleLowerCase().normalize('NFD')) {
    for (const c of SAME[raw] ?? (/\s/u.test(raw) ? ' ' : raw)) {
      // A symbol the voice does not know (quotes, brackets…) is left out; spaces only between words.
      if (!map[c] || (c === ' ' && (!symbols.length || symbols[symbols.length - 1] === ' '))) continue;
      symbols.push(c);
    }
  }
  while (symbols[symbols.length - 1] === ' ') symbols.pop();
  const pad = map['_'] ?? [];
  const ids: number[] = [...(map['^'] ?? []), ...pad];
  for (const c of symbols) ids.push(...map[c], ...pad);
  ids.push(...(map['$'] ?? []));
  return ids;
}
