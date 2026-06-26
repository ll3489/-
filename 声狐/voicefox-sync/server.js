const express = require('express');
const fetch = require('node-fetch');
const { URLSearchParams } = require('url');

const app = express();
const PORT = 3457;
const BASE = 'https://app.voicefox.cn';

// ---------- State ----------
let sessionCookies = null;
let isLoggedIn = false;
let loginError = null;
let fetchError = null;
let projectId = null;
let userProfile = null;

let cachedTasks = [];
let cachedCallLogs = [];
let cachedCallsById = {}; // call ID -> record, for change detection and caching
let lastFetchTime = null;
let lastSyncInfo = null;

let pollTimer = null;
let pollIntervalMs = 15000;
let updateLog = [];
const MAX_LOG = 100;

// ---------- Helpers ----------

/** Manage cookies manually for node-fetch v2 (no built-in cookie jar) */
const cookieJar = {};

function extractCookies(resp) {
  const raw = resp.headers.raw()['set-cookie'];
  if (!raw) return;
  for (const header of raw) {
    const parts = header.split(';')[0].split('=');
    if (parts.length >= 2) {
      cookieJar[parts[0].trim()] = parts.slice(1).join('=').trim();
    }
  }
}

function buildCookieHeader() {
  return Object.entries(cookieJar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function apiRequest(method, path, opts = {}) {
  const url = BASE + path;
  const headers = {
    'Accept': 'application/json',
    ...(opts.headers || {}),
  };
  // Default Content-Type for JSON bodies
  if (opts.json !== undefined && !opts.isFormData && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json; charset=UTF-8';
  }
  // Attach cookies if available
  const cookie = buildCookieHeader();
  if (cookie) headers['Cookie'] = cookie;

  const fetchOpts = {
    method,
    headers,
    redirect: 'manual',
    timeout: 30000,
  };

  if (opts.json !== undefined && !opts.isFormData) {
    fetchOpts.body = JSON.stringify(opts.json);
  } else if (opts.form !== undefined) {
    fetchOpts.body = new URLSearchParams(opts.form).toString();
    delete headers['Content-Type']; // let url-search-params set it
  } else if (opts.body !== undefined) {
    fetchOpts.body = opts.body;
  }

  let resp;
  try {
    resp = await fetch(url, fetchOpts);
  } catch (err) {
    throw new Error(`Network error: ${err.message}`);
  }

  extractCookies(resp);

  // Follow redirects manually (e.g., for file downloads)
  if (resp.status >= 300 && resp.status < 400) {
    const location = resp.headers.get('location');
    if (location) {
      resp = await fetch(location.startsWith('http') ? location : BASE + location, {
        headers: { 'Cookie': buildCookieHeader() },
        timeout: 30000,
      });
    }
  }

  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('application/json') || contentType.includes('json')) {
    const data = await resp.json();
    if (resp.status >= 400) {
      throw new Error(`API error ${resp.status}: ${JSON.stringify(data)}`);
    }
    return data;
  }

  // Non-JSON response (e.g., file download)
  if (resp.status >= 400) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp;
}

// ---------- VoiceFox Auth ----------

async function doLogin() {
  try {
    const data = await apiRequest('POST', '/api/auth/login', {
      json: { email: config.email, password: config.password },
    });
    // Fetch profile to get project ID
    const profile = await apiRequest('GET', '/api/profile');
    const projects = profile.projects || [];
    if (projects.length > 0) {
      projectId = projects[0].id;
    } else {
      projectId = null;
      throw new Error('No project found in profile');
    }
    userProfile = data;
    isLoggedIn = true;
    loginError = null;
    console.log(`VoiceFox login OK — Project: ${projectId}, User: ${data.displayName || data.email}`);
    return true;
  } catch (err) {
    loginError = err.message;
    isLoggedIn = false;
    console.error('Login failed:', err.message);
    return false;
  }
}

// ---------- VoiceFox API Methods ----------

async function createTask(phone, name, assistantVid = 42558) {
  ensureLogin();
  const today = new Date().toISOString().slice(0, 10);
  const payload = {
    name: name || `auto_${phone}`,
    assistantVid: assistantVid,
    category: 'assistant',
    option: {
      numberFileMeta: { "\u53F7\u7801": 0 },
      numbers: [192],
      retryCount: 0,
      retryInterval: 60,
      smsOption: {
        isActive: false,
        sendTiming: { callHangup: true, businessStatus: [] },
        smsSignatureId: 0,
        smsTemplateId: 0,
      },
      startDate: today,
      startTime: [['00:01', '23:00']],
      taskTimeType: 'onetime',
      taskTransfer: { target: 0 },
      weeks: {
        '0': false, '1': false, '2': false,
        '3': false, '4': false, '5': false, '6': false,
      },
    },
  };
  const result = await apiRequest('PUT', `/api/project/${projectId}/task`, {
    json: payload,
  });
  const tid = result.id;
  if (tid && phone) {
    await importNumbers(tid, phone);
  }
  return result;
}

async function importNumbers(taskId, phoneNumbers) {
  ensureLogin();
  const url = `${BASE}/api/project/${projectId}/task/import_number/${taskId}`;
  const boundary = '----VoiceFox' + Date.now();
  let body;
  if (typeof phoneNumbers === 'string' && phoneNumbers.includes('\n')) {
    body = phoneNumbers;
  } else {
    body = String(phoneNumbers).replace(/,/g, '\n');
  }
  const formBody = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="numbers.csv"',
    'Content-Type: text/csv',
    '',
    body,
    `--${boundary}--`,
    '',
  ].join('\r\n');

  const cookie = buildCookieHeader();
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Cookie': cookie,
    },
    body: formBody,
    timeout: 30000,
  });
  extractCookies(resp);
  const data = await resp.json();
  if (resp.status >= 400) {
    throw new Error(`Import failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function queryCallLogs(offset = 0, limit = 20, taskId = null) {
  ensureLogin();
  const params = { offset, limit };
  if (taskId) params.taskId = taskId;
  return await apiRequest('POST', `/api/project/${projectId}/call_log`, {
    json: params,
  });
}

async function getCallDetail(recordId) {
  ensureLogin();
  return await apiRequest('GET', `/api/project/${projectId}/call_log/${recordId}`);
}

async function getCallTrace(recordId) {
  ensureLogin();
  return await apiRequest('GET', `/api/project/${projectId}/call_log_trace_info/${recordId}`);
}

async function getCallTranscript(recordId) {
  const trace = await getCallTrace(recordId);
  const items = trace.traceItems || [];
  return items
    .filter(item => item.content)
    .map(item => {
      const event = item.event || '';
      let speaker = event;
      if (event === 'system.say') speaker = 'AI';
      else if (event === 'user.say') speaker = '\u5BA2\u6237';
      else if (event === 'hangup') speaker = '\u7CFB\u7EDF';
      return {
        speaker,
        content: item.content,
        time: item.elapsedSeconds || 0,
      };
    });
}

async function getCallAiSummary(recordId) {
  ensureLogin();
  return await apiRequest('POST', `/api/project/${projectId}/call_log/${recordId}/ai_summary`);
}

async function getTask(taskId) {
  ensureLogin();
  return await apiRequest('GET', `/api/project/${projectId}/task/${taskId}`);
}

async function getTaskStatistics(taskId) {
  ensureLogin();
  return await apiRequest('GET', `/api/project/${projectId}/task/result_statistic/${taskId}`);
}

async function filterTasks(params = {}) {
  ensureLogin();
  return await apiRequest('POST', `/api/project/${projectId}/task/filter`, { json: params });
}

async function updateTaskStatus(taskId, status) {
  ensureLogin();
  return await apiRequest('PATCH', `/api/project/${projectId}/task/update_status/${taskId}/${status}`);
}

async function getSpeakers() {
  ensureLogin();
  return await apiRequest('POST', `/api/project/${projectId}/speaker`);
}

function ensureLogin() {
  if (!isLoggedIn || !projectId) {
    throw new Error('Not logged in. Call /api/login first.');
  }
}

// ---------- Sync / Polling ----------

const STATUS_MAP = {
  'answered': 'completed',
  'no_answer': 'no_answer',
  'busy': 'busy',
  'failed': 'failed',
  'cancel': 'failed',
  'timeout': 'no_answer',
};

async function doSync() {
  if (!isLoggedIn) return null;
  try {
    const logs = await queryCallLogs(0, 50);
    const items = logs.items || [];
    cachedCallLogs = items;
    // Build cache index and detect new/updated calls
    let newCount = 0;
    const prevCount = Object.keys(cachedCallsById).length;
    for (const call of items) {
      const id = call.id;
      if (!cachedCallsById[id]) newCount++;
      cachedCallsById[id] = call;
    }
    const totalCached = Object.keys(cachedCallsById).length;
    lastFetchTime = new Date().toISOString();

    const info = {
      total: logs.total || items.length,
      count: items.length,
      newCount,
      totalCached,
      answered: items.filter(i => i.hangupReason === 'answered').length,
      noAnswer: items.filter(i => i.hangupReason === 'no_answer').length,
      busy: items.filter(i => i.hangupReason === 'busy').length,
      failed: items.filter(i => i.hangupReason === 'failed').length,
    };
    lastSyncInfo = { info, time: lastFetchTime };

    updateLog.push({
      time: lastFetchTime,
      total: info.total,
      answered: info.answered,
      noAnswer: info.noAnswer,
      busy: info.busy,
      failed: info.failed,
    });
    if (updateLog.length > MAX_LOG) {
      updateLog = updateLog.slice(updateLog.length - MAX_LOG);
    }

    fetchError = null;
    console.log(`VoiceFox sync: ${info.total} calls, ${info.answered} answered`);
    return info;
  } catch (err) {
    fetchError = err.message;
    return null;
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(doSync, pollIntervalMs);
}

async function boot() {
  for (let i = 1; i <= 20; i++) {
    console.log(`VoiceFox login attempt ${i}`);
    if (await doLogin()) break;
    await new Promise(r => setTimeout(r, 30000));
  }
  if (!isLoggedIn) {
    console.error('VoiceFox boot failed — check credentials');
    return;
  }
  await doSync();
  startPolling();
}

// ---------- Express Routes ----------

app.use(express.static('public'));
app.use(express.json());

// Config (loaded from env or defaults)
const config = {
  base_url: process.env.VOICEFOX_BASE_URL || 'https://app.voicefox.cn',
  email: process.env.VOICEFOX_EMAIL || '3304495257@qq.com',
  password: process.env.VOICEFOX_PASSWORD || '12345678.',
};

// Auth
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (email) config.email = email;
  if (password) config.password = password;
  if (!config.email || !config.password) {
    res.json({ success: false, error: '请提供邮箱和密码' });
    return;
  }
  const ok = await doLogin();
  res.json({
    success: ok,
    error: loginError,
    projectId,
    user: userProfile ? { email: userProfile.email, displayName: userProfile.displayName } : null,
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    loggedIn: isLoggedIn,
    projectId,
    cachedCallCount: cachedCallLogs.length,
    totalCached: Object.keys(cachedCallsById).length,
    lastFetchTime,
    loginError,
    fetchError,
    pollIntervalMs,
    lastSyncInfo,
    user: userProfile ? { email: userProfile.email, displayName: userProfile.displayName } : null,
  });
});

// Tasks
app.post('/api/task/create', async (req, res) => {
  try {
    const { phone, name, assistantVid } = req.body || {};
    if (!phone) {
      res.json({ success: false, error: '请提供手机号' });
      return;
    }
    const result = await createTask(phone, name, assistantVid);
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/task/:taskId', async (req, res) => {
  try {
    const result = await getTask(parseInt(req.params.taskId));
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/task/:taskId/statistics', async (req, res) => {
  try {
    const result = await getTaskStatistics(parseInt(req.params.taskId));
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.patch('/api/task/:taskId/status/:status', async (req, res) => {
  try {
    const result = await updateTaskStatus(parseInt(req.params.taskId), req.params.status);
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Call logs
app.post('/api/calls', async (req, res) => {
  try {
    const { offset, limit, taskId } = req.body || {};
    const result = await queryCallLogs(offset || 0, limit || 20, taskId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Return all cached calls (for frontend persistence)
app.get('/api/calls/cached/all', (req, res) => {
  const list = Object.values(cachedCallsById);
  res.json({ success: true, data: { list, total: list.length, lastFetchTime } });
});

app.get('/api/calls/:recordId', async (req, res) => {
  try {
    const result = await getCallDetail(parseInt(req.params.recordId));
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/calls/:recordId/transcript', async (req, res) => {
  try {
    const result = await getCallTranscript(parseInt(req.params.recordId));
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/calls/:recordId/summary', async (req, res) => {
  try {
    const result = await getCallAiSummary(parseInt(req.params.recordId));
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/calls/:recordId/trace', async (req, res) => {
  try {
    const result = await getCallTrace(parseInt(req.params.recordId));
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});


// Download recording
app.get('/api/calls/:recordId/download', async (req, res) => {
  try {
    const detail = await getCallDetail(parseInt(req.params.recordId));
    const url = detail.recordFile || detail.rawRecordFile;
    if (!url) { res.json({ success: false, error: 'No recording file' }); return; }
    const cookie = buildCookieHeader();
    const resp = await fetch(url.startsWith('http') ? url : 'https://app.voicefox.cn' + url, {
      headers: { 'Cookie': cookie },
      timeout: 60000,
    });
    if (resp.status !== 200) { res.json({ success: false, error: 'Download failed: ' + resp.status }); return; }
    const buffer = await resp.buffer();
    res.set({
      'Content-Type': 'audio/wav',
      'Content-Disposition': 'attachment; filename="call_' + req.params.recordId + '.wav"',
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Sync
app.get('/api/sync', async (req, res) => {
  try {
    const info = await doSync();
    res.json({ success: true, data: info, error: fetchError });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/updatelog', (req, res) => {
  res.json({ success: true, log: updateLog });
});

app.post('/api/settings', (req, res) => {
  const iv = parseInt(req.body.pollIntervalMs);
  if (iv && iv >= 5000 && iv <= 3600000) {
    pollIntervalMs = iv;
    startPolling();
    res.json({ success: true, pollIntervalMs: iv });
  } else {
    res.json({ success: false, error: '请设置 5000-3600000 毫秒' });
  }
});

// Speakers
app.get('/api/speakers', async (req, res) => {
  try {
    const result = await getSpeakers();
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Filters
app.post('/api/tasks/filter', async (req, res) => {
  try {
    const result = await filterTasks(req.body || {});
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ---------- Boot ----------

app.listen(PORT, () => {
  console.log('');
  console.log('============================================');
  console.log('  VoiceFox（声狐）AI 外呼平台管理 v1');
  console.log('  http://localhost:' + PORT);
  console.log('============================================');
  console.log('');
  // Auto-login if credentials are set via env
  if (config.email && config.password) {
    boot();
  } else {
    console.log('请在页面中配置邮箱和密码后点击登录');
  }
});
