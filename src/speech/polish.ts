// Makes a synthetic voice pleasant to listen to — what a sound engineer does to a
// voice recording before it goes on air:
//  • the silence the model leaves at the ends is trimmed, so the pauses between
//    sentences are the reader's own and always the same;
//  • rumble below the voice is filtered out;
//  • the voice's tone is corrected towards the average spectrum of natural speech:
//    each voice has its own measured correction (less boom and "barrel", clearer
//    consonants, less hiss), see `eq` in catalog.ts;
//  • loudness is evened out with gentle compression and brought to one level for
//    every voice and sentence; peaks are held below clipping.
// Everything runs on the samples before playback (in the speech worker).

/** Frequencies (Hz) of a voice's tone correction, third-octave apart. */
export const EQ_CENTERS = [100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000];

/** Loudness of speech after polishing (RMS of the voiced part), dBFS. */
export const TARGET_DB = -19;
const CEILING = 10 ** (-1 / 20);

const dbToGain = (db: number) => 10 ** (db / 20);

/** Level of the voiced part: RMS over the 20 ms frames that are not near-silence. */
export function speechLevel(x: Float32Array, rate: number): number {
  const frame = Math.max(1, Math.round(rate * 0.02));
  const energies: number[] = [];
  for (let at = 0; at + frame <= x.length; at += frame) {
    let s = 0;
    for (let i = at; i < at + frame; i++) s += x[i] * x[i];
    energies.push(s / frame);
  }
  const loudest = energies.reduce((a, b) => Math.max(a, b), 0);
  const voiced = energies.filter((e) => e > loudest * 0.0025); // within 26 dB of the loudest frame
  if (!voiced.length || loudest === 0) return -Infinity;
  return 10 * Math.log10(voiced.reduce((a, b) => a + b, 0) / voiced.length);
}

/** Without the silence at the ends (a short margin is kept), faded in and out. */
export function trimSilence(x: Float32Array, rate: number): Float32Array {
  const block = Math.max(1, Math.round(rate * 0.005));
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  if (peak === 0) return new Float32Array(0);
  const threshold = peak * dbToGain(-40);
  let first = -1;
  let last = -1;
  for (let at = 0; at < x.length; at += block) {
    let m = 0;
    for (let i = at; i < Math.min(x.length, at + block); i++) m = Math.max(m, Math.abs(x[i]));
    if (m > threshold) {
      if (first < 0) first = at;
      last = Math.min(x.length, at + block);
    }
  }
  const start = Math.max(0, first - Math.round(rate * 0.015));
  const end = Math.min(x.length, last + Math.round(rate * 0.04));
  const out = x.slice(start, end);
  fade(out, Math.round(rate * 0.005), Math.round(rate * 0.02));
  return out;
}

function fade(x: Float32Array, inLen: number, outLen: number): void {
  for (let i = 0; i < Math.min(inLen, x.length); i++) x[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / inLen);
  for (let i = 0; i < Math.min(outLen, x.length); i++) x[x.length - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / outLen);
}

/** Second-order high-pass (Butterworth): removes rumble below the voice. */
export function highpass(x: Float32Array, rate: number, freq = 70): Float32Array {
  const w = (2 * Math.PI * freq) / rate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / Math.SQRT2;
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0;
  const b1 = -(1 + cos) / a0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let n = 0; n < x.length; n++) {
    const v = b0 * x[n] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[n];
    y2 = y1;
    y1 = v;
    y[n] = v;
  }
  return y;
}

/** Correction in dB at frequency `f`: straight lines between the centres on a log scale. */
function gainAt(eq: number[], f: number): number {
  if (f <= EQ_CENTERS[0]) return eq[0];
  const last = EQ_CENTERS.length - 1;
  if (f >= EQ_CENTERS[last]) return eq[last];
  let i = 0;
  while (EQ_CENTERS[i + 1] < f) i++;
  const t = Math.log(f / EQ_CENTERS[i]) / Math.log(EQ_CENTERS[i + 1] / EQ_CENTERS[i]);
  return eq[i] + t * (eq[i + 1] - eq[i]);
}

const filters = new Map<string, Float32Array>();

