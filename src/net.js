const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const UA = 'ULauncher/1.0 (Electron)';

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.text();
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

/** Завантажує файл (з перевіркою sha1, якщо вказано). Пропускає вже наявний коректний файл. */
async function download(url, dest, sha1) {
  if (fs.existsSync(dest)) {
    if (!sha1) return dest;
    if ((await sha1File(dest)) === sha1) return dest;
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (sha1) {
        const got = crypto.createHash('sha1').update(buf).digest('hex');
        if (got !== sha1) throw new Error(`Невірна контрольна сума: ${path.basename(dest)}`);
      }
      const tmp = dest + '.part';
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, dest);
      return dest;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Виконує fn для кожного елемента, не більше `limit` одночасно. */
async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

module.exports = { UA, getJson, getText, download, pool, sha1File };
