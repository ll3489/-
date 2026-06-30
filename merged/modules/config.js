const fs = require('fs');
const path = require('path');
const { save, load } = require('./persist');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

let cachedConfig = null;

function getConfig() {
  if (cachedConfig) return cachedConfig;
  const data = load('config');
  if (data) {
    cachedConfig = data;
    return data;
  }
  // Fallback to env vars
  cachedConfig = {
    wuji: {
      baseUrl: process.env.WUJI_BASE_URL || 'https://wuji.rpaab.com',
      phone: process.env.WUJI_PHONE || '',
      password: process.env.WUJI_PASSWORD || '',
    },
    voicefox: {
      baseUrl: process.env.VOICEFOX_BASE_URL || 'https://app.voicefox.cn',
      email: process.env.VOICEFOX_EMAIL || '',
      password: process.env.VOICEFOX_PASSWORD || '',
    },
  };
  return cachedConfig;
}

function setConfig(newConfig) {
  cachedConfig = newConfig;
  save('config', newConfig);
}

function isConfigured() {
  const cfg = getConfig();
  return !!(cfg.wuji.phone && cfg.wuji.password && cfg.voicefox.email && cfg.voicefox.password);
}

module.exports = { getConfig, setConfig, isConfigured };
