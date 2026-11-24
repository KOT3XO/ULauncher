const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { CACHE } = require('./paths');
const { getJson, download, pool } = require('./net');
const instances = require('./instances');

const API = 'https://api.modrinth.com/v2';

const PROJECT_TYPE = {
  mod: 'mod',
  shader: 'shader',
  resourcepack: 'resourcepack',
  modpack: 'modpack',
};

/** Які "loaders" Modrinth підходять для збірки з певним лоадером. */
function modLoadersFor(loader) {
  if (loader === 'quilt') return ['quilt', 'fabric']; // Quilt запускає і Fabric-моди
  if (loader === 'vanilla') return [];
  return [loader];
}

async function search({ query = '', type, mc, loader, offset = 0, limit = 20, sort = 'relevance' }) {
  const facets = [[`project_type:${PROJECT_TYPE[type]}`]];
  if (mc) facets.push([`versions:${mc}`]);
  if ((type === 'mod' || type === 'modpack') && loader && loader !== 'vanilla') {
    facets.push(modLoadersFor(loader).map((l) => `categories:${l}`));
  }
  const params = new URLSearchParams({
    query,
    facets: JSON.stringify(facets),
    index: sort,
    offset: String(offset),
    limit: String(limit),
  });
  const res = await getJson(`${API}/search?${params}`);
  return {
    total: res.total_hits,
    hits: res.hits.map((h) => ({
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      author: h.author,
      icon: h.icon_url,
      downloads: h.downloads,
      categories: h.display_categories || h.categories,
      versions: h.versions,
    })),
  };
}

async function getProjectVersions(projectId, { mc, loaders } = {}) {
  const params = new URLSearchParams();
  if (mc) params.set('game_versions', JSON.stringify([mc]));
  if (loaders?.length) params.set('loaders', JSON.stringify(loaders));
  return getJson(`${API}/project/${encodeURIComponent(projectId)}/version?${params}`);
}

function pickVersion(versions) {
  // Спочатку стабільні релізи, потім бети/альфи
  return versions.find((v) => v.version_type === 'release') || versions[0];
}

/**
 * Встановлює мод / шейдер / ресурспак у збірку.
 * Для модів автоматично ставить обов'язкові залежності.
 */
async function installProject(instanceId, projectId, type, { onProgress, onLog } = {}, _seen = new Set()) {
  if (_seen.has(projectId)) return [];
  _seen.add(projectId);

  const inst = instances.get(instanceId);
  const installed = instances.installedProjectIds(instanceId, type);
  if (installed.has(projectId) && _seen.size > 1) return []; // залежність уже є

  const loaders = type === 'mod' ? modLoadersFor(inst.loader) : type === 'resourcepack' ? ['minecraft'] : undefined;
  if (type === 'mod' && inst.loader === 'vanilla') {
    throw new Error('Моди не працюють на ванільній збірці. Створіть збірку з Fabric, Quilt, Forge або NeoForge.');
  }

  const versions = await getProjectVersions(projectId, { mc: inst.mc, loaders });
  if (!versions.length) {
    throw new Error(`Немає версії для Minecraft ${inst.mc}${type === 'mod' ? ' / ' + inst.loader : ''}`);
  }
  const version = pickVersion(versions);
  return installVersion(instanceId, version, type, { onProgress, onLog }, _seen);
}

async function installVersion(instanceId, version, type, { onProgress, onLog } = {}, _seen = new Set()) {
  const file = version.files.find((f) => f.primary) || version.files[0];
  const project = await getJson(`${API}/project/${version.project_id}`).catch(() => null);
  const title = project?.title || file.filename;
  onProgress?.({ text: `Завантаження: ${title}`, value: null });

  const folder = path.join(instances.dirOf(instanceId), instances.FOLDERS[type]);
  await download(file.url, path.join(folder, file.filename), file.hashes?.sha1);
  instances.recordContent(instanceId, type, file.filename, {
    projectId: version.project_id,
    versionId: version.id,
    title,
    icon: project?.icon_url || null,
  });
  onLog?.(`[Лаунчер] Встановлено ${title} (${version.version_number})`);
  const result = [title];

  if (type === 'mod') {
    for (const dep of version.dependencies || []) {
      if (dep.dependency_type !== 'required') continue;
      try {
        if (dep.project_id) {
          result.push(...(await installProject(instanceId, dep.project_id, 'mod', { onProgress, onLog }, _seen)));
        } else if (dep.version_id) {
          const v = await getJson(`${API}/version/${dep.version_id}`);
          if (!_seen.has(v.project_id)) {
            _seen.add(v.project_id);
            result.push(...(await installVersion(instanceId, v, 'mod', { onProgress, onLog }, _seen)));
          }
        }
      } catch (e) {
        onLog?.(`[Лаунчер] Не вдалося встановити залежність: ${e.message}`);
      }
    }
  }
  return result;
}

