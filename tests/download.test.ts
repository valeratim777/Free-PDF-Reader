import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const { downloadChecked } = createRequire(import.meta.url)('../electron/download.cjs') as {
  downloadChecked(fetchFn: typeof fetch, url: string, file: string, sha256: string, onProgress?: (f: number) => void): Promise<string>;
};

const data = new Uint8Array(3_000_000).map((_, i) => (i * 7) & 255);
const sha = createHash('sha256').update(data).digest('hex');
let server: Server;
let url = '';
const dir = mkdtempSync(join(tmpdir(), 'pr-update-'));

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/missing') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Length': data.length, 'Content-Type': 'application/octet-stream' });
    res.end(Buffer.from(data));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  url = `http://127.0.0.1:${addr.port}/PDF-Reader-Setup-9.9.9.exe`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('downloading an update (desktop app)', () => {
  it('saves the file when the checksum matches and reports progress', async () => {
    const file = join(dir, 'ok.exe');
    const seen: number[] = [];
    await downloadChecked(fetch, url, file, sha.toUpperCase(), (f) => seen.push(f));
    expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(sha);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('deletes a damaged download', async () => {
    const file = join(dir, 'bad.exe');
    await expect(downloadChecked(fetch, url, file, '0'.repeat(64))).rejects.toThrow('damaged');
    expect(existsSync(file)).toBe(false);
  });

  it('reports HTTP errors', async () => {
    await expect(downloadChecked(fetch, url.replace(/[^/]+$/, 'missing'), join(dir, 'x.exe'), sha)).rejects.toThrow('HTTP 404');
  });
});
