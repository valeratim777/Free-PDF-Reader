import { describe, expect, it } from 'vitest';
import { detectLang } from '../src/speech/lang';
import { endsSentence, sentences } from '../src/features/readAloud';
import { NEURAL_VOICES, neuralVoicesFor } from '../src/speech/catalog';
import { defaultChoice, systemQuality, type VoiceChoice } from '../src/speech/voices';
import { letterIds } from '../src/speech/letters';
import { spellNumbers, ukNumber } from '../src/speech/numbers';
import { EQ_CENTERS, TARGET_DB, eqFilter, highpass, limit, polish, speechLevel, trimSilence } from '../src/speech/polish';

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

describe('polishing the voice', () => {
  const rate = 22050;
  const tone = (freq: number, seconds: number, amp: number) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));
  const join = (...parts: Float32Array[]) => {
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  /** Gain of filter `h` at `freq`, dB. */
  const response = (h: Float32Array, freq: number) => {
    let re = 0;
    let im = 0;
    h.forEach((v, n) => {
      re += v * Math.cos((2 * Math.PI * freq * n) / rate);
      im -= v * Math.sin((2 * Math.PI * freq * n) / rate);
    });
    return 20 * Math.log10(Math.hypot(re, im));
  };
  const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

  it('trims the silence at the ends, keeping a short margin', () => {
    const x = join(new Float32Array(rate * 0.3), tone(300, 1, 0.3), new Float32Array(rate * 0.3));
    const y = trimSilence(x, rate);
    expect(y.length / rate).toBeGreaterThan(1);
    expect(y.length / rate).toBeLessThan(1.1);
    expect(Math.abs(y[0])).toBeLessThan(1e-3);
    expect(trimSilence(new Float32Array(1000), rate).length).toBe(0);
  });

  it('shapes the tone as asked', () => {
    const flat = eqFilter(EQ_CENTERS.map(() => 0), rate);
    for (const f of [150, 1000, 5000]) expect(Math.abs(response(flat, f))).toBeLessThan(0.3);
    const eq = EQ_CENTERS.map((c) => (c >= 125 && c <= 200 ? -6 : c === 3150 ? 3 : 0));
    const h = eqFilter(eq, rate);
    expect(response(h, 160)).toBeCloseTo(-6, 0);
    expect(response(h, 3150)).toBeGreaterThan(2);
    expect(Math.abs(response(h, 800))).toBeLessThan(0.5);
  });

  it('removes rumble below the voice', () => {
    const low = highpass(tone(30, 1, 0.5), rate);
    const voice = highpass(tone(300, 1, 0.5), rate);
    expect(peak(low.subarray(rate / 2))).toBeLessThan(0.1);
    expect(peak(voice.subarray(rate / 2))).toBeGreaterThan(0.45);
  });

  it('brings quiet and loud voices to one level without clipping', () => {
    for (const amp of [0.01, 0.1, 0.99]) {
      const y = polish(join(tone(220, 0.5, amp), tone(440, 0.5, amp * 0.3)), rate);
      expect(Math.abs(speechLevel(y, rate) - TARGET_DB)).toBeLessThan(1.5);
      expect(peak(y)).toBeLessThanOrEqual(10 ** (-1 / 20) + 1e-6);
    }
    expect(polish(new Float32Array(500), rate).length).toBe(0);
  });

  it('holds peaks below the ceiling', () => {
    const y = limit(tone(200, 0.2, 2), rate, 0.5);
    expect(peak(y)).toBeLessThanOrEqual(0.5 + 1e-6);
  });

  it('knows where sentences end', () => {
    expect(endsSentence('Это конец.')).toBe(true);
    expect(endsSentence('«Правда?»')).toBe(true);
    expect(endsSentence('часть длинного предложения,')).toBe(false);
  });
});