// ---------- Модпаки (.mrpack) ----------

function safeJoin(base, rel) {
  const full = path.resolve(base, rel);
  if (!full.startsWith(path.resolve(base) + path.sep)) throw new Error(`Небезпечний шлях у модпаку: ${rel}`);
  return full;
}

/** Встановлює модпак з Modrinth як нову збірку. */
async function installModpack(projectId, versionId, { onProgress, onLog } = {}) {
  onProgress?.({ text: 'Отримання інформації про модпак...', value: null });
  const project = await getJson(`${API}/project/${encodeURIComponent(projectId)}`);
  let version;
  if (versionId) version = await getJson(`${API}/version/${versionId}`);
  else version = pickVersion(await getProjectVersions(projectId));
  if (!version) throw new Error('У модпака немає версій');

  const file = version.files.find((f) => f.primary) || version.files[0];
  const mrpack = path.join(CACHE, 'modpacks', file.filename);
  onProgress?.({ text: `Завантаження ${file.filename}...`, value: null });
  await download(file.url, mrpack, file.hashes?.sha1);

  return importMrpack(mrpack, {
    name: project.title,
    source: { type: 'modrinth', projectId: project.id, versionId: version.id, icon: project.icon_url },
    onProgress,
    onLog,
  });
}

/** Імпортує .mrpack файл (з Modrinth або з диска) як нову збірку. */
async function importMrpack(mrpackPath, { name, source = null, onProgress, onLog } = {}) {
  const zip = new AdmZip(mrpackPath);
  const indexEntry = zip.getEntry('modrinth.index.json');
  if (!indexEntry) throw new Error('Це не модпак Modrinth (.mrpack): немає modrinth.index.json');
  const index = JSON.parse(indexEntry.getData().toString('utf8'));
  const deps = index.dependencies || {};

  let loader = 'vanilla';
  let loaderVersion = null;
  if (deps['fabric-loader']) [loader, loaderVersion] = ['fabric', deps['fabric-loader']];
  else if (deps['quilt-loader']) [loader, loaderVersion] = ['quilt', deps['quilt-loader']];
  else if (deps.neoforge) [loader, loaderVersion] = ['neoforge', deps.neoforge];
  else if (deps.forge) [loader, loaderVersion] = ['forge', deps.forge];

  const inst = instances.create({
    name: name || index.name || path.basename(mrpackPath, '.mrpack'),
    mc: deps.minecraft,
    loader,
    loaderVersion,
    source: source || { type: 'mrpack-file' },
  });
  const dir = instances.dirOf(inst.id);

  try {
    const files = (index.files || []).filter((f) => f.env?.client !== 'unsupported');
    let done = 0;
    await pool(files, 8, async (f) => {
      const dest = safeJoin(dir, f.path);
      await download(f.downloads[0], dest, f.hashes?.sha1);
      done++;
      onProgress?.({ text: `Файли модпаку: ${done}/${files.length}`, value: done / files.length });
    });

    // overrides/ та client-overrides/ — конфіги, ресурси тощо
    onProgress?.({ text: 'Розпакування налаштувань модпаку...', value: null });
    for (const prefix of ['overrides/', 'client-overrides/']) {
      for (const entry of zip.getEntries()) {
        if (!entry.entryName.startsWith(prefix) || entry.isDirectory) continue;
        const rel = entry.entryName.slice(prefix.length);
        if (!rel) continue;
        const dest = safeJoin(dir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, entry.getData());
      }
    }
  } catch (e) {
    onLog?.(`[Лаунчер] Помилка встановлення модпаку: ${e.message}`);
    await instances.remove(inst.id).catch(() => {});
    throw e;
  }

  onLog?.(`[Лаунчер] Модпак "${inst.name}" встановлено (${inst.mc}, ${loader} ${loaderVersion || ''})`);
  return inst;
}

module.exports = { search, installProject, installModpack, importMrpack, getProjectVersions };
