import { describe, expect, it } from 'vitest';
import { detectLang } from '../src/speech/lang';
import { sentences } from '../src/features/readAloud';
import { NEURAL_VOICES, neuralVoicesFor } from '../src/speech/catalog';
import { defaultChoice, systemQuality, type VoiceChoice } from '../src/speech/voices';
import { letterIds } from '../src/speech/letters';
import { spellNumbers, ukNumber } from '../src/speech/numbers';

describe('language of a paragraph', () => {
  it('tells Russian from Ukrainian', () => {
    expect(detectLang('Третий квартал стал самым успешным в истории компании, выручка выросла.')).toBe('ru');
    expect(detectLang('Третій квартал став найуспішнішим в історії компанії, виторг зріс.')).toBe('uk');
    expect(detectLang('Їжак і ґанок — це слова, які є лише в українській.')).toBe('uk');
  });

  it('tells English from Spanish and other Latin-script languages', () => {
    expect(detectLang('The third quarter was the strongest in the history of the company.')).toBe('en');
    expect(detectLang('El tercer trimestre fue el más fuerte en la historia de la empresa.')).toBe('es');
    expect(detectLang('¿Dónde está la estación? Mañana iré con mi niña.')).toBe('es');
    expect(detectLang('Das dritte Quartal war das stärkste in der Geschichte der Firma und es ist gut.')).toBe('de');
    expect(detectLang('Le troisième trimestre a été le plus fort de l’histoire de la société.')).toBe('fr');
  });

  it('uses the fallback when a piece says too little', () => {
    expect(detectLang('12 345', 'uk')).toBe('uk');
    expect(detectLang('Москва', 'uk')).toBe('uk');
    expect(detectLang('Москва', 'en')).toBe('ru');
    expect(detectLang('OK', 'es')).toBe('es');
  });

  it('knows other scripts', () => {
    expect(detectLang('Καλημέρα κόσμε')).toBe('el');
    expect(detectLang('こんにちは世界')).toBe('ja');
    expect(detectLang('你好世界，今天天气很好')).toBe('zh');
    expect(detectLang('مرحبا بالعالم')).toBe('ar');
  });
});

describe('pieces to say', () => {
  it('splits sentences and keeps very short ones with the next', () => {
    expect(sentences('Good morning! This is a test. Fig. 3. Results follow.')).toEqual(['Good morning! This is a test.', 'Fig. 3. Results follow.']);
  });

  it('cuts very long sentences at commas and then between words', () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const parts = sentences(`${long}, ${long}.`, 200);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(200);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(`${long}, ${long}.`);
  });
});

describe('voices', () => {
  it('has neural voices for Russian, Ukrainian, English and Spanish', () => {
    for (const lang of ['ru', 'uk', 'en', 'es']) expect(neuralVoicesFor(lang).length).toBeGreaterThanOrEqual(2);
    expect(new Set(NEURAL_VOICES.map((v) => v.id)).size).toBe(NEURAL_VOICES.length);
  });

  it('prefers natural system voices, then the remembered choice', () => {
    expect(systemQuality({ name: 'Microsoft Polina Online (Natural) - Ukrainian (Ukraine)', localService: false })).toBeGreaterThan(3);
    expect(systemQuality({ name: 'Microsoft Irina - Russian (Russia)', localService: true })).toBeLessThan(3);
    const a = { key: 'a', quality: 3 } as VoiceChoice;
    const b = { key: 'b', quality: 1 } as VoiceChoice;
    expect(defaultChoice([a, b], null)).toBe(a);
    expect(defaultChoice([a, b], 'b')).toBe(b);
    expect(defaultChoice([a, b], 'gone')).toBe(a);
    expect(defaultChoice([], null)).toBeNull();
  });
});

describe('voices that read letters', () => {
  // Part of the shared Ukrainian model's table.
  const map: Record<string, number[]> = { _: [0], '^': [1], $: [2], ' ': [3], '!': [4], "'": [5], ',': [6], '—': [48], 'а': [12], 'ж': [20], 'и': [22], 'і': [23], 'й': [25], 'к': [26], 'м': [28], 'т': [34], 'я': [44], '\u0306': [46], '\u0308': [47] };

  it('numbers the letters as Piper does: lower case, marks split off, pads between', () => {
    // ї → і + ¨, й → и + ˘; ʼ is the apostrophe; « » are not in the table.
    expect(letterIds('  Мʼята й «їжак»!  ', map)).toEqual([1, 0, 28, 0, 5, 0, 44, 0, 34, 0, 12, 0, 3, 0, 22, 0, 46, 0, 3, 0, 23, 0, 47, 0, 20, 0, 12, 0, 26, 0, 4, 0, 2]);
    expect(letterIds('а – а', map)).toEqual([1, 0, 12, 0, 3, 0, 48, 0, 3, 0, 12, 0, 2]);
  });

  it('writes Ukrainian numbers out in words', () => {
    expect(ukNumber(0)).toBe('нуль');
    expect(ukNumber(21)).toBe('двадцять один');
    expect(ukNumber(2026)).toBe('дві тисячі двадцять шість');
    expect(ukNumber(21000)).toBe('двадцять одна тисяча');
    expect(ukNumber(2345678)).toBe("два мільйони триста сорок п'ять тисяч шістсот сімдесят вісім");
    expect(spellNumbers('Виторг зріс на 12% у 2026 році.')).toBe('Виторг зріс на дванадцять відсотків у дві тисячі двадцять шість році.');
    expect(spellNumbers('22 % і 3,5 грн')).toBe("двадцять два відсотки і три кома п'ять грн");
    expect(spellNumbers('Бюджет 1 000 000 гривень')).toBe('Бюджет один мільйон гривень');
    expect(spellNumbers('12.11.2026')).toBe('дванадцять одинадцять дві тисячі двадцять шість');
    expect(spellNumbers('тел. 044')).toBe('тел. нуль чотири чотири');
  });

  it('has one model for the three Ukrainian voices', () => {
    const uk = neuralVoicesFor('uk');
    expect(uk.map((v) => v.name)).toEqual(['Тетяна', 'Микита', 'Лада']);
    expect(new Set(uk.map((v) => v.model)).size).toBe(1);
    expect(new Set(uk.map((v) => v.speaker)).size).toBe(3);
  });
});
