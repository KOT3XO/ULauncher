const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Усі дані лаунчера: %APPDATA%\.ulauncher
const ROOT = path.join(app.getPath('appData'), '.ulauncher');

const paths = {
  ROOT,
  // Спільні файли гри (версії, бібліотеки, ассети) — одні на всі збірки
  SHARED: path.join(ROOT, 'shared'),
  // Кожна збірка має свою папку гри (mods, saves, shaderpacks...)
  INSTANCES: path.join(ROOT, 'instances'),
  // Java, яку лаунчер завантажує сам
  RUNTIMES: path.join(ROOT, 'runtimes'),
  CACHE: path.join(ROOT, 'cache'),
  CONFIG: path.join(ROOT, 'config.json'),
};

for (const p of [paths.ROOT, paths.SHARED, paths.INSTANCES, paths.RUNTIMES, paths.CACHE]) {
  fs.mkdirSync(p, { recursive: true });
}

module.exports = paths;
