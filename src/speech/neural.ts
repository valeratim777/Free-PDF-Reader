// Talks to the speech worker and plays what it produces.
import { VOICES_BASE, type NeuralVoice } from './catalog';
import type { WorkerReply, WorkerRequest } from './piperWorker';

type Pending = {
  resolve: (r: Extract<WorkerReply, { type: 'audio' | 'ready' }>) => void;
  reject: (e: Error) => void;
  progress?: (fraction: number) => void;
};

type Request = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, 'id' | 'assets'> : never) : never;

const assets = () => new URL('speech/', document.baseURI).href;

export class NeuralSpeech {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();

  private get w(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./piperWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<WorkerReply>) => {
        const r = e.data;
        const p = this.pending.get(r.id);
        if (!p) return;
        if (r.type === 'progress') {
          p.progress?.(r.total ? r.loaded / r.total : 0);
          return;
        }
        this.pending.delete(r.id);
        if (r.type === 'error') p.reject(new Error(r.message));
        else p.resolve(r);
      };
      this.worker.onerror = (e) => {
        for (const p of this.pending.values()) p.reject(new Error(e.message || 'speech engine failed'));
        this.pending.clear();
        this.worker?.terminate();
        this.worker = null;
      };
    }
    return this.worker;
  }

  private send(msg: Request, progress?: (f: number) => void) {
    const id = ++this.seq;
    return new Promise<Extract<WorkerReply, { type: 'audio' | 'ready' }>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress });
      this.w.postMessage({ ...msg, id, assets: assets() } as WorkerRequest);
    });
  }

  /** Downloads the voice (once) and gets it ready. */
  async prepare(v: NeuralVoice, progress?: (fraction: number) => void): Promise<void> {
    await this.send({ type: 'prepare', model: VOICES_BASE + v.model }, progress);
  }

  /** Speech for `text` as samples; `speed` 1 is normal. */
  async synth(v: NeuralVoice, text: string, speed: number): Promise<{ pcm: Float32Array; rate: number }> {
    const r = await this.send({ type: 'speak', model: VOICES_BASE + v.model, text, speaker: v.speaker, speed, pace: v.pace, tone: { eq: v.eq } });
    if (r.type !== 'audio') throw new Error('no audio');
    return { pcm: r.pcm, rate: r.rate };
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error('stopped'));
    this.pending.clear();
  }
}

/** True when the voice was downloaded before (no waiting, works offline). */
export async function isDownloaded(v: NeuralVoice): Promise<boolean> {
  try {
    const cache = await caches.open('pr-voices-v1');
    return !!(await cache.match(VOICES_BASE + v.model));
  } catch {
    return false;
  }
}

/** Plays samples one piece after another; can pause, resume and stop. */
export class PcmPlayer {
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private paused = false;

  /**
   * Plays at the voice's own sample rate: the browser then converts to the sound
   * card's rate with its high-quality resampler. A buffer played into a context of
   * another rate is converted by simple interpolation, which adds a metallic sheen.
   */
  private audio(rate: number): AudioContext {
    if (this.ctx && this.ctx.sampleRate !== rate) {
      void this.ctx.close();
      this.ctx = null;
    }
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext({ sampleRate: rate, latencyHint: 'playback' });
      } catch {
        this.ctx = new AudioContext();
      }
      if (this.paused) void this.ctx.suspend();
    }
    return this.ctx;
  }

  /** Resolves when the piece and the `pause` (seconds) after it have played (or on stop). */
  play(pcm: Float32Array, rate: number, pause = 0): Promise<void> {
    const ctx = this.audio(rate);
    // A piece that arrives during a pause waits for "resume".
    if (!this.paused) void ctx.resume();
    const buf = ctx.createBuffer(1, Math.max(1, pcm.length + Math.round(pause * rate)), rate);
    buf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    this.source = src;
    return new Promise((resolve) => {
      src.onended = () => {
        if (this.source === src) this.source = null;
        resolve();
      };
      src.start();
    });
  }

  pause(): void {
    this.paused = true;
    void this.ctx?.suspend();
  }

  resume(): void {
    this.paused = false;
    void this.ctx?.resume();
  }

  stop(): void {
    try {
      this.source?.stop();
    } catch {
      /* not started */
    }
    this.source = null;
  }

  close(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }
}
