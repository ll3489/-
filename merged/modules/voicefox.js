const fetch = require('node-fetch');
const { URLSearchParams } = require('url');
const { save, load } = require('./persist');

// ---------- Config ----------
const CONFIG = {
  baseUrl: process.env.VOICEFOX_BASE_URL || 'https://app.voicefox.cn',
  email: process.env.VOICEFOX_EMAIL || '3304495257@qq.com',
  password: process.env.VOICEFOX_PASSWORD || '12345678.',
};

const MAX_LOG = 100;

class VoiceFox {
  constructor() {
    this.cookieJar = {};
    this.isLoggedIn = false;
    this.loginError = null;
    this.fetchError = null;
    this.projectId = null;
    this.userProfile = null;
    this.cachedCallLogs = [];
    this.cachedCallsById = {};
    this.lastFetchTime = null;
    this.lastSyncInfo = null;
    this.pollTimer = null;
    this.pollIntervalMs = 15000;
    this.updateLog = [];
    this.onSync = null;
    this._restoreFromDisk();
  }

  // ---------- Persistence ----------
  _saveToDisk() {
    save('voicefox', {
      cachedCallsById: this.cachedCallsById,
      cachedCallLogs: this.cachedCallLogs,
      lastFetchTime: this.lastFetchTime,
      lastSyncInfo: this.lastSyncInfo,
      updateLog: this.updateLog,
    });
  }

  _restoreFromDisk() {
    const data = load('voicefox');
    if (data) {
      this.cachedCallsById = data.cachedCallsById || {};
      this.cachedCallLogs = data.cachedCallLogs || [];
      this.lastFetchTime = data.lastFetchTime || null;
      this.lastSyncInfo = data.lastSyncInfo || null;
      this.updateLog = data.updateLog || [];
      console.log('[声狐] 从磁盘恢复 ' + Object.keys(this.cachedCallsById).length + ' 条通话, ' + this.updateLog.length + ' 条日志');
    }
  }

  // ---------- Cookie Management ----------
  extractCookies(resp) {
    const raw = resp.headers.raw()['set-cookie'];
    if (!raw) return;
    for (const header of raw) {
      const parts = header.split(';')[0].split('=');
      if (parts.length >= 2) {
        this.cookieJar[parts[0].trim()] = parts.slice(1).join('=').trim();
      }
    }
  }

  buildCookieHeader() {
    return Object.entries(this.cookieJar)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  // ---------- Low-level API ----------
  async apiRequest(method, path, opts = {}) {
    const url = CONFIG.baseUrl + path;
    const headers = {
      'Accept': 'application/json',
      ...(opts.headers || {}),
    };
    if (opts.json !== undefined && !opts.isFormData && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json; charset=UTF-8';
    }
    const cookie = this.buildCookieHeader();
    if (cookie) headers['Cookie'] = cookie;

    const fetchOpts = {
      method, headers,
      redirect: 'manual',
      timeout: 30000,
    };

    if (opts.json !== undefined && !opts.isFormData) {
      fetchOpts.body = JSON.stringify(opts.json);
    } else if (opts.form !== undefined) {
      fetchOpts.body = new URLSearchParams(opts.form).toString();
      delete headers['Content-Type'];
    } else if (opts.body !== undefined) {
      fetchOpts.body = opts.body;
    }

    let resp;
    try {
      resp = await fetch(url, fetchOpts);
    } catch (err) {
      throw new Error(`网络错误: ${err.message}`);
    }

    this.extractCookies(resp);

    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (location) {
        resp = await fetch(location.startsWith('http') ? location : CONFIG.baseUrl + location, {
          headers: { 'Cookie': this.buildCookieHeader() },
          timeout: 30000,
        });
      }
    }

    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json') || contentType.includes('json')) {
      const data = await resp.json();
      if (resp.status >= 400) throw new Error(`API错误 ${resp.status}: ${JSON.stringify(data)}`);
      return data;
    }

    if (resp.status >= 400) {
      const text = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    return resp;
  }

