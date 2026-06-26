const express = require('express');
const { WujiCRM, FIELD_LABELS } = require('./modules/wuji-crm');
const { VoiceFox } = require('./modules/voicefox');
const { Pipeline } = require('./modules/pipeline');

const app = express();
const PORT = process.env.PORT || 3456;

app.use(express.static('public'));
app.use(express.json());

// Suppress favicon 404
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Backward compatibility redirects for old API paths
const oldRedirects = [
  ['/api/leads', '/api/wuji/leads'],
  ['/api/record', '/api/wuji/record'],
  ['/api/updatelog', '/api/wuji/updatelog'],
  ['/api/settings', '/api/wuji/settings'],
  ['/api/login', '/api/voicefox/login'],
  ['/api/sync', '/api/voicefox/sync'],
  ['/api/task', '/api/voicefox/task'],
  ['/api/calls', '/api/voicefox/calls'],
  ['/api/speakers', '/api/voicefox/speakers'],
];
oldRedirects.forEach(([old, next]) => {
  app.all(old + '(/)?$', (req, res) => res.redirect(301, next));
  app.all(old + '/*', (req, res) => res.redirect(301, next + '/' + req.params[0]));
});

// ---------- Init Modules ----------
const wuji = new WujiCRM();
const voicefox = new VoiceFox();
const pipeline = new Pipeline(wuji, voicefox);

// ===================================================================
// Unified Status
// ===================================================================
app.get('/api/status', (req, res) => {
  res.json({
    wuji: wuji.getStatus(),
    voicefox: voicefox.getStatus(),
    pipeline: pipeline.getStatus(),
  });
});

// ===================================================================
// Wuji CRM Routes
// ===================================================================

app.get('/api/wuji/cached', (req, res) => {
  res.json({
    success: true,
    data: { list: Object.values(wuji.cachedLeads), total: Object.keys(wuji.cachedLeads).length },
    lastFetchTime: wuji.lastFetchTime,
  });
});

