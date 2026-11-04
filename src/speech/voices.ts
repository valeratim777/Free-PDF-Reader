// The voices "Read aloud" can use for a language, best first:
//  • on a computer and in the browser — the built-in neural voices (Piper) for
//    Russian, Ukrainian, English and Spanish, plus the system's own voices
//    (Edge's "Natural" voices are excellent and come first when present);
//  • in the Android app — the phone's speech engine.
import { neuralVoicesFor, type NeuralVoice } from './catalog';

export type VoiceKind = 'neural' | 'system' | 'device';

export interface VoiceChoice {
  key: string;
  kind: VoiceKind;
  label: string;
  /** Higher is better; used to pick the default. */
  quality: number;
  neural?: NeuralVoice;
  system?: SpeechSynthesisVoice;
  device?: { id: string; network: boolean };
}

export interface AndroidSpeech {
  voices(o: { lang: string }): Promise<{ voices: { id: string; locale: string; network: boolean; quality: number }[]; default?: string }>;
  speak(o: { text: string; lang: string; voice?: string; rate: number }): Promise<{ interrupted?: boolean } | undefined>;
  stop(): Promise<void>;
}

let android: Promise<AndroidSpeech> | null = null;

/** The Android app's speech plugin (see SpeechPlugin.java). */
export function androidSpeech(): Promise<AndroidSpeech> {
  android ??= import('@capacitor/core').then(({ registerPlugin }) => registerPlugin<AndroidSpeech>('Speech'));
  return android;
}

/** Voices of the browser / operating system (the list may arrive a moment late). */
export async function systemVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!('speechSynthesis' in window)) return [];
  const now = speechSynthesis.getVoices();
  if (now.length) return now;
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
}

/** How natural a system voice usually sounds, judging by its name. */
export function systemQuality(v: Pick<SpeechSynthesisVoice, 'name' | 'localService'>): number {
  if (/natural|neural|online/i.test(v.name)) return 4;
  if (/google|premium|enhanced|siri/i.test(v.name)) return 2;
  return v.localService === false ? 1.5 : 1;
}

/** Whether the built-in neural voices can run here. */
export function neuralSupported(): boolean {
  return typeof Worker !== 'undefined' && typeof AudioContext !== 'undefined' && typeof WebAssembly !== 'undefined' && 'caches' in window;
}

export interface Labels {
  neural(v: NeuralVoice): string;
  device(n: number, network: boolean): string;
}

const sameLang = (code: string, lang: string) => code.toLowerCase().replace('_', '-').split('-')[0] === lang;

export async function voiceChoices(lang: string, opts: { android: boolean; neural: boolean; labels: Labels }): Promise<VoiceChoice[]> {
  if (opts.android) {
    try {
      const { voices } = await (await androidSpeech()).voices({ lang });
      // Voices that work offline first; the engine's "network" voices are often nicer but need the internet.
      return voices
        .sort((a, b) => b.quality - a.quality || Number(a.network) - Number(b.network))
        .map((v, i) => ({ key: `device:${v.id}`, kind: 'device' as const, label: opts.labels.device(i + 1, v.network), quality: 3 + v.quality / 1000, device: { id: v.id, network: v.network } }));
    } catch {
      return [];
    }
  }
  const out: VoiceChoice[] = [];
  if (opts.neural) for (const v of neuralVoicesFor(lang)) out.push({ key: `neural:${v.id}`, kind: 'neural', label: opts.labels.neural(v), quality: 3, neural: v });
  const system = (await systemVoices()).filter((v) => sameLang(v.lang, lang));
  for (const v of system) out.push({ key: `system:${v.voiceURI || v.name}`, kind: 'system', label: v.name, quality: systemQuality(v), system: v });
  // Stable order: the best kind first, then as listed.
  return out.map((c, i) => [c, i] as const).sort((a, b) => b[0].quality - a[0].quality || a[1] - b[1]).map(([c]) => c);
}

/** The voice to start with: the one picked before, or the best available. */
export function defaultChoice(choices: VoiceChoice[], savedKey: string | null): VoiceChoice | null {
  return choices.find((c) => c.key === savedKey) ?? choices[0] ?? null;
}
