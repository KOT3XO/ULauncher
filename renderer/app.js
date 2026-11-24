/* global api */
'use strict';

// ---------- Утиліти ----------
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** Виклик API головного процесу. Помилка → сповіщення + виняток. */
async function call(fn, ...args) {
  const r = await api[fn](...args);
  if (r && r.error) {
    toast(r.error, 'error');
    throw new Error(r.error);
  }
  return r ? r.ok : undefined;
}
/** Запускає async-обробник, ковтаючи вже показані помилки. */
const run = (fn) => (...a) => Promise.resolve(fn(...a)).catch(() => {});

function toast(text, kind = 'ok') {
  const el = h('div', { class: `toast ${kind}` }, text);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function fmtNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.0', '') + 'K';
  return String(n);
}

function colorFor(str) {
  let x = 0;
  for (const c of str) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${x % 360} 45% 38%)`;
}

const LOADER_NAMES = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };
const TYPE_NAMES = { mod: 'моди', shader: 'шейдери', resourcepack: 'ресурспаки' };

// ---------- Стан ----------
const state = {
  auth: null,
  settings: null,
  instances: [],
  current: null,
  tab: 'mod',
  running: new Set(),
  launching: new Set(),
  catalog: { offset: 0, total: 0 },
  mp: { offset: 0, total: 0 },
};

// ---------- Навігація ----------
function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name || (name === 'instance' && b.dataset.view === 'instances')));
  if (name === 'modpacks' && !$('#mpList').children.length) searchModpacks(true);
  if (name === 'instances') renderInstances();
}
$$('.nav-btn').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

// ---------- Акаунт ----------
function renderAccount() {
  const a = state.auth;
  if (!a || !a.account) {
    $('#accAvatar').textContent = '?';
    $('#accAvatar').style.background = '#3b4252';
    $('#accName').textContent = 'Не авторизовано';
    $('#accMode').textContent = 'Увійти через Microsoft';
    return;
  }
  const playName = a.mode === 'offline' ? a.offlineName : a.account.name;
  $('#accAvatar').textContent = playName[0].toUpperCase();
  $('#accAvatar').style.background = colorFor(playName);
  $('#accName').textContent = playName;
  $('#accMode').textContent = a.mode === 'offline' ? `Офлайн · ліцензія ${a.account.name}` : 'Ліцензія Microsoft';
}

function openAccountModal() {
  const a = state.auth;
  if (!a.account) {
    const btn = h('button', { class: 'btn primary' }, 'Увійти через Microsoft');
    btn.onclick = run(async () => {
      btn.disabled = true;
      btn.textContent = 'Очікування входу...';
      try {
        state.auth = await call('login');
        renderAccount();
        closeModal();
        toast(`Ви увійшли як ${state.auth.account.name}`);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Увійти через Microsoft';
      }
    });
    openModal(
      h('h2', {}, 'Вхід'),
      h('div', { class: 'info-box' },
        'Щоб користуватись лаунчером, увійдіть в акаунт Microsoft з купленим Minecraft: Java Edition. ',
        'Після входу можна буде грати під ліцензійним ніком або змінити нік для офлайн-гри.'),
      h('div', { class: 'foot' }, h('button', { class: 'btn ghost', onclick: closeModal }, 'Скасувати'), btn)
    );
    return;
  }

  let mode = a.mode;
  const nick = h('input', { type: 'text', maxlength: 16, placeholder: 'Офлайн-нік', value: a.offlineName || '' });
  const segLic = h('button', {}, `Ліцензія (${a.account.name})`);
  const segOff = h('button', {}, 'Офлайн-нік');
  const nickRow = h('div', { class: 'field' }, h('span', {}, 'Нік для офлайн-гри'), nick,
    h('small', { class: 'muted' }, '3–16 символів: латинські літери, цифри, _'));
  const syncSeg = () => {
    segLic.classList.toggle('active', mode === 'license');
    segOff.classList.toggle('active', mode === 'offline');
    nickRow.hidden = mode !== 'offline';
  };
  segLic.onclick = () => { mode = 'license'; syncSeg(); };
  segOff.onclick = () => { mode = 'offline'; syncSeg(); nick.focus(); };
  syncSeg();

  const save = h('button', { class: 'btn primary' }, 'Зберегти');
  save.onclick = run(async () => {
    if (mode === 'offline') await call('setOfflineName', nick.value);
    state.auth = await call('setMode', mode);
    renderAccount();
    closeModal();
    toast(mode === 'offline' ? `Граєте як ${state.auth.offlineName} (офлайн)` : `Граєте як ${state.auth.account.name}`);
  });
  const logout = h('button', { class: 'btn danger ghost' }, 'Вийти з акаунта');
  logout.onclick = run(async () => {
    state.auth = await call('logout');
    renderAccount();
    closeModal();
  });

  openModal(
    h('h2', {}, 'Акаунт'),
    h('div', { class: 'info-box' }, 'Ліцензію підтверджено: ', h('b', {}, a.account.name)),
    h('div', { class: 'seg' }, segLic, segOff),
    nickRow,
    h('div', { class: 'info-box' },
      'Офлайн-нік працює в одиночній грі, у LAN та на серверах з online-mode=false. ',
      'На ліцензійних серверах потрібен режим «Ліцензія».'),
    h('div', { class: 'foot' }, logout, h('span', { style: 'flex:1' }), h('button', { class: 'btn ghost', onclick: closeModal }, 'Скасувати'), save)
  );
}
$('#accountCard').addEventListener('click', openAccountModal);

// ---------- Модальні вікна ----------
function openModal(...content) {
  $('#modal').replaceChildren(...content);
  $('#modalBg').hidden = false;
}
function closeModal() {
  $('#modalBg').hidden = true;
}
$('#modalBg').addEventListener('mousedown', (e) => {
  if (e.target.id === 'modalBg') closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

// ---------- Збірки ----------
async function loadInstances() {
  state.instances = await call('listInstances');
  renderInstances();
}

function instIcon(inst, size) {
  if (inst.source && inst.source.icon) {
    return h('img', { class: 'inst-icon', src: inst.source.icon, style: size ? `width:${size}px;height:${size}px` : null });
  }
  return h('div', { class: 'inst-icon', style: `background:${colorFor(inst.name)}` }, inst.name[0].toUpperCase());
}

function playButton(inst, extraClass = '') {
  const isRun = state.running.has(inst.id);
  const isLaunching = state.launching.has(inst.id);
  const btn = h('button', { class: `btn play ${isRun ? 'stop' : ''} ${extraClass}` },
    isRun ? 'Зупинити' : isLaunching ? 'Запуск...' : 'Грати');
  btn.disabled = isLaunching;
  btn.onclick = (e) => {
    e.stopPropagation();
    if (isRun) api.kill(inst.id);
    else launch(inst.id);
  };
  return btn;
}

function renderInstances() {
  const grid = $('#instanceGrid');
  grid.replaceChildren(
    ...state.instances.map((inst) =>
      h('div', { class: 'inst-card', onclick: () => openInstance(inst.id) },
        h('div', { class: 'top' },
          instIcon(inst),
          h('div', { style: 'min-width:0' },
            h('div', { class: 'name' }, inst.name),
            h('div', { class: 'meta' },
              h('span', { class: 'badge' }, inst.mc),
              h('span', { class: `badge ${inst.loader}` }, LOADER_NAMES[inst.loader])))),
        playButton(inst)))
  );
  $('#instancesEmpty').hidden = state.instances.length > 0;
  if (state.current) renderInstanceHead();
}

async function launch(id) {
  if (!state.auth.account) {
    toast('Спочатку увійдіть через Microsoft', 'error');
    openAccountModal();
    return;
  }
  state.launching.add(id);
  renderInstances();
  try {
    await call('launch', id);
  } catch {
    $('#console').hidden = false;
  } finally {
    state.launching.delete(id);
    await loadInstances().catch(() => {});
  }
}

// ----- Створення збірки -----
async function openCreateModal() {
  const name = h('input', { type: 'text', placeholder: 'Напр. «Мої пригоди»', maxlength: 48 });
  const mcSel = h('select', {}, h('option', {}, 'Завантаження...'));
  const loaderVerSel = h('select', {});
  const loaderVerField = h('label', { class: 'field' }, h('span', {}, 'Версія лоадера'), loaderVerSel);
  let loader = 'fabric';
  const segBtns = Object.entries(LOADER_NAMES).map(([id, label]) => {
    const b = h('button', {}, label);
    b.onclick = () => { loader = id; syncSeg(); loadLoaderVersions(); };
    b.dataset.id = id;
    return b;
  });
  const syncSeg = () => {
    segBtns.forEach((b) => b.classList.toggle('active', b.dataset.id === loader));
    loaderVerField.hidden = loader === 'vanilla';
  };

  const loadLoaderVersions = run(async () => {
    if (loader === 'vanilla') return;
    loaderVerSel.replaceChildren(h('option', {}, 'Завантаження...'));
    const mc = mcSel.value;
    const reqLoader = loader;
    let list = [];
    try {
      list = await call('loaderVersions', loader, mc);
    } catch {}
    if (reqLoader !== loader || mc !== mcSel.value) return;
    if (!list.length) {
      loaderVerSel.replaceChildren(h('option', { value: '' }, `${LOADER_NAMES[loader]} не підтримує ${mc}`));
      return;
    }
    const rec = list.find((v) => v.stable) || list[0];
    loaderVerSel.replaceChildren(...list.map((v) =>
      h('option', { value: v.id, selected: v === rec }, v.id + (v === rec ? ' (рекомендовано)' : ''))));
  });

  const create = h('button', { class: 'btn primary' }, 'Створити');
  create.onclick = run(async () => {
    create.disabled = true;
    try {
      const inst = await call('createInstance', {
        name: name.value || `${LOADER_NAMES[loader]} ${mcSel.value}`,
        mc: mcSel.value,
        loader,
        loaderVersion: loader === 'vanilla' ? null : loaderVerSel.value,
      });
      closeModal();
      await loadInstances();
      openInstance(inst.id);
      toast(`Збірку «${inst.name}» створено`);
    } finally {
      create.disabled = false;
    }
  });

  openModal(
    h('h2', {}, 'Нова збірка'),
    h('label', { class: 'field' }, h('span', {}, 'Назва'), name),
    h('label', { class: 'field' }, h('span', {}, 'Версія Minecraft'), mcSel),
    h('div', { class: 'field' }, h('span', {}, 'Лоадер модів'), h('div', { class: 'seg' }, ...segBtns)),
    loaderVerField,
    h('div', { class: 'foot' }, h('button', { class: 'btn ghost', onclick: closeModal }, 'Скасувати'), create)
  );
  syncSeg();
  name.focus();

  const versions = await call('mcVersions', state.settings.showSnapshots);
  mcSel.replaceChildren(...versions.map((v) => h('option', { value: v.id }, v.id + (v.type === 'snapshot' ? ' (снапшот)' : ''))));
  mcSel.onchange = loadLoaderVersions;
  loadLoaderVersions();
}
$('#newInstanceBtn').addEventListener('click', run(openCreateModal));

// ----- Сторінка збірки -----
function openInstance(id) {
  state.current = state.instances.find((i) => i.id === id);
  if (!state.current) return;
  showView('instance');
  renderInstanceHead();
  setTab(state.tab);
}

function renderInstanceHead() {
  const inst = state.instances.find((i) => i.id === state.current.id);
  if (!inst) return;
  state.current = inst;
  $('#instName').textContent = inst.name;
  $('#instMeta').replaceChildren(
    h('span', { class: 'badge' }, `Minecraft ${inst.mc}`),
    h('span', { class: `badge ${inst.loader}` }, LOADER_NAMES[inst.loader] + (inst.loaderVersion ? ' ' + inst.loaderVersion : '')),
    inst.ramMax ? h('span', { class: 'badge' }, `${inst.ramMax} МБ RAM`) : null
  );
  $('#instPlayBtn').replaceWith(Object.assign(playButton(inst), { id: 'instPlayBtn' }));
}

$('#backBtn').addEventListener('click', () => {
  state.current = null;
  showView('instances');
});
$('#instFolderBtn').addEventListener('click', () => api.openFolder(state.current.id));
$('#openSubFolderBtn').addEventListener('click', () =>
  api.openFolder(state.current.id, { mod: 'mods', shader: 'shaderpacks', resourcepack: 'resourcepacks' }[state.tab]));

$('#instEditBtn').addEventListener('click', () => {
  const inst = state.current;
  const name = h('input', { type: 'text', value: inst.name, maxlength: 48 });
  const ram = h('input', { type: 'range', min: 1024, max: state.maxRam, step: 512, value: inst.ramMax || state.settings.ramMax });
  const useDefault = h('input', { type: 'checkbox', checked: !inst.ramMax });
  const ramLabel = h('b', {});
  const sync = () => {
    ram.disabled = useDefault.checked;
    ramLabel.textContent = useDefault.checked ? `за замовчуванням (${state.settings.ramMax} МБ)` : `${ram.value} МБ`;
  };
  ram.oninput = sync;
  useDefault.onchange = sync;
  sync();

  const save = h('button', { class: 'btn primary' }, 'Зберегти');
  save.onclick = run(async () => {
    await call('updateInstance', inst.id, { name: name.value.trim() || inst.name, ramMax: useDefault.checked ? null : Number(ram.value) });
    closeModal();
    await loadInstances();
  });
  const del = h('button', { class: 'btn danger ghost' }, 'Видалити збірку');
  del.onclick = run(async () => {
    if (!confirm(`Видалити збірку «${inst.name}»? Папку буде переміщено в кошик (світи теж!).`)) return;
    await call('removeInstance', inst.id);
    closeModal();
    state.current = null;
    await loadInstances();
    showView('instances');
    toast('Збірку переміщено в кошик');
  });

  openModal(
    h('h2', {}, 'Налаштування збірки'),
    h('label', { class: 'field' }, h('span', {}, 'Назва'), name),
    h('div', { class: 'field' }, h('span', {}, 'Пам\'ять: ', ramLabel), ram,
      h('label', { class: 'check' }, useDefault, 'Використовувати загальне налаштування')),
    h('div', { class: 'foot' }, del, h('span', { style: 'flex:1' }), h('button', { class: 'btn ghost', onclick: closeModal }, 'Скасувати'), save)
  );
});

function setTab(type) {
  state.tab = type;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.type === type));
  $('#contentSearch').value = '';
  $('#contentSearch').placeholder = `Пошук: ${TYPE_NAMES[type]}...`;
  loadInstalled().then(() => searchCatalog(true));
}
$$('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.type)));

let installedProjects = new Set();

async function loadInstalled() {
  const inst = state.current;
  const type = state.tab;
  const items = await call('listContent', inst.id, type).catch(() => []);
  if (state.current !== inst || state.tab !== type) return;
  installedProjects = new Set(items.map((i) => i.projectId).filter(Boolean));
  $('#installedCount').textContent = items.length ? `(${items.length})` : '';
  const list = $('#installedList');
  if (!items.length) {
    list.replaceChildren(h('div', { class: 'note' }, `Тут поки порожньо. Знайдіть ${TYPE_NAMES[type]} у каталозі праворуч або додайте файл.`));
  } else {
    list.replaceChildren(...items.map((it) => {
      const toggle = h('label', { class: 'switch', title: it.enabled ? 'Вимкнути' : 'Увімкнути' },
        h('input', { type: 'checkbox', checked: it.enabled }), h('span'));
      toggle.querySelector('input').onchange = run(async () => {
        await call('toggleContent', inst.id, type, it.file);
        loadInstalled();
      });
      const del = h('button', { class: 'btn small ghost', title: 'Видалити' }, '✕');
      del.onclick = run(async () => {
        await call('deleteContent', inst.id, type, it.file);
        loadInstalled();
        refreshCatalogButtons();
      });
      return h('div', { class: `item ${it.enabled ? '' : 'disabled'}` },
        it.icon ? h('img', { src: it.icon }) : h('div', { class: 'ph' }),
        h('div', { class: 'info' },
          h('div', { class: 'title' }, it.title || it.baseName),
          h('div', { class: 'desc' }, it.title ? it.baseName : it.size ? `${(it.size / 1024 / 1024).toFixed(1)} МБ` : 'папка')),
        h('div', { class: 'actions' }, toggle, del));
    }));
  }
  renderHint(items);
}

function renderHint(items) {
  const inst = state.current;
  const hint = $('#contentHint');
  hint.hidden = true;
  hint.replaceChildren();
  if (state.tab === 'mod' && inst.loader === 'vanilla') {
    hint.append('Ванільна збірка не підтримує моди. Створіть збірку з Fabric, Quilt, Forge або NeoForge.');
    hint.hidden = false;
  }
  if (state.tab === 'shader') {
    if (inst.loader === 'vanilla') {
      hint.append('Для шейдерів потрібен мод Iris — створіть збірку з Fabric або NeoForge.');
      hint.hidden = false;
      return;
    }
    loadModsForShaderHint(inst);
  }
}

async function loadModsForShaderHint(inst) {
  const mods = await call('listContent', inst.id, 'mod').catch(() => []);
  const has = mods.some((m) => /iris|oculus|optifine/i.test((m.title || '') + m.baseName));
  if (has || state.current !== inst || state.tab !== 'shader') return;
  const slug = inst.loader === 'forge' ? 'oculus' : 'iris';
  const name = slug === 'iris' ? 'Iris' : 'Oculus';
  const btn = h('button', { class: 'btn small primary' }, `Встановити ${name}`);
  btn.onclick = run(async () => {
    btn.disabled = true;
    try {
      await call('install', inst.id, slug, 'mod');
      toast(`${name} встановлено`);
      loadInstalled();
    } finally {
      btn.disabled = false;
    }
  });
  const hint = $('#contentHint');
  hint.replaceChildren(h('span', {}, `Щоб шейдери працювали, потрібен мод ${name}.`), btn);
  hint.hidden = false;
}

async function searchCatalog(reset) {
  const inst = state.current;
  const type = state.tab;
  if (reset) state.catalog.offset = 0;
  const list = $('#catalogList');
  if (reset) list.replaceChildren(h('div', { class: 'note' }, 'Завантаження...'));
  let res;
  try {
    res = await call('search', {
      query: $('#contentSearch').value,
      type,
      mc: inst.mc,
      loader: inst.loader,
      offset: state.catalog.offset,
      sort: $('#contentSort').value,
    });
  } catch {
    list.replaceChildren(h('div', { class: 'note' }, 'Не вдалося завантажити каталог. Перевірте інтернет.'));
    return;
  }
  if (state.current !== inst || state.tab !== type) return;
  state.catalog.total = res.total;
  if (reset) list.replaceChildren();
  if (!res.hits.length && reset) list.append(h('div', { class: 'note' }, 'Нічого не знайдено для цієї версії.'));
  for (const hit of res.hits) list.append(catalogItem(hit, inst, type));
  state.catalog.offset += res.hits.length;
  $('#catalogMore').hidden = state.catalog.offset >= state.catalog.total;
}

function catalogItem(hit, inst, type) {
  const btn = h('button', { class: 'btn small', 'data-project': hit.id });
  setInstallBtn(btn, installedProjects.has(hit.id));
  btn.onclick = run(async () => {
    btn.disabled = true;
    btn.textContent = 'Встановлення...';
    try {
      const r = await call('install', inst.id, hit.id, type);
      toast(r.length > 1 ? `Встановлено ${hit.title} + залежності: ${r.slice(1).join(', ')}` : `Встановлено ${hit.title}`);
      await loadInstalled();
    } finally {
      refreshCatalogButtons();
    }
  });
  return h('div', { class: 'item' },
    hit.icon ? h('img', { src: hit.icon, loading: 'lazy' }) : h('div', { class: 'ph' }),
    h('div', { class: 'info' },
      h('div', { class: 'title', title: hit.title }, hit.title, h('span', { class: 'muted', style: 'font-weight:400' }, ` · ${hit.author}`)),
      h('div', { class: 'desc', title: hit.description }, `⬇ ${fmtNum(hit.downloads)} · ${hit.description}`)),
    h('div', { class: 'actions' }, btn));
}

function setInstallBtn(btn, installed) {
  btn.disabled = false;
  btn.textContent = installed ? 'Оновити' : 'Встановити';
  btn.classList.toggle('primary', !installed);
}

function refreshCatalogButtons() {
  $$('#catalogList [data-project]').forEach((b) => setInstallBtn(b, installedProjects.has(b.dataset.project)));
}

$('#contentSearch').addEventListener('input', debounce(() => searchCatalog(true), 350));
$('#contentSort').addEventListener('change', () => searchCatalog(true));
$('#catalogMore').addEventListener('click', () => searchCatalog(false));
$('#addFileBtn').addEventListener('click', run(async () => {
  const n = await call('addFiles', state.current.id, state.tab);
  if (n) {
    toast(`Додано файлів: ${n}`);
    loadInstalled();
  }
}));

// ---------- Модпаки ----------
async function searchModpacks(reset) {
  if (reset) state.mp.offset = 0;
  const list = $('#mpList');
  if (reset) list.replaceChildren(h('div', { class: 'note' }, 'Завантаження...'));
  let res;
  try {
    res = await call('search', {
      query: $('#mpSearch').value,
      type: 'modpack',
      mc: $('#mpVersion').value || undefined,
      loader: $('#mpLoader').value || undefined,
      offset: state.mp.offset,
      sort: $('#mpSort').value,
    });
  } catch {
    list.replaceChildren(h('div', { class: 'note' }, 'Не вдалося завантажити каталог. Перевірте інтернет.'));
    return;
  }
  if (reset) list.replaceChildren();
  if (!res.hits.length && reset) list.append(h('div', { class: 'note' }, 'Нічого не знайдено.'));
  for (const hit of res.hits) {
    const btn = h('button', { class: 'btn primary' }, 'Встановити');
    btn.onclick = run(async () => {
      btn.disabled = true;
      btn.textContent = 'Встановлення...';
      try {
        const inst = await call('installModpack', hit.id);
        await loadInstances();
        toast(`Модпак «${inst.name}» встановлено як нову збірку`);
        openInstance(inst.id);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Встановити';
      }
    });
    const cats = (hit.categories || []).filter((c) => LOADER_NAMES[c]).map((c) => h('span', { class: `badge ${c}` }, LOADER_NAMES[c]));
    const latest = hit.versions && hit.versions.length ? hit.versions[hit.versions.length - 1] : '';
    list.append(h('div', { class: 'item' },
      hit.icon ? h('img', { src: hit.icon, loading: 'lazy' }) : h('div', { class: 'ph' }),
      h('div', { class: 'info' },
        h('div', { class: 'title' }, hit.title, h('span', { class: 'muted', style: 'font-weight:400' }, ` · ${hit.author}`)),
        h('div', { class: 'desc' }, hit.description),
        h('div', { style: 'margin-top:4px' }, latest ? h('span', { class: 'badge' }, latest) : null, ...cats,
          h('span', { class: 'muted', style: 'font-size:12px' }, ` ⬇ ${fmtNum(hit.downloads)}`))),
      h('div', { class: 'actions' }, btn)));
  }
  state.mp.offset += res.hits.length;
  $('#mpMore').hidden = state.mp.offset >= res.total;
}
$('#mpSearch').addEventListener('input', debounce(() => searchModpacks(true), 350));
['#mpVersion', '#mpLoader', '#mpSort'].forEach((s) => $(s).addEventListener('change', () => searchModpacks(true)));
$('#mpMore').addEventListener('click', () => searchModpacks(false));
$('#importMrpackBtn').addEventListener('click', run(async () => {
  const inst = await call('importMrpack');
  if (!inst) return;
  await loadInstances();
  openInstance(inst.id);
}));

// ---------- Налаштування ----------
function renderSettings() {
  const s = state.settings;
  $('#ramRange').max = state.maxRam;
  $('#ramRange').value = s.ramMax;
  $('#ramLabel').textContent = `${s.ramMax} МБ`;
  $('#javaPath').value = s.javaPath || '';
  $('#closeOnLaunch').checked = s.closeOnLaunch;
  $('#showSnapshots').checked = s.showSnapshots;
}
const saveSettings = run(async (patch) => {
  state.settings = await call('setSettings', patch);
  renderSettings();
});
$('#ramRange').addEventListener('input', (e) => ($('#ramLabel').textContent = `${e.target.value} МБ`));
$('#ramRange').addEventListener('change', (e) => saveSettings({ ramMax: Number(e.target.value) }));
$('#javaPath').addEventListener('change', (e) => saveSettings({ javaPath: e.target.value.trim() }));
$('#closeOnLaunch').addEventListener('change', (e) => saveSettings({ closeOnLaunch: e.target.checked }));
$('#showSnapshots').addEventListener('change', (e) => saveSettings({ showSnapshots: e.target.checked }));
$('#openDataBtn').addEventListener('click', () => api.openDataFolder());

// ---------- Статус, прогрес, консоль ----------
let statusTimer;
api.on('progress', (p) => {
  clearTimeout(statusTimer);
  const fill = $('#progressFill');
  if (p.text) $('#statusText').textContent = p.text;
  if (p.value == null) {
    fill.classList.add('indeterminate');
  } else {
    fill.classList.remove('indeterminate');
    fill.style.width = `${Math.round(p.value * 100)}%`;
  }
  if (p.done) {
    fill.classList.remove('indeterminate');
    statusTimer = setTimeout(() => {
      $('#statusText').textContent = 'Готово';
      fill.style.width = '0';
    }, 3000);
  }
});

const consoleLines = [];
const flushConsole = debounce(() => {
  const out = $('#consoleOut');
  const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 30;
  out.textContent = consoleLines.join('\n');
  if (atBottom) out.scrollTop = out.scrollHeight;
}, 100);
api.on('log', (line) => {
  consoleLines.push(line);
  if (consoleLines.length > 3000) consoleLines.splice(0, consoleLines.length - 3000);
  flushConsole();
});
$('#consoleBtn').addEventListener('click', () => {
  $('#console').hidden = !$('#console').hidden;
  flushConsole();
});
$('#consoleClose').addEventListener('click', () => ($('#console').hidden = true));
$('#consoleClear').addEventListener('click', () => {
  consoleLines.length = 0;
  flushConsole();
});

api.on('game-state', (s) => {
  if (s.running) state.running.add(s.instanceId);
  else {
    state.running.delete(s.instanceId);
    if (s.code && s.code !== 0) {
      toast(`Гра завершилась з помилкою (код ${s.code}). Подробиці в консолі.`, 'error');
      $('#console').hidden = false;
    }
  }
  renderInstances();
});

// ---------- Старт ----------
(async function init() {
  try {
    [state.auth, state.settings, state.maxRam] = await Promise.all([call('authState'), call('getSettings'), call('systemRam')]);
    state.maxRam = Math.max(2048, Math.floor(state.maxRam / 512) * 512);
    (await call('running')).forEach((id) => state.running.add(id));
    renderAccount();
    renderSettings();
    await loadInstances();
    if (!state.auth.account) openAccountModal();
    // Список версій для фільтра модпаків
    const versions = await call('mcVersions', false).catch(() => []);
    $('#mpVersion').append(...versions.map((v) => h('option', { value: v.id }, v.id)));
  } catch (e) {
    console.error(e);
  }
})();
