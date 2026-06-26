const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function save(name, data) {
  try {
    ensureDir();
    const file = path.join(DATA_DIR, name + '.json');
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`[Persist] 保存 ${name} 失败:`, err.message);
  }
}

function load(name) {
  try {
    ensureDir();
    const file = path.join(DATA_DIR, name + '.json');
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error(`[Persist] 读取 ${name} 失败:`, err.message);
  }
  return null;
}

module.exports = { save, load };