  // ---------- Auth ----------
  async doLogin(email, password) {
    const e = email || CONFIG.email;
    const p = password || CONFIG.password;
    if (!e || !p) {
      this.loginError = '请提供邮箱和密码';
      return false;
    }
    try {
      const data = await this.apiRequest('POST', '/api/auth/login', {
        json: { email: e, password: p },
      });
      const profile = await this.apiRequest('GET', '/api/profile');
      const projects = profile.projects || [];
      if (projects.length > 0) {
        this.projectId = projects[0].id;
      } else {
        this.projectId = null;
        throw new Error('Profile中未找到项目');
      }
      this.userProfile = data;
      this.isLoggedIn = true;
      this.loginError = null;
      CONFIG.email = e;
      CONFIG.password = p;
      console.log('[声狐] 登录成功 - 项目: ' + this.projectId + ', 用户: ' + (data.displayName || data.email));
      return true;
    } catch (err) {
      this.loginError = err.message;
      this.isLoggedIn = false;
      console.error('[声狐] 登录失败:', err.message);
      return false;
    }
  }

  ensureLogin() {
    if (!this.isLoggedIn || !this.projectId) {
      throw new Error('未登录，请先调用 /api/voicefox/login');
    }
  }

  // ---------- Task API ----------
  async createTask(phone, name, assistantVid = 42558) {
    this.ensureLogin();
    const today = new Date().toISOString().slice(0, 10);
    const payload = {
      name: name || `auto_${phone}`,
      assistantVid: assistantVid,
      category: 'assistant',
      option: {
        numberFileMeta: { "号码": 0 },
        numbers: [192],
        retryCount: 0, retryInterval: 60,
        smsOption: { isActive: false, sendTiming: { callHangup: true, businessStatus: [] }, smsSignatureId: 0, smsTemplateId: 0 },
        startDate: today,
        startTime: [['00:01', '23:00']],
        taskTimeType: 'onetime',
        taskTransfer: { target: 0 },
        weeks: { '0': false, '1': false, '2': false, '3': false, '4': false, '5': false, '6': false },
      },
    };
    const result = await this.apiRequest('PUT', `/api/project/${this.projectId}/task`, { json: payload });
    const tid = result.id;
    if (tid && phone) {
      await this.importNumbers(tid, phone);
    }
    return result;
  }

  async importNumbers(taskId, phoneNumbers) {
    this.ensureLogin();
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
      'Content-Type: text/csv', '',
      body,
      `--${boundary}--`, '',
    ].join('\r\n');

