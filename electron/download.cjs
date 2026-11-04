// Downloads a file to disk while computing its SHA-256 and reporting progress;
// a file whose checksum does not match the expected one is deleted.
const crypto = require('node:crypto');
const fs = require('node:fs');

async function downloadChecked(fetchFn, url, file, sha256, onProgress = () => {}) {
  const res = await fetchFn(url, { credentials: 'omit' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(file);
  let got = 0;
  let last = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      got += value.length;
      if (!out.write(value)) await new Promise((r) => out.once('drain', r));
      if (Date.now() - last > 150) {
        last = Date.now();
        onProgress(total ? got / total : 0);
      }
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (sha256 && hash.digest('hex') !== String(sha256).toLowerCase()) {
    fs.rmSync(file, { force: true });
    throw new Error('the download is damaged');
  }
  onProgress(1);
  return file;
}

module.exports = { downloadChecked };
