const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const os = require('os');
const path = require('path');

let win;

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

const progress = (p) => send('progress', p);
const log = (line) => send('log', line);

/** Обгортка для IPC: помилки повертаємо як { error } замість падіння. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: await fn(...args) };
    } catch (e) {
      const msg = e?.message || String(e);
      log(`[Помилка] ${msg}`);
      progress({ text: '', value: 0, done: true });
      return { error: msg };
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#14161b',
    title: 'ULauncher',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Посилання відкриваємо у звичайному браузері
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  // Модулі, яким потрібен готовий app (шляхи, safeStorage)
  const store = require('./src/store');
  const auth = require('./src/auth');
  const loaders = require('./src/loaders');
  const instances = require('./src/instances');
  const modrinth = require('./src/modrinth');
  const launcher = require('./src/launch');
  const { ROOT } = require('./src/paths');

  // ----- Акаунт -----
  handle('auth:state', () => auth.getState());
  handle('auth:login', async () => {
    await auth.loginMicrosoft();
    return auth.getState();
  });
  handle('auth:logout', () => {
    auth.logout();
    return auth.getState();
  });
  handle('auth:mode', (mode) => {
    if (!store.get().account) throw new Error('Спочатку увійдіть через Microsoft');
    if (mode === 'offline' && !auth.isValidNick(store.get().offlineName)) {
      throw new Error('Спочатку вкажіть офлайн-нік (3–16 символів: латиниця, цифри, _)');
    }
    store.update({ mode: mode === 'offline' ? 'offline' : 'license' });
    return auth.getState();
  });
  handle('auth:offlineName', (name) => {
    if (!store.get().account) throw new Error('Спочатку увійдіть через Microsoft');
    name = String(name || '').trim();
    if (!auth.isValidNick(name)) throw new Error('Нік: 3–16 символів, лише латиниця, цифри та _');
    store.update({ offlineName: name });
    return auth.getState();
  });

  // ----- Версії -----
  handle('versions:mc', (snapshots) => loaders.listMinecraftVersions(snapshots));
  handle('versions:loader', (loader, mc) => loaders.listLoaderVersions(loader, mc));

  // ----- Збірки -----
  handle('inst:list', () => instances.list());
  handle('inst:create', (opts) => instances.create(opts));
  handle('inst:update', (id, patch) => instances.update(id, patch));
  handle('inst:remove', (id) => instances.remove(id));
  handle('inst:folder', (id, sub) => instances.openFolder(id, sub));
  handle('inst:content', (id, type) => instances.listContent(id, type));
  handle('inst:toggle', (id, type, file) => instances.toggleContent(id, type, file));
  handle('inst:delete', (id, type, file) => instances.deleteContent(id, type, file));
  handle('inst:addFiles', async (id, type) => {
    const filters = {
      mod: [{ name: 'Моди', extensions: ['jar'] }],
      shader: [{ name: 'Шейдери', extensions: ['zip'] }],
      resourcepack: [{ name: 'Ресурспаки', extensions: ['zip'] }],
    }[type];
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters });
    if (r.canceled) return 0;
    return instances.addLocalFiles(id, type, r.filePaths);
  });
  handle('inst:launch', async (id) => {
    await launcher.launch(id, {
      onProgress: progress,
      onLog: log,
      onState: (s) => {
        send('game-state', s);
        if (store.get().settings.closeOnLaunch && win) {
          if (s.running) win.hide();
          else if (!launcher.runningIds().length) win.show();
        }
      },
    });
    return true;
  });
  handle('inst:kill', (id) => launcher.kill(id));
  handle('inst:running', () => launcher.runningIds());

  // ----- Modrinth -----
  handle('mr:search', (params) => modrinth.search(params));
  handle('mr:install', async (instanceId, projectId, type) => {
    const r = await modrinth.installProject(instanceId, projectId, type, { onProgress: progress, onLog: log });
    progress({ text: `Встановлено: ${r.join(', ')}`, value: 1, done: true });
    return r;
  });
  handle('mr:modpack', async (projectId, versionId) => {
    const inst = await modrinth.installModpack(projectId, versionId, { onProgress: progress, onLog: log });
    progress({ text: `Модпак "${inst.name}" встановлено`, value: 1, done: true });
    return inst;
  });
  handle('mr:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Модпак Modrinth', extensions: ['mrpack'] }],
    });
    if (r.canceled) return null;
    const inst = await modrinth.importMrpack(r.filePaths[0], { onProgress: progress, onLog: log });
    progress({ text: `Модпак "${inst.name}" імпортовано`, value: 1, done: true });
    return inst;
  });

  // ----- Налаштування -----
  handle('settings:get', () => store.get().settings);
  handle('settings:set', (patch) => {
    const settings = { ...store.get().settings, ...patch };
    store.update({ settings });
    return settings;
  });
  handle('settings:openData', () => shell.openPath(ROOT));
  handle('settings:ram', () => Math.floor(os.totalmem() / 1024 / 1024));
  handle('open:external', (url) => {
    if (/^https:\/\/(modrinth\.com|www\.minecraft\.net)\//.test(url)) shell.openExternal(url);
  });

  createWindow();
});

app.on('window-all-closed', () => app.quit());
