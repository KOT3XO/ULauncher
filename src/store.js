const fs = require('fs');
const { safeStorage } = require('electron');
const { CONFIG } = require('./paths');

const defaults = {
  // 'license' — грати під ніком ліцензії, 'offline' — під власним ніком
  mode: 'license',
  offlineName: '',
  account: null, // { name, uuid, refresh (зашифрований) }
  settings: {
    ramMax: 4096,
    javaPath: '', // порожньо = автоматично (лаунчер сам завантажує потрібну Java)
    closeOnLaunch: false,
    showSnapshots: false,
  },
};

let data = load();

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    return { ...defaults, ...raw, settings: { ...defaults.settings, ...(raw.settings || {}) } };
  } catch {
    return structuredClone(defaults);
  }
}

function save() {
  fs.writeFileSync(CONFIG, JSON.stringify(data, null, 2));
}

function get() {
  return data;
}

function update(patch) {
  data = { ...data, ...patch };
  save();
  return data;
}

// Refresh-токен Microsoft зберігаємо зашифрованим засобами Windows (DPAPI)
function encrypt(str) {
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(str).toString('base64');
  }
  return 'raw:' + Buffer.from(str).toString('base64');
}

function decrypt(str) {
  if (!str) return null;
  const [kind, b64] = [str.slice(0, 4), str.slice(4)];
  const buf = Buffer.from(b64, 'base64');
  if (kind === 'enc:') return safeStorage.decryptString(buf);
  return buf.toString();
}

module.exports = { get, update, save, encrypt, decrypt };
