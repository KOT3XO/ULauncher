const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  // Акаунт
  authState: call('auth:state'),
  login: call('auth:login'),
  logout: call('auth:logout'),
  setMode: call('auth:mode'),
  setOfflineName: call('auth:offlineName'),

  // Версії
  mcVersions: call('versions:mc'),
  loaderVersions: call('versions:loader'),

  // Збірки
  listInstances: call('inst:list'),
  createInstance: call('inst:create'),
  updateInstance: call('inst:update'),
  removeInstance: call('inst:remove'),
  openFolder: call('inst:folder'),
  listContent: call('inst:content'),
  toggleContent: call('inst:toggle'),
  deleteContent: call('inst:delete'),
  addFiles: call('inst:addFiles'),
  launch: call('inst:launch'),
  kill: call('inst:kill'),
  running: call('inst:running'),

  // Modrinth
  search: call('mr:search'),
  install: call('mr:install'),
  installModpack: call('mr:modpack'),
  importMrpack: call('mr:import'),

  // Налаштування
  getSettings: call('settings:get'),
  setSettings: call('settings:set'),
  openDataFolder: call('settings:openData'),
  systemRam: call('settings:ram'),
  openExternal: call('open:external'),

  on: (channel, cb) => ipcRenderer.on(channel, (_e, data) => cb(data)),
});
