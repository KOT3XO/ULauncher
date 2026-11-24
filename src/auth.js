const crypto = require('crypto');
const { Auth } = require('msmc');
const store = require('./store');

/** Вхід через Microsoft (відкриває вікно логіну Microsoft). */
async function loginMicrosoft() {
  const auth = new Auth('select_account');
  const xbox = await auth.launch('electron', {
    width: 520,
    height: 680,
    resizable: false,
    title: 'Вхід у Microsoft',
  });
  return finishLogin(xbox);
}

async function finishLogin(xbox) {
  const mc = await xbox.getMinecraft();
  if (!mc.profile || mc.isDemo()) {
    throw new Error('На цьому акаунті Microsoft немає ліцензії Minecraft: Java Edition');
  }
  store.update({
    account: {
      name: mc.profile.name,
      uuid: mc.profile.id,
      refresh: store.encrypt(xbox.save()),
    },
  });
  return mc;
}

/** Оновлює токени ліцензії перед запуском гри. */
async function refreshLicense() {
  const acc = store.get().account;
  if (!acc) throw new Error('Спочатку увійдіть через Microsoft');
  const token = store.decrypt(acc.refresh);
  const auth = new Auth('select_account');
  try {
    const xbox = await auth.refresh(token);
    return await finishLogin(xbox);
  } catch (e) {
    throw new Error('Сесія Microsoft застаріла — увійдіть ще раз. (' + (e?.message || e) + ')');
  }
}

function logout() {
  store.update({ account: null, mode: 'license' });
}

/** UUID офлайн-гравця — так само, як його рахує сервер Minecraft ("OfflinePlayer:<нік>"). */
function offlineUuid(name) {
  const md5 = crypto.createHash('md5').update('OfflinePlayer:' + name).digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const h = md5.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function isValidNick(name) {
  return /^[A-Za-z0-9_]{3,16}$/.test(name);
}

/** Повертає об'єкт авторизації для minecraft-launcher-core залежно від режиму. */
async function getLaunchAuth() {
  const cfg = store.get();
  if (!cfg.account) throw new Error('Спочатку увійдіть через Microsoft (потрібна ліцензія)');

  if (cfg.mode === 'offline') {
    const name = cfg.offlineName;
    if (!isValidNick(name)) throw new Error('Офлайн-нік: 3–16 символів, лише латиниця, цифри та _');
    const uuid = offlineUuid(name);
    return {
      access_token: uuid,
      client_token: uuid,
      uuid: uuid.replace(/-/g, ''),
      name,
      user_properties: '{}',
      meta: { type: 'legacy', demo: false },
    };
  }

  const mc = await refreshLicense();
  return mc.mclc();
}

function getState() {
  const cfg = store.get();
  return {
    account: cfg.account ? { name: cfg.account.name, uuid: cfg.account.uuid } : null,
    mode: cfg.mode,
    offlineName: cfg.offlineName,
  };
}

module.exports = { loginMicrosoft, logout, getLaunchAuth, getState, isValidNick };
