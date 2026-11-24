const { Client } = require('minecraft-launcher-core');
const { SHARED } = require('./paths');
const store = require('./store');
const auth = require('./auth');
const instances = require('./instances');
const loaders = require('./loaders');
const { ensureJava } = require('./java');

const running = new Map(); // instanceId -> child process

async function javaFor(mc, onProgress, opts) {
  const custom = store.get().settings.javaPath;
  if (custom && !opts?.console) return custom;
  const json = await loaders.getVanillaJson(mc);
  const component = json.javaVersion?.component || 'jre-legacy';
  return ensureJava(component, onProgress, opts);
}

async function launch(instanceId, { onProgress, onLog, onState }) {
  if (running.has(instanceId)) throw new Error('Ця збірка вже запущена');
  let inst = instances.get(instanceId);
  const settings = store.get().settings;

  onProgress({ text: 'Авторизація...', value: null });
  const authorization = await auth.getLaunchAuth();
  onLog(`[Лаунчер] Гравець: ${authorization.name} (${store.get().mode === 'offline' ? 'офлайн' : 'ліцензія'})`);

  const javaPath = await javaFor(inst.mc, onProgress);
  onLog(`[Лаунчер] Java: ${javaPath}`);

  // Встановлюємо лоадер, якщо ще не встановлений
  if (inst.loader !== 'vanilla' && !loaders.isLoaderInstalled(inst.versionId)) {
    const installerJava = await javaFor(inst.mc, onProgress, { console: true });
    const versionId = await loaders.installLoader(inst.loader, inst.mc, inst.loaderVersion, {
      javaExe: installerJava,
      onProgress,
      onLog,
    });
    inst = instances.update(instanceId, { versionId });
  }

  const ram = inst.ramMax || settings.ramMax;
  const opts = {
    root: SHARED,
    authorization,
    version: {
      number: inst.mc,
      type: await loaders.getVersionType(inst.mc),
      ...(inst.versionId ? { custom: inst.versionId } : {}),
    },
    memory: { max: `${ram}M`, min: `${Math.min(1024, ram)}M` },
    javaPath,
    overrides: {
      gameDirectory: instances.dirOf(instanceId),
      maxSockets: 16,
    },
  };

  const client = new Client();
  let lastPct = -1;
  client.on('debug', (m) => onLog(String(m)));
  client.on('data', (m) => String(m).split(/\r?\n/).filter(Boolean).forEach((l) => onLog(l)));
  client.on('progress', (p) => {
    const pct = p.total ? Math.floor((p.task / p.total) * 100) : 0;
    if (pct !== lastPct) {
      lastPct = pct;
      onProgress({ text: `Завантаження файлів гри (${p.type}): ${p.task}/${p.total}`, value: p.total ? p.task / p.total : null });
    }
  });

  onProgress({ text: 'Підготовка гри...', value: null });
  const proc = await client.launch(opts);
  if (!proc) throw new Error('Не вдалося запустити гру — подробиці в консолі');

  running.set(instanceId, proc);
  instances.update(instanceId, { lastPlayed: Date.now() });
  onProgress({ text: `Гра запущена: ${inst.name}`, value: 1, done: true });
  onState({ instanceId, running: true });

  proc.on('close', (code) => {
    running.delete(instanceId);
    onLog(`[Лаунчер] Гра закрилась (код ${code})`);
    onState({ instanceId, running: false, code });
  });
  return true;
}

function kill(instanceId) {
  running.get(instanceId)?.kill();
}

function runningIds() {
  return [...running.keys()];
}

module.exports = { launch, kill, runningIds };
