const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { shell } = require('electron');
const { INSTANCES } = require('./paths');

const META = '.ulauncher-instance.json';
const CONTENT_META = '.ulauncher-content.json';

// Тип контенту -> папка всередині збірки
const FOLDERS = {
  mod: 'mods',
  shader: 'shaderpacks',
  resourcepack: 'resourcepacks',
};

function dirOf(id) {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('Невірний id збірки');
  return path.join(INSTANCES, id);
}

function list() {
  if (!fs.existsSync(INSTANCES)) return [];
  return fs
    .readdirSync(INSTANCES)
    .map((d) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(INSTANCES, d, META), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.lastPlayed || b.created) - (a.lastPlayed || a.created));
}

function get(id) {
  const file = path.join(dirOf(id), META);
  if (!fs.existsSync(file)) throw new Error('Збірку не знайдено');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function write(inst) {
  const dir = dirOf(inst.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, META), JSON.stringify(inst, null, 2));
  return inst;
}

function create({ name, mc, loader = 'vanilla', loaderVersion = null, ramMax = null, source = null }) {
  if (!name?.trim()) throw new Error('Вкажіть назву збірки');
  if (!mc) throw new Error('Виберіть версію Minecraft');
  if (loader !== 'vanilla' && !loaderVersion) throw new Error('Виберіть версію лоадера');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'build';
  const id = `${slug}-${crypto.randomBytes(3).toString('hex')}`;
  const inst = write({
    id,
    name: name.trim(),
    mc,
    loader,
    loaderVersion,
    versionId: null, // заповнюється після встановлення лоадера
    ramMax,
    source, // напр. { type: 'modrinth', projectId, versionId } для модпаків
    created: Date.now(),
    lastPlayed: null,
  });
  for (const f of Object.values(FOLDERS)) fs.mkdirSync(path.join(dirOf(id), f), { recursive: true });
  return inst;
}

function update(id, patch) {
  const inst = get(id);
  const next = { ...inst, ...patch, id: inst.id };
  // Змінилась версія гри/лоадера — лоадер треба перевстановити
  if (patch.mc !== undefined || patch.loader !== undefined || patch.loaderVersion !== undefined) {
    if (next.mc !== inst.mc || next.loader !== inst.loader || next.loaderVersion !== inst.loaderVersion) {
      next.versionId = null;
    }
  }
  return write(next);
}

async function remove(id) {
  // У кошик, а не назавжди — можна відновити
  await shell.trashItem(dirOf(id));
}

function openFolder(id, sub) {
  const dir = sub ? path.join(dirOf(id), sub) : dirOf(id);
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
}

// ---------- Контент (моди / шейдери / ресурспаки) ----------

function readContentMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dirOf(id), CONTENT_META), 'utf8'));
  } catch {
    return {};
  }
}

function writeContentMeta(id, meta) {
  fs.writeFileSync(path.join(dirOf(id), CONTENT_META), JSON.stringify(meta, null, 2));
}

/** Запам'ятовує, з якого проєкту Modrinth прийшов файл. */
function recordContent(id, type, fileName, info) {
  const meta = readContentMeta(id);
  meta[`${type}/${fileName}`] = info;
  writeContentMeta(id, meta);
}

function listContent(id, type) {
  const folder = path.join(dirOf(id), FOLDERS[type]);
  if (!fs.existsSync(folder)) return [];
  const meta = readContentMeta(id);
  return fs
    .readdirSync(folder, { withFileTypes: true })
    .filter((e) => e.isFile() || (type !== 'mod' && e.isDirectory()))
    .filter((e) => !e.name.endsWith('.part') && !e.name.endsWith('.txt'))
    .map((e) => {
      const enabled = !e.name.endsWith('.disabled');
      const baseName = enabled ? e.name : e.name.slice(0, -'.disabled'.length);
      const info = meta[`${type}/${baseName}`] || null;
      let size = 0;
      try {
        size = e.isFile() ? fs.statSync(path.join(folder, e.name)).size : 0;
      } catch {}
      return { file: e.name, baseName, enabled, size, title: info?.title || null, projectId: info?.projectId || null, icon: info?.icon || null };
    })
    .sort((a, b) => (a.title || a.baseName).localeCompare(b.title || b.baseName));
}

function installedProjectIds(id, type) {
  return new Set(listContent(id, type).map((c) => c.projectId).filter(Boolean));
}

function safeFile(id, type, file) {
  const folder = path.join(dirOf(id), FOLDERS[type]);
  const full = path.resolve(folder, file);
  if (!full.startsWith(path.resolve(folder) + path.sep)) throw new Error('Невірний шлях файлу');
  return full;
}

function toggleContent(id, type, file) {
  const full = safeFile(id, type, file);
  const target = file.endsWith('.disabled') ? full.slice(0, -'.disabled'.length) : full + '.disabled';
  fs.renameSync(full, target);
}

async function deleteContent(id, type, file) {
  const full = safeFile(id, type, file);
  await shell.trashItem(full);
  const meta = readContentMeta(id);
  const base = file.endsWith('.disabled') ? file.slice(0, -'.disabled'.length) : file;
  delete meta[`${type}/${base}`];
  writeContentMeta(id, meta);
}

function addLocalFiles(id, type, files) {
  const folder = path.join(dirOf(id), FOLDERS[type]);
  fs.mkdirSync(folder, { recursive: true });
  for (const f of files) fs.copyFileSync(f, path.join(folder, path.basename(f)));
  return files.length;
}

module.exports = {
  FOLDERS,
  dirOf,
  list,
  get,
  create,
  update,
  remove,
  openFolder,
  listContent,
  installedProjectIds,
  recordContent,
  toggleContent,
  deleteContent,
  addLocalFiles,
};
