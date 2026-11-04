// Neural speech on the device: Piper voices (VITS models) run with ONNX Runtime;
// eSpeak NG turns the text into phonemes first. Runs in a worker so reading aloud
// never stalls the page. The engine files ship with the app (public/speech); a
// voice is downloaded once and kept in the browser's cache.
import * as ort from 'onnxruntime-web/wasm';
import createPiperPhonemize from '@diffusionstudio/piper-wasm/build/piper_phonemize.js';
import { letterIds, type IdMap } from './letters';
import { spellNumbers } from './numbers';

interface VoiceConfig {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  num_speakers: number;
  /** "espeak" (phonemes) or "text" (the voice reads letters). */
  phoneme_type?: string;
  phoneme_id_map: IdMap;
}

export type WorkerRequest =
  | { type: 'prepare'; id: number; assets: string; model: string }
  | { type: 'speak'; id: number; assets: string; model: string; text: string; speaker?: number; speed: number };

export type WorkerReply =
  | { type: 'progress'; id: number; loaded: number; total: number }
  | { type: 'ready'; id: number }
  | { type: 'audio'; id: number; pcm: Float32Array; rate: number }
  | { type: 'error'; id: number; message: string };

const CACHE = 'pr-voices-v1';
const scope = self as unknown as { postMessage(m: WorkerReply, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null };

/** A file from the cache, or downloaded (with progress) and then cached. */
async function cachedBytes(url: string, onProgress?: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
  const cache = await caches.open(CACHE).catch(() => null);
  const hit = await cache?.match(url).catch(() => undefined);
  if (hit) return hit.arrayBuffer();
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  await cache?.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
  return bytes.buffer;
}

// ---- phonemes ----

type Phonemizer = { callMain(args: string[]): void };
let phonemizer: Promise<Phonemizer> | null = null;
let printed: string[] = [];

function getPhonemizer(assets: string): Promise<Phonemizer> {
  phonemizer ??= createPiperPhonemize({
    print: (line: string) => printed.push(line),
    printErr: (line: string) => console.warn('phonemize:', line),
    locateFile: (file: string) => assets + file,
    noInitialRun: true,
  }).catch((e: unknown) => {
    phonemizer = null;
    throw e;
  });
  return phonemizer;
}

async function phonemeIds(assets: string, text: string, voice: string): Promise<number[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = await getPhonemizer(assets);
    printed = [];
    try {
      p.callMain(['-l', voice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
    } catch {
      /* the program may end with exit(); its output is still there */
    }
    const line = printed.find((l) => l.trimStart().startsWith('{'));
    if (line) return (JSON.parse(line) as { phoneme_ids: number[] }).phoneme_ids;
    // An instance may only run once: start a fresh one.
    phonemizer = null;
  }
  throw new Error('phonemizer gave no output');
}

// ---- voices ----

const voices = new Map<string, Promise<{ session: ort.InferenceSession; cfg: VoiceConfig }>>();

function loadVoice(assets: string, url: string, onProgress?: (loaded: number, total: number) => void) {
  let v = voices.get(url);
  if (!v) {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = { 'ort-wasm-simd.wasm': assets + 'ort-wasm-simd.wasm' } as typeof ort.env.wasm.wasmPaths;
    v = (async () => {
      const cfg = JSON.parse(new TextDecoder().decode(await cachedBytes(url + '.json'))) as VoiceConfig;
      const model = await cachedBytes(url, onProgress);
      const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
      return { session, cfg };
    })();
    v.catch(() => voices.delete(url));
    // Keep at most two voices in memory (each takes some 100 MB).
    if (voices.size >= 2) {
      const [oldest] = voices.keys();
      void voices.get(oldest)?.then((x) => x.session.release()).catch(() => {});
      voices.delete(oldest);
    }
    voices.set(url, v);
  }
  return v;
}

async function speak(r: Extract<WorkerRequest, { type: 'speak' }>): Promise<{ pcm: Float32Array; rate: number }> {
  const { session, cfg } = await loadVoice(r.assets, r.model);
  // A voice that reads letters skips digits: they are written out for it (eSpeak does this for the others).
  const ids =
    cfg.phoneme_type === 'text'
      ? letterIds(cfg.espeak.voice === 'uk' ? spellNumbers(r.text) : r.text, cfg.phoneme_id_map)
      : await phonemeIds(r.assets, r.text, cfg.espeak.voice);
  const feeds: Record<string, ort.Tensor> = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, (n) => BigInt(n)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    // A longer length scale means slower speech.
    scales: new ort.Tensor('float32', Float32Array.from([cfg.inference.noise_scale, cfg.inference.length_scale / r.speed, cfg.inference.noise_w]), [3]),
  };
  if (cfg.num_speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(r.speaker ?? 0)]), [1]);
  const out = await session.run(feeds);
  const data = out.output.data as Float32Array;
  return { pcm: new Float32Array(data), rate: cfg.audio.sample_rate };
}

scope.onmessage = async (e) => {
  const r = e.data;
  try {
    if (r.type === 'prepare') {
      const { cfg } = await loadVoice(r.assets, r.model, (loaded, total) => scope.postMessage({ type: 'progress', id: r.id, loaded, total }));
      // Warm up eSpeak too, so the first sentence comes quickly (a voice that reads letters needs none).
      if (cfg.phoneme_type !== 'text') await getPhonemizer(r.assets);
      scope.postMessage({ type: 'ready', id: r.id });
    } else {
      const { pcm, rate } = await speak(r);
      scope.postMessage({ type: 'audio', id: r.id, pcm, rate }, [pcm.buffer]);
    }
  } catch (err) {
    scope.postMessage({ type: 'error', id: r.id, message: String((err as Error)?.message ?? err) });
  }
};
