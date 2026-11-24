const fs = require('fs');
const path = require('path');
const { RUNTIMES } = require('./paths');
const { getJson, download, pool } = require('./net');

// Офіційні збірки Java від Mojang (ті ж, що використовує офіційний лаунчер)
const RUNTIME_INDEX =
  'https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

function platformKey() {
  if (process.arch === 'arm64') return 'windows-arm64';
  if (process.arch === 'ia32') return 'windows-x86';
  return 'windows-x64';
}

/**
 * Повертає шлях до java(w).exe потрібної версії, за потреби завантажує її.
 * component — напр. "java-runtime-delta" (Java 21), "jre-legacy" (Java 8).
 */
async function ensureJava(component, onProgress = () => {}, { console: withConsole = false } = {}) {
  const dir = path.join(RUNTIMES, component);
  const exe = path.join(dir, 'bin', withConsole ? 'java.exe' : 'javaw.exe');
  const marker = path.join(dir, '.complete');
  if (fs.existsSync(marker) && fs.existsSync(exe)) return exe;

  onProgress({ text: `Завантаження Java (${component})...`, value: 0 });
  const index = await getJson(RUNTIME_INDEX);
  const entry = index[platformKey()]?.[component]?.[0];
  if (!entry) throw new Error(`Mojang не надає Java "${component}" для цієї системи`);
  const manifest = await getJson(entry.manifest.url);

  const entries = Object.entries(manifest.files);
  for (const [rel, info] of entries) {
    if (info.type === 'directory') fs.mkdirSync(path.join(dir, rel), { recursive: true });
  }
  const files = entries.filter(([, info]) => info.type === 'file');
  let done = 0;
  await pool(files, 16, async ([rel, info]) => {
    await download(info.downloads.raw.url, path.join(dir, rel), info.downloads.raw.sha1);
    done++;
    if (done % 10 === 0 || done === files.length) {
      onProgress({ text: `Завантаження Java: ${done}/${files.length}`, value: done / files.length });
    }
  });
  fs.writeFileSync(marker, entry.version?.name || component);
  return exe;
}

module.exports = { ensureJava };