/** A linear-phase filter (1023 taps: fine enough for the low notes) with the response `eq` (dB at EQ_CENTERS). */
export function eqFilter(eq: number[], rate: number): Float32Array {
  const key = `${rate}:${eq.join(',')}`;
  let h = filters.get(key);
  if (h) return h;
  const half = 511;
  const bins = 4096;
  const amp = new Float64Array(bins / 2 + 1);
  for (let k = 0; k <= bins / 2; k++) amp[k] = dbToGain(gainAt(eq, (k * rate) / bins));
  h = new Float32Array(2 * half + 1);
  for (let n = -half; n <= half; n++) {
    // Zero-phase impulse response of the sampled magnitude, then a Hann window.
    let s = amp[0] + amp[bins / 2] * Math.cos(Math.PI * n);
    for (let k = 1; k < bins / 2; k++) s += 2 * amp[k] * Math.cos((2 * Math.PI * k * n) / bins);
    h[n + half] = (s / bins) * (0.5 + 0.5 * Math.cos((Math.PI * n) / (half + 1)));
  }
  filters.set(key, h);
  return h;
}

/** `x` through the symmetric filter `h` (odd length, centred: no delay). */
export function applyFilter(x: Float32Array, h: Float32Array): Float32Array {
  const half = (h.length - 1) / 2;
  // Silence around the samples, and the filter's symmetry: one multiplication per pair of taps.
  const padded = new Float32Array(x.length + 2 * half);
  padded.set(x, half);
  const y = new Float32Array(x.length);
  for (let n = 0; n < x.length; n++) {
    const c = n + half;
    let s = h[half] * padded[c];
    for (let k = 1; k <= half; k++) s += h[half + k] * (padded[c - k] + padded[c + k]);
    y[n] = s;
  }
  return y;
}

function gainTo(x: Float32Array, rate: number, targetDb: number): Float32Array {
  const level = speechLevel(x, rate);
  if (!Number.isFinite(level)) return x;
  const g = dbToGain(Math.max(-20, Math.min(24, targetDb - level)));
  return x.map((v) => v * g);
}

/** Gentle compression (2:1 above `thresholdDb`, soft knee): evens out loud and soft syllables. */
export function compress(x: Float32Array, rate: number, thresholdDb = TARGET_DB - 5, ratio = 2): Float32Array {
  const attack = Math.exp(-1 / (rate * 0.01));
  const release = Math.exp(-1 / (rate * 0.12));
  const knee = 6;
  const y = new Float32Array(x.length);
  let env = 0;
  for (let n = 0; n < x.length; n++) {
    const p = x[n] * x[n];
    env = p > env ? attack * env + (1 - attack) * p : release * env + (1 - release) * p;
    const over = 10 * Math.log10(env + 1e-12) - thresholdDb;
    let cut = 0;
    if (over >= knee / 2) cut = over * (1 - 1 / ratio);
    else if (over > -knee / 2) cut = ((1 - 1 / ratio) * (over + knee / 2) ** 2) / (2 * knee);
    y[n] = x[n] * dbToGain(-cut);
  }
  return y;
}

/** Holds peaks at `ceiling`: the gain eases down over 3 ms before a peak and back up over 80 ms. */
export function limit(x: Float32Array, rate: number, ceiling = CEILING): Float32Array {
  const need = new Float32Array(x.length);
  for (let n = 0; n < x.length; n++) need[n] = Math.min(1, ceiling / Math.max(1e-9, Math.abs(x[n])));
  const down = 1 / Math.max(1, Math.round(rate * 0.003));
  const up = 1 / Math.max(1, Math.round(rate * 0.08));
  for (let n = x.length - 2; n >= 0; n--) need[n] = Math.min(need[n], need[n + 1] + down);
  const y = new Float32Array(x.length);
  let g = 1;
  for (let n = 0; n < x.length; n++) {
    g = Math.min(need[n], g + up);
    y[n] = x[n] * g;
  }
  return y;
}

export interface Tone {
  /** The voice's tone correction, dB at EQ_CENTERS. */
  eq?: number[];
}

/** The model's raw output made ready to play (see the top of this file). */
export function polish(pcm: Float32Array, rate: number, tone: Tone = {}): Float32Array {
  let x = trimSilence(pcm, rate);
  if (x.length < rate * 0.03) return x;
  x = highpass(x, rate);
  if (tone.eq?.length === EQ_CENTERS.length && tone.eq.some((g) => g !== 0)) x = applyFilter(x, eqFilter(tone.eq, rate));
  x = gainTo(x, rate, TARGET_DB);
  x = compress(x, rate);
  x = gainTo(x, rate, TARGET_DB);
  x = limit(x, rate);
  fade(x, Math.round(rate * 0.003), Math.round(rate * 0.01));
  return x;
}
