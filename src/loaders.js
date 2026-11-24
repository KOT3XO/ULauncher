const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { SHARED, CACHE } = require('./paths');
const { getJson, getText, download } = require('./net');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
let manifestCache = null;

async function getManifest() {
  if (manifestCache && Date.now() - manifestCache.time < 10 * 60 * 1000) return manifestCache.data;
  const file = path.join(CACHE, 'version_manifest_v2.json');
  try {
    const data = await getJson(MANIFEST_URL);
    fs.writeFileSync(file, JSON.stringify(data));
    manifestCache = { time: Date.now(), data };
    return data;
  } catch (e) {
    // Без інтернету — беремо збережену копію
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    throw e;
  }
}

async function listMinecraftVersions(includeSnapshots) {
  const m = await getManifest();
  return m.versions
    .filter((v) => v.type === 'release' || (includeSnapshots && v.type === 'snapshot'))
    .map((v) => ({ id: v.id, type: v.type }));
}

/** JSON ванільної версії (потрібен, щоб знати, яка Java потрібна). */
async function getVanillaJson(mc) {
  const local = path.join(SHARED, 'versions', mc, `${mc}.json`);
  if (fs.existsSync(local)) {
    try {
      return JSON.parse(fs.readFileSync(local, 'utf8'));
    } catch {}
  }
  const m = await getManifest();
  const v = m.versions.find((x) => x.id === mc);
  if (!v) throw new Error(`Невідома версія Minecraft: ${mc}`);
  const json = await getJson(v.url);
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, JSON.stringify(json));
  return json;
}

async function getVersionType(mc) {
  try {
    const m = await getManifest();
    return m.versions.find((x) => x.id === mc)?.type || 'release';
  } catch {
    return 'release';
  }
}

// ---------- Списки версій лоадерів ----------

async function listLoaderVersions(loader, mc) {
  switch (loader) {
    case 'fabric': {
      const list = await getJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}`);
      return list.map((x) => ({ id: x.loader.version, stable: x.loader.stable }));
    }
    case 'quilt': {
      const list = await getJson(`https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mc)}`);
      return list.map((x) => ({ id: x.loader.version, stable: !x.loader.version.includes('beta') }));
    }
    case 'forge': {
      const xml = await getText('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml');
      const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
      return all
        .filter((v) => v.startsWith(mc + '-'))
        .map((v) => ({ id: v.slice(mc.length + 1), stable: true }));
    }
    case 'neoforge': {
      const data = await getJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge');
      const prefix = neoforgePrefix(mc);
      return data.versions
        .filter((v) => v.startsWith(prefix))
        .reverse()
        .map((v) => ({ id: v, stable: !v.includes('beta') }));
    }
    default:
      return [];
  }
}

// MC 1.21.1 -> NeoForge "21.1.x"; MC 1.21 -> "21.0.x"; нові версії (26.1) -> "26.1.x"
function neoforgePrefix(mc) {
  const parts = mc.split('.');
  if (parts[0] === '1') return `${parts[1]}.${parts[2] || '0'}.`;
  return `${parts[0]}.${parts[1] || '0'}.${parts[2] ? parts[2] + '.' : ''}`;
}

// ---------- Встановлення лоадерів ----------

/**
 * Встановлює лоадер у спільну папку і повертає id кастомної версії
 * (напр. "fabric-loader-0.16.9-1.21.1"), яку потім запускає MCLC.
 */
async function installLoader(loader, mc, loaderVersion, { javaExe, onProgress, onLog }) {
  if (loader === 'vanilla') return null;
  onProgress?.({ text: `Встановлення ${loader} ${loaderVersion}...`, value: null });

  if (loader === 'fabric' || loader === 'quilt') {
    const url =
      loader === 'fabric'
        ? `https://meta.fabricmc.net/v2/versions/loader/${mc}/${loaderVersion}/profile/json`
        : `https://meta.quiltmc.org/v3/versions/loader/${mc}/${loaderVersion}/profile/json`;
    const profile = await getJson(url);
    const dir = path.join(SHARED, 'versions', profile.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${profile.id}.json`), JSON.stringify(profile, null, 2));
    return profile.id;
  }

  if (loader === 'forge' || loader === 'neoforge') {
    let installerUrl;
    if (loader === 'forge') {
      const full = `${mc}-${loaderVersion}`;
      installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
    } else {
      installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
    }
    const installer = path.join(CACHE, 'installers', path.basename(installerUrl));
    await download(installerUrl, installer);

    // Інсталятор Forge вимагає launcher_profiles.json у цільовій папці
    const profiles = path.join(SHARED, 'launcher_profiles.json');
    if (!fs.existsSync(profiles)) fs.writeFileSync(profiles, JSON.stringify({ profiles: {} }));

    const versionsDir = path.join(SHARED, 'versions');
    fs.mkdirSync(versionsDir, { recursive: true });
    const before = new Set(fs.readdirSync(versionsDir));

    let ok = false;
    for (const flag of ['--installClient', '--install-client']) {
      onLog?.(`[Лаунчер] Запуск інсталятора: ${path.basename(installer)} ${flag}`);
      const code = await runJava(javaExe, ['-jar', installer, flag, SHARED], path.dirname(installer), onLog);
      if (code === 0) {
        ok = true;
        break;
      }
    }
    if (!ok) throw new Error(`Інсталятор ${loader} завершився з помилкою (див. консоль)`);

    const after = fs.readdirSync(versionsDir).filter((d) => !before.has(d));
    let id = after.find((d) => fs.existsSync(path.join(versionsDir, d, `${d}.json`)));
    if (!id) {
      // Версія вже була встановлена раніше — шукаємо за назвою
      const needle = loader === 'forge' ? loaderVersion : loaderVersion;
      id = fs
        .readdirSync(versionsDir)
        .find((d) => d.includes(needle) && d.toLowerCase().includes(loader === 'forge' ? 'forge' : 'neoforge'));
    }
    if (!id) throw new Error(`Не вдалося знайти встановлену версію ${loader}`);
    return id;
  }

  throw new Error(`Невідомий лоадер: ${loader}`);
}

function runJava(javaExe, args, cwd, onLog) {
  return new Promise((resolve) => {
    const p = spawn(javaExe, args, { cwd, windowsHide: true });
    const log = (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => onLog?.(l));
    p.stdout.on('data', log);
    p.stderr.on('data', log);
    p.on('error', (e) => {
      onLog?.(String(e));
      resolve(1);
    });
    p.on('close', resolve);
  });
}

function isLoaderInstalled(versionId) {
  return !!versionId && fs.existsSync(path.join(SHARED, 'versions', versionId, `${versionId}.json`));
}

module.exports = {
  listMinecraftVersions,
  listLoaderVersions,
  installLoader,
  isLoaderInstalled,
  getVanillaJson,
  getVersionType,
};
