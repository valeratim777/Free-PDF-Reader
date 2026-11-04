// Reads the look of rendered text from canvas pixels: background and text
// colors, and how heavy the strokes are (to tell bold from regular).

export interface Ink {
  bg: string;
  fg: string;
  /** Typical vertical stroke width relative to the font size (≈0.08 regular, ≈0.18 bold); 0 when unknown. */
  stem: number;
}

const hex = (c: number[]) => '#' + c.map((v) => Math.min(255, v).toString(16).padStart(2, '0')).join('');

/** `data` is RGBA pixels of a w × h area; `fontPx` the font size in those pixels. */
export function analyzeInk(data: Uint8ClampedArray, w: number, h: number, fontPx = 0): Ink {
  // Background: the most frequent color (averaged within its group, so white stays
  // exactly white); foreground: the color farthest from it.
  const counts = new Map<number, number[]>();
  for (let i = 0; i < data.length; i += 4) {
    const c = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    const acc = counts.get(c);
    if (acc) {
      acc[0]++;
      acc[1] += data[i];
      acc[2] += data[i + 1];
      acc[3] += data[i + 2];
    } else counts.set(c, [1, data[i], data[i + 1], data[i + 2]]);
  }
  let top: number[] | null = null;
  for (const acc of counts.values()) if (!top || acc[0] > top[0]) top = acc;
  const bg = top ? [Math.round(top[1] / top[0]), Math.round(top[2] / top[0]), Math.round(top[3] / top[0])] : [255, 255, 255];
  let fg = [0, 0, 0];
  let far = -1;
  for (let i = 0; i < data.length; i += 4) {
    const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
    if (d > far) {
      far = d;
      fg = [data[i], data[i + 1], data[i + 2]];
    }
  }
  // Horizontal runs of "ink" pixels approximate the vertical stem width.
  const runs: number[] = [];
  const inkAt = (i: number) => Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > far * 0.5;
  for (let row = 0; row < h; row++) {
    let run = 0;
    for (let col = 0; col < w; col++) {
      if (inkAt((row * w + col) * 4)) run++;
      else if (run) {
        runs.push(run);
        run = 0;
      }
    }
    if (run) runs.push(run);
  }
  runs.sort((a, b) => a - b);
  const stem = runs.length > 10 && fontPx > 0 ? runs[Math.floor(runs.length / 2)] / fontPx : 0;
  return { bg: hex(bg), fg: far < 60 ? '#000000' : hex(fg), stem };
}