    const cookie = this.buildCookieHeader();
    const resp = await fetch(`${CONFIG.baseUrl}/api/project/${this.projectId}/task/import_number/${taskId}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Cookie': cookie },
      body: formBody, timeout: 30000,
    });
    this.extractCookies(resp);
    const data = await resp.json();
    if (resp.status >= 400) throw new Error(`导入失败: ${JSON.stringify(data)}`);
    return data;
  }

  async getTask(taskId) {
    this.ensureLogin();
    return await this.apiRequest('GET', `/api/project/${this.projectId}/task/${taskId}`);
  }

  async getTaskStatistics(taskId) {
    this.ensureLogin();
    return await this.apiRequest('GET', `/api/project/${this.projectId}/task/result_statistic/${taskId}`);
  }

  async filterTasks(params = {}) {
    this.ensureLogin();
    return await this.apiRequest('POST', `/api/project/${this.projectId}/task/filter`, { json: params });
  }

  async updateTaskStatus(taskId, status) {
    this.ensureLogin();
    return await this.apiRequest('PATCH', `/api/project/${this.projectId}/task/update_status/${taskId}/${status}`);
  }

  async getSpeakers() {
    this.ensureLogin();
    return await this.apiRequest('POST', `/api/project/${this.projectId}/speaker`);
  }

  // ---------- Call Log API ----------
  async queryCallLogs(offset = 0, limit = 20, taskId = null) {
    this.ensureLogin();
    const params = { offset, limit };
    if (taskId) params.taskId = taskId;
    return await this.apiRequest('POST', `/api/project/${this.projectId}/call_log`, { json: params });
  }

  async getCallDetail(recordId) {
    this.ensureLogin();
    return await this.apiRequest('GET', `/api/project/${this.projectId}/call_log/${recordId}`);
  }

  async getCallTrace(recordId) {
    this.ensureLogin();
    return await this.apiRequest('GET', `/api/project/${this.projectId}/call_log_trace_info/${recordId}`);
  }

  async getCallTranscript(recordId) {
    const trace = await this.getCallTrace(recordId);
    const items = trace.traceItems || [];
    return items
      .filter(item => item.content)
      .map(item => {
        const event = item.event || '';
        let speaker = event;
        if (event === 'system.say') speaker = 'AI';
        else if (event === 'user.say') speaker = '客户';
        else if (event === 'hangup') speaker = '系统';
        return { speaker, content: item.content, time: item.elapsedSeconds || 0 };
      });
  }

  async getCallAiSummary(recordId) {
    this.ensureLogin();
    return await this.apiRequest('POST', `/api/project/${this.projectId}/call_log/${recordId}/ai_summary`);
  }

  // ---------- Sync ----------
  async doSync() {
    if (!this.isLoggedIn) return null;
    try {
      const logs = await this.queryCallLogs(0, 50);
      const items = logs.items || [];
      this.cachedCallLogs = items;
      let newCount = 0;
      const prevCount = Object.keys(this.cachedCallsById).length;
      for (const call of items) {
        const id = call.id;
        if (!this.cachedCallsById[id]) newCount++;
        this.cachedCallsById[id] = call;
      }

      const newlyAnswered = [];
      if (prevCount > 0) {
        for (const call of items) {
          if (call.hangupReason === 'answered') {
            const prev = this.cachedCallsById[call.id];
            if (!prev || prev.hangupReason !== 'answered') {
              newlyAnswered.push(call);
            }
          }
        }
      }

      const totalCached = Object.keys(this.cachedCallsById).length;
      this.lastFetchTime = new Date().toISOString();

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
      this.lastSyncInfo = { info, time: this.lastFetchTime };

      this.updateLog.push({
        time: this.lastFetchTime, total: info.total,
        answered: info.answered, noAnswer: info.noAnswer,
        busy: info.busy, failed: info.failed,
      });
      if (this.updateLog.length > MAX_LOG) {
        this.updateLog = this.updateLog.slice(this.updateLog.length - MAX_LOG);
      }

      this.fetchError = null;
      this._saveToDisk();
      console.log('[声狐] 同步完成: ' + info.total + ' 通, ' + info.answered + ' 接通');

      if (this.onSync) { this.onSync(newlyAnswered, info); }

      return info;
    } catch (err) {
      this.fetchError = err.message;
      return null;
    }
  }

  // ---------- Lifecycle ----------
  startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.doSync(), this.pollIntervalMs);
  }

  setPollInterval(ms) {
    if (ms >= 5000 && ms <= 3600000) {
      this.pollIntervalMs = ms;
      this.startPolling();
      return true;
    }
    return false;
  }

  async boot() {
    if (!CONFIG.email || !CONFIG.password) {
      console.log('[声狐] 等待前端配置登录凭证');
      return;
    }
    for (let i = 1; i <= 20; i++) {
      console.log('[声狐] 登录尝试 ' + i);
      if (await this.doLogin()) break;
      await new Promise(r => setTimeout(r, 30000));
    }
    if (!this.isLoggedIn) { console.error('[声狐] 启动失败'); return; }
    await this.doSync();
    this.startPolling();
  }

  // ---------- Status ----------
  getStatus() {
    return {
      loggedIn: this.isLoggedIn,
      projectId: this.projectId,
      cachedCallCount: this.cachedCallLogs.length,
      totalCached: Object.keys(this.cachedCallsById).length,
      lastFetchTime: this.lastFetchTime,
      loginError: this.loginError,
      fetchError: this.fetchError,
      pollIntervalMs: this.pollIntervalMs,
      lastSyncInfo: this.lastSyncInfo,
      user: this.userProfile ? { email: this.userProfile.email, displayName: this.userProfile.displayName } : null,
    };
  }
}

module.exports = { VoiceFox };

