import { describe, expect, it } from 'vitest';
import { detectLang } from '../src/speech/lang';
import { sentences } from '../src/features/readAloud';
import { NEURAL_VOICES, neuralVoicesFor } from '../src/speech/catalog';
import { defaultChoice, systemQuality, type VoiceChoice } from '../src/speech/voices';

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