app.get('/api/wuji/leads', async (req, res) => {
  try {
    await wuji.doSync();
    res.json({
      success: true,
      data: { list: Object.values(wuji.cachedLeads), total: Object.keys(wuji.cachedLeads).length },
      error: wuji.fetchError,
      lastFetchTime: wuji.lastFetchTime,
      syncInfo: wuji.lastSyncInfo,
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/wuji/updatelog', (req, res) => {
  res.json({ success: true, log: wuji.updateLog });
});

app.post('/api/wuji/settings', (req, res) => {
  const iv = parseInt(req.body.pollIntervalMs);
  if (iv && iv >= 5000 && iv <= 3600000) {
    wuji.setPollInterval(iv);
    res.json({ success: true, pollIntervalMs: iv });
  } else {
    res.json({ success: false, error: '请设置 5000-3600000 毫秒' });
  }
});

app.get('/api/wuji/record/:leadsId', async (req, res) => {
  const { leadsId } = req.params;
  if (!leadsId) { res.json({ success: false, error: 'Missing leadsId' }); return; }
  try {
    const records = await wuji.getFollowUpRecords(leadsId, req.query.page || 1);
    res.json({ success: true, ...records });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/wuji/record/add', async (req, res) => {
  const { leadsId, content, type } = req.body;
  if (!leadsId || !content) { res.json({ success: false, error: '缺少参数' }); return; }
  try {
    const ok = await wuji.writeFollowUp(leadsId, content, type || 1);
    if (ok) {
      res.json({ success: true });
    } else {
      res.json({ success: false, error: '提交失败' });
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ===================================================================
// VoiceFox Routes
// ===================================================================

app.post('/api/voicefox/login', async (req, res) => {
  const { email, password } = req.body || {};
  const ok = await voicefox.doLogin(email, password);
  if (ok) {
    await voicefox.doSync();
    voicefox.startPolling();
  }
  res.json({
    success: ok,
    error: voicefox.loginError,
    projectId: voicefox.projectId,
    user: voicefox.userProfile ? { email: voicefox.userProfile.email, displayName: voicefox.userProfile.displayName } : null,
  });
});

app.get('/api/voicefox/sync', async (req, res) => {
  try {
    const info = await voicefox.doSync();
    res.json({ success: true, data: info, error: voicefox.fetchError });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/voicefox/updatelog', (req, res) => {
  res.json({ success: true, log: voicefox.updateLog });
});

app.post('/api/voicefox/settings', (req, res) => {
  const iv = parseInt(req.body.pollIntervalMs);
  if (iv && iv >= 5000 && iv <= 3600000) {
    voicefox.setPollInterval(iv);
    res.json({ success: true, pollIntervalMs: iv });
  } else {
    res.json({ success: false, error: '请设置 5000-3600000 毫秒' });
  }
});

// -- Tasks --
app.post('/api/voicefox/task/create', async (req, res) => {
  try {
    const { phone, name, assistantVid } = req.body || {};
    if (!phone) { res.json({ success: false, error: '请提供手机号' }); return; }
    const result = await voicefox.createTask(phone, name, assistantVid);
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/voicefox/task/:taskId', async (req, res) => {
  try {
    const result = await voicefox.getTask(parseInt(req.params.taskId));
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/voicefox/task/:taskId/statistics', async (req, res) => {
  try {
    const result = await voicefox.getTaskStatistics(parseInt(req.params.taskId));
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.patch('/api/voicefox/task/:taskId/status/:status', async (req, res) => {
  try {
    const result = await voicefox.updateTaskStatus(parseInt(req.params.taskId), req.params.status);
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/voicefox/tasks/filter', async (req, res) => {
  try {
    const result = await voicefox.filterTasks(req.body || {});
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// -- Calls --
app.post('/api/voicefox/calls', async (req, res) => {
  try {
    const { offset, limit, taskId } = req.body || {};
    const result = await voicefox.queryCallLogs(offset || 0, limit || 20, taskId);
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/voicefox/calls/cached/all', (req, res) => {
  const list = Object.values(voicefox.cachedCallsById);
  res.json({ success: true, data: { list, total: list.length, lastFetchTime: voicefox.lastFetchTime } });
});

app.get('/api/voicefox/calls/:recordId', async (req, res) => {
  try {
    const result = await voicefox.getCallDetail(parseInt(req.params.recordId));
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/voicefox/calls/:recordId/transcript', async (req, res) => {
  try {
    const result = await voicefox.getCallTranscript(parseInt(req.params.recordId));
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/voicefox/calls/:recordId/summary', async (req, res) => {
  try {
    const result = await voicefox.getCallAiSummary(parseInt(req.params.recordId));
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/voicefox/calls/:recordId/trace', async (req, res) => {
  try {
    const result = await voicefox.getCallTrace(parseInt(req.params.recordId));
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/voicefox/calls/:recordId/download', async (req, res) => {
  try {
    const detail = await voicefox.getCallDetail(parseInt(req.params.recordId));
    const url = detail.recordFile || detail.rawRecordFile;
    if (!url) { res.json({ success: false, error: '无录音文件' }); return; }
    const cookie = voicefox.buildCookieHeader();
    const resp = await fetch(url.startsWith('http') ? url : 'https://app.voicefox.cn' + url, {
      headers: { 'Cookie': cookie }, timeout: 60000,
    });
    if (resp.status !== 200) { res.json({ success: false, error: '下载失败: ' + resp.status }); return; }
    const buffer = await resp.buffer();
    res.set({ 'Content-Type': 'audio/wav', 'Content-Disposition': 'attachment; filename="call_' + req.params.recordId + '.wav"', 'Content-Length': buffer.length });
    res.send(buffer);
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/voicefox/speakers', async (req, res) => {
  try {
    const result = await voicefox.getSpeakers();
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ===================================================================
// Pipeline Routes
// ===================================================================

app.get('/api/pipeline/status', (req, res) => {
  res.json({ success: true, ...pipeline.getStatus() });
});

app.post('/api/pipeline/toggle', (req, res) => {
  const { enabled } = req.body;
  pipeline.toggle(enabled !== undefined ? !!enabled : !pipeline.enabled);
  res.json({ success: true, enabled: pipeline.enabled });
});

app.post('/api/pipeline/process/:recordId', async (req, res) => {
  const ok = await pipeline.processCallById(parseInt(req.params.recordId));
  res.json({ success: ok });
});

app.post('/api/pipeline/batch-match', async (req, res) => {
  const result = await pipeline.runBatchMatch();
  res.json({ success: true, data: result });
});

// ===================================================================
// Boot
// ===================================================================
app.listen(PORT, () => {
  console.log('');
  console.log('============================================');
  console.log('  无极CRM x VoiceFox 声狐 融合管理平台');
  console.log('  http://localhost:' + PORT);
  console.log('============================================');
  console.log('');
  wuji.boot();
  voicefox.boot();
});

