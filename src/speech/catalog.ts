// Neural voices for reading aloud: Piper models (https://github.com/rhasspy/piper)
// from the project's voice collection, pinned to one revision. Only voices whose
// recordings may be freely used are listed (public domain, CC0, CC BY).

/** Revision of https://huggingface.co/rhasspy/piper-voices the files are taken from. */
export const VOICES_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/e7229f7d33a10e145e109b886d661984201ac3c4/';

export interface NeuralVoice {
  id: string;
  lang: string;
  /** Name shown in the voice list. */
  name: string;
  female: boolean;
  /** Model file, relative to VOICES_BASE (its settings are next to it, + ".json"). */
  model: string;
  /** Speaker number in a model with several voices. */
  speaker?: number;
  /** Download size in MB (one model may hold several voices). */
  size: number;
  /** Where the recordings come from and their license (for the notices). */
  credit: string;
  /** Tone correction, dB at EQ_CENTERS (polish.ts), measured for this voice. */
  eq?: number[];
  /** Speaking pace: above 1 slower, below 1 faster (evens out voices that rush or drag). */
  pace?: number;
}

const UK_SHARED = 'uk/uk_UA/ukrainian_tts/medium/uk_UA-ukrainian_tts-medium.onnx';

// `eq` and `pace` were measured: each voice read the same text, its long-term spectrum was
// compared with that of natural speech (LTASS, Byrne et al. 1994) and 70% of the difference
// corrected, smoothed (lows below 250 Hz only ever cut, so nothing booms); voices that rush
// or drag are slowed down or sped up a little towards the others of their language.
export const NEURAL_VOICES: NeuralVoice[] = [
  // One model, three voices. It reads letters, not phonemes (see letters.ts). Clearer than the
  // separate "high" models and several times faster: those could not keep up with reading.
  { id: 'uk-tetiana', lang: 'uk', name: 'Тетяна', female: true, model: UK_SHARED, speaker: 2, size: 77, credit: 'ukrainian_tts, CC0', eq: [0, 0, -1, -3.5, -1.5, 0.5, -1, -1.5, 0, 0.5, 0.5, 0, 0, 0.5, 0, 0, 1.5, 2, 1, -0.5] },
  { id: 'uk-mykyta', lang: 'uk', name: 'Микита', female: false, model: UK_SHARED, speaker: 1, size: 77, credit: 'ukrainian_tts, CC0', eq: [0, 0, 0, 0, 1, -0.5, -0.5, 0.5, 2.5, 3, 1.5, 0, -0.5, -1.5, -2.5, -2, -1, 0, 0, -0.5], pace: 0.92 },
  { id: 'uk-lada', lang: 'uk', name: 'Лада', female: true, model: UK_SHARED, speaker: 0, size: 77, credit: 'ukrainian_tts, CC0', eq: [0, 0, 0, 0, 2.5, -0.5, 1, 2.5, 2, 1, 0, -0.5, -0.5, -0.5, -1.5, -2, -2, -1.5, 1.5, 4], pace: 1.07 },
  { id: 'ru-dmitri', lang: 'ru', name: 'Дмитрий', female: false, model: 'ru/ru_RU/dmitri/medium/ru_RU-dmitri-medium.onnx', size: 63, credit: 'OHF-Voice dmitri, CC0', eq: [0, 0, 0, 0, 3, 3, 0, -1.5, -0.5, 2, 2, -0.5, -2, -2, -2, -2.5, -4.5, -5.5, -4.5, -3], pace: 1.12 },
  { id: 'ru-denis', lang: 'ru', name: 'Денис', female: false, model: 'ru/ru_RU/denis/medium/ru_RU-denis-medium.onnx', size: 63, credit: 'OHF-Voice denis, CC0', eq: [0, 0, 0, 0, 1, -0.5, -1, -2, -2.5, 1, 2.5, 1, -1, -1.5, -1.5, 1, 3, 4, 4, 4] },
  { id: 'en-kristin', lang: 'en', name: 'Kristin', female: true, model: 'en/en_US/kristin/medium/en_US-kristin-medium.onnx', size: 64, credit: 'kristin, public domain', eq: [0, 0, -4, -1, 0.5, -0.5, -1.5, -1.5, -1, 0, 1, 2, 3, 2.5, 0.5, -2.5, -4, -5.5, -7, -7], pace: 1.07 },
  { id: 'en-john', lang: 'en', name: 'John', female: false, model: 'en/en_US/john/medium/en_US-john-medium.onnx', size: 64, credit: 'john, public domain', eq: [0, 0, 0, 0, 1, 1.5, 0.5, -1, -0.5, 1, 2, 1, -0.5, -1.5, -1.5, -1, -2, -3.5, -5, -6] },
  { id: 'es-sharvard-f', lang: 'es', name: 'Sharvard', female: true, model: 'es/es_ES/sharvard/medium/es_ES-sharvard-medium.onnx', speaker: 1, size: 77, credit: 'Sharvard corpus, CC BY 3.0', eq: [0, 0, 0, -2, -1, 0, -1.5, -2.5, -2.5, -1, 0.5, 1, 0, 0.5, 2, 2, 0.5, -2.5, -4.5, -4.5] },
  { id: 'es-davefx', lang: 'es', name: 'Davefx', female: false, model: 'es/es_ES/davefx/medium/es_ES-davefx-medium.onnx', size: 63, credit: 'davefx, CC0', eq: [0, 0, 0, 0, 3, 3, 1, 0, 1.5, 3, 2, -1.5, -3.5, -5, -4.5, -1, 2, 1.5, 1.5, 3.5], pace: 1.07 },
  { id: 'es-sharvard-m', lang: 'es', name: 'Sharvard', female: false, model: 'es/es_ES/sharvard/medium/es_ES-sharvard-medium.onnx', speaker: 0, size: 77, credit: 'Sharvard corpus, CC BY 3.0', eq: [0, 0, 0, 0, -1, 0, 0, 0, 0, -0.5, 0, 0, -1, -0.5, 1, 1.5, 0.5, -1, -1.5, -0.5] },
];

export function neuralVoicesFor(lang: string): NeuralVoice[] {
  return NEURAL_VOICES.filter((v) => v.lang === lang);
}
