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
}

export const NEURAL_VOICES: NeuralVoice[] = [
  // Separate high-quality models: clearer than the shared three-voice model (which sounded choppy).
  { id: 'uk-tetiana-high', lang: 'uk', name: 'Тетяна', female: true, model: 'uk/uk_UA/tetiana/high/uk_UA-tetiana-high.onnx', size: 114, credit: 'ukrainian-tts-datasets, Apache-2.0' },
  { id: 'uk-mykyta-high', lang: 'uk', name: 'Микита', female: false, model: 'uk/uk_UA/mykyta/high/uk_UA-mykyta-high.onnx', size: 114, credit: 'ukrainian-tts-datasets, Apache-2.0' },
  { id: 'uk-oleksa-high', lang: 'uk', name: 'Олекса', female: false, model: 'uk/uk_UA/oleksa/high/uk_UA-oleksa-high.onnx', size: 114, credit: 'ukrainian-tts-datasets, Apache-2.0' },
  { id: 'uk-lada', lang: 'uk', name: 'Лада', female: true, model: 'uk/uk_UA/ukrainian_tts/medium/uk_UA-ukrainian_tts-medium.onnx', speaker: 0, size: 77, credit: 'ukrainian_tts, CC0' },
  { id: 'ru-dmitri', lang: 'ru', name: 'Дмитрий', female: false, model: 'ru/ru_RU/dmitri/medium/ru_RU-dmitri-medium.onnx', size: 63, credit: 'OHF-Voice dmitri, CC0' },
  { id: 'ru-denis', lang: 'ru', name: 'Денис', female: false, model: 'ru/ru_RU/denis/medium/ru_RU-denis-medium.onnx', size: 63, credit: 'OHF-Voice denis, CC0' },
  { id: 'en-kristin', lang: 'en', name: 'Kristin', female: true, model: 'en/en_US/kristin/medium/en_US-kristin-medium.onnx', size: 64, credit: 'kristin, public domain' },
  { id: 'en-john', lang: 'en', name: 'John', female: false, model: 'en/en_US/john/medium/en_US-john-medium.onnx', size: 64, credit: 'john, public domain' },
  { id: 'es-sharvard-f', lang: 'es', name: 'Sharvard', female: true, model: 'es/es_ES/sharvard/medium/es_ES-sharvard-medium.onnx', speaker: 1, size: 77, credit: 'Sharvard corpus, CC BY 3.0' },
  { id: 'es-davefx', lang: 'es', name: 'Davefx', female: false, model: 'es/es_ES/davefx/medium/es_ES-davefx-medium.onnx', size: 63, credit: 'davefx, CC0' },
  { id: 'es-sharvard-m', lang: 'es', name: 'Sharvard', female: false, model: 'es/es_ES/sharvard/medium/es_ES-sharvard-medium.onnx', speaker: 0, size: 77, credit: 'Sharvard corpus, CC BY 3.0' },
];

export function neuralVoicesFor(lang: string): NeuralVoice[] {
  return NEURAL_VOICES.filter((v) => v.lang === lang);
}
