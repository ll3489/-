const fetch = require('node-fetch');
const { chromium } = require('playwright');
const querystring = require('querystring');
const { save, load } = require('./persist');

// ---------- Config ----------
const CONFIG = {
  baseUrl: process.env.WUJI_BASE_URL || 'https://wuji.rpaab.com',
  phone: process.env.WUJI_PHONE || '15583598381',
  password: process.env.WUJI_PASSWORD || 'll123456',
};

const FIELD_LABELS = {
  leadsName:'线索名称', mobile:'手机号', telephone:'电话', ownerUserName:'负责人',
  ownerDeptName:'部门', source:'来源', assignedPool:'线索池', status:'状态', level:'等级',
  fieldGjmfug:'类别', fieldXzhmxa:'渠道', fieldJbdcox:'获客方式', fieldKqjpds:'线索金额',
  lastContent:'最后内容', updateTime:'更新时间', createTime:'创建时间', remark:'备注',
  address:'地址', email:'邮箱'
};
const WATCH_FIELDS = Object.keys(FIELD_LABELS);
const MAX_LOG = 100;

class WujiCRM {
  constructor() {
    this.adminToken = null;
    this.isLoggedIn = false;
    this.loginError = null;
    this.fetchError = null;
    this.cachedLeads = {};
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
    save('wuji', {
      cachedLeads: this.cachedLeads,
      lastFetchTime: this.lastFetchTime,
      lastSyncInfo: this.lastSyncInfo,
      updateLog: this.updateLog,
    });
  }

  _restoreFromDisk() {
    const data = load('wuji');
    if (data) {
      this.cachedLeads = data.cachedLeads || {};
      this.lastFetchTime = data.lastFetchTime || null;
      this.lastSyncInfo = data.lastSyncInfo || null;
      this.updateLog = data.updateLog || [];
      console.log('[无极CRM] 从磁盘恢复 ' + Object.keys(this.cachedLeads).length + ' 条线索, ' + this.updateLog.length + ' 条日志');
    }
  }

  // ---------- Auth ----------
  async doLogin() {
    let browser = null;
    try {
      browser = await chromium.launch({ headless: true });
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(CONFIG.baseUrl, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(5000);
      await page.fill('input[placeholder="请输入手机号"]', CONFIG.phone);
      await page.click('button:has-text("继续")');
      await page.waitForSelector('input[placeholder="请输入密码"]', { timeout: 15000 });
      await page.fill('input[placeholder="请输入密码"]', CONFIG.password);
      await page.click('button:has-text("登录")');
      let ok = false;
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(1000);
        if (!page.url().includes('login')) { ok = true; break; }
      }
      if (!ok) { this.loginError = '登录后未跳转'; this.isLoggedIn = false; return false; }
      const token = await page.evaluate(() => {
        const v = localStorage.getItem('Admin-Token');
        return v ? JSON.parse(v).data : null;
      });
      if (!token) { this.loginError = '未找到Token'; this.isLoggedIn = false; return false; }
      this.adminToken = token; this.isLoggedIn = true; this.loginError = null;
      console.log('[无极CRM] 登录成功');
      return true;
    } catch (err) {
      this.loginError = err.message; this.isLoggedIn = false; return false;
    } finally {
      if (browser) try { await browser.close(); } catch(e) {}
    }
  }

  async ensureLogin() {
    if (this.isLoggedIn && this.adminToken) return true;
    return await this.doLogin();
  }

  // ---------- API ----------
  async apiJSON(path, body) {
    if (!this.adminToken) return null;
    try {
      const resp = await fetch(CONFIG.baseUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=UTF-8', 'client': 'ADMIN_WEB', 'admin-token': this.adminToken },
        body: JSON.stringify(body),
      });
      const r = await resp.json();
      if (r.code === 302) {
        console.log('[无极CRM] Token过期，重新登录');
        this.adminToken = null; this.isLoggedIn = false;
        if (await this.doLogin()) return await this.apiJSON(path, body);
        return null;
      }
      return r;
    } catch (err) { this.fetchError = err.message; return null; }
  }

  async apiForm(path, body) {
    if (!this.adminToken) return null;
    try {
      const resp = await fetch(CONFIG.baseUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'client': 'ADMIN_WEB', 'admin-token': this.adminToken },
        body: querystring.stringify(body),
      });
      const r = await resp.json();
      if (r.code === 302) {
        this.adminToken = null; this.isLoggedIn = false;
        if (await this.doLogin()) return await this.apiForm(path, body);
        return null;
      }
      return r;
    } catch (err) { this.fetchError = err.message; return null; }
  }

  // ---------- Data ----------
  async fetchAllLeads() {
    const all = [];
    for (let p = 1; p <= 100; p++) {
      const r = await this.apiJSON('/crmLeads/queryPageList', {
        search: '', type: 1, sceneId: '2039616665299111936',
        searchList: [], page: p, limit: 50,
      });
      if (!r || r.code !== 0 || !r.data || !r.data.list) break;
      all.push(...r.data.list);
      if (r.data.list.length < 50) break;
    }
    return all;
  }

  getChanges(oldL, newL) {
    const c = [];
    WATCH_FIELDS.forEach(k => {
      const ov = oldL[k] !== undefined && oldL[k] !== null ? String(oldL[k]) : '';
      const nv = newL[k] !== undefined && newL[k] !== null ? String(newL[k]) : '';
      if (ov !== nv) c.push({ field: FIELD_LABELS[k], old: ov.slice(0,50), new: nv.slice(0,50) });
    });
    return c;
  }

  computeInfo(newLeads) {
    const info = { total: newLeads.length, added: 0, updated: 0, same: 0 };
    let details = []; const nm = {};
    newLeads.forEach(l => { nm[l.leadsId] = l; });
    const ok = Object.keys(this.cachedLeads);
    if (ok.length === 0) {
      info.added = newLeads.length;
      newLeads.slice(0,30).forEach(l => details.push({ leadsId:l.leadsId, leadsName:l.leadsName||l.mobile||'(无名称)', changed:[{field:'(新线索)',old:'',new:l.leadsName||l.mobile||''}] }));
      if (newLeads.length > 30) details.push({ leadsId:'', leadsName:'... 等 '+(newLeads.length-30)+' 条', changed:[] });
      return { info, details };
    }
    let dc = 0;
    Object.keys(nm).forEach(id => {
      if (!this.cachedLeads[id]) { info.added++; if (dc < 30) { dc++; details.push({ leadsId:id, leadsName:nm[id].leadsName||nm[id].mobile||'(无名称)', changed:[{field:'(新线索)',old:'',new:nm[id].leadsName||nm[id].mobile||''}] }); } }
      else {
        const ch = this.getChanges(this.cachedLeads[id], nm[id]);
        if (ch.length > 0) { info.updated++; if (dc < 30) { dc++; details.push({ leadsId:id, leadsName:nm[id].leadsName||nm[id].mobile||'(无名称)', changed:ch }); } }
        else info.same++;
      }
    });
    const tc = info.added + info.updated;
    if (tc > dc) details.push({ leadsId:'', leadsName:'... 等 '+(tc-dc)+' 条', changed:[] });
    return { info, details };
  }

  async doSync() {
    if (!this.isLoggedIn) return null;
    try {
      const leads = await this.fetchAllLeads();
      if (!leads || leads.length === 0) return null;
      const r = this.computeInfo(leads);
      const nc = {};
      leads.forEach(l => { nc[l.leadsId] = l; });
      this.cachedLeads = nc;
      this.lastFetchTime = new Date().toISOString();
      this.lastSyncInfo = { info: r.info, time: this.lastFetchTime };
      this.updateLog.push({ time: this.lastFetchTime, total: r.info.total, added: r.info.added, updated: r.info.updated, same: r.info.same, details: r.details });
      if (this.updateLog.length > MAX_LOG) this.updateLog = this.updateLog.slice(this.updateLog.length - MAX_LOG);
      this.fetchError = null;
      this._saveToDisk();
      if (this.onSync) this.onSync(r.info, r.details);
      console.log('[无极CRM] 同步完成: +' + r.info.added + ' ~' + r.info.updated + ' =' + r.info.total);
      return r.info;
    } catch (err) { this.fetchError = err.message; return null; }
  }

  // ---------- Follow-up ----------
  async writeFollowUp(leadsId, content, type = 1) {
    await this.ensureLogin();
    const body = {
      crmType: 1, activityType: 1, activityTypeId: leadsId,
      type: type, content: content, nextTime: null,
      fieldList: [{ fieldId: "1965374686921011204", value: content }],
      contactsIds: [], businessIds: [], contractIds: [],
      receivablesIds: [], productIds: [], file: null, img: null
    };
    const r = await this.apiJSON('/crmActivity/addCrmActivityRecord', body);
    return r && r.code === 0;
  }

  async getFollowUpRecords(leadsId, page = 1) {
    await this.ensureLogin();
    const [actionRecords, activityRecords] = await Promise.all([
      this.apiForm('/crmActionRecord/queryRecordList', { types: '1', actionId: leadsId, page: page, limit: 20 }),
      this.apiJSON('/crmActivity/getCrmActivityPageList', { page: 1, crmType: 1, activityTypeId: leadsId, recordType: 1, queryType: 1, wechatAccountIdList: [] })
    ]);
    return { actionRecords, activityRecords };
  }

  // ---------- Lookup ----------
  findLeadByPhone(phone) {
    const clean = phone.replace(/[^0-9]/g, '');
    for (const id of Object.keys(this.cachedLeads)) {
      const lead = this.cachedLeads[id];
      const mobile = (lead.mobile || '').replace(/[^0-9]/g, '');
      const tel = (lead.telephone || '').replace(/[^0-9]/g, '');
      if (mobile === clean || tel === clean) return lead;
    }
    return null;
  }

  // ---------- Lifecycle ----------
  startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      const info = await this.doSync();
    }, this.pollIntervalMs);
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
    for (let i = 1; i <= 20; i++) {
      console.log('[无极CRM] 登录尝试 ' + i);
      if (await this.doLogin()) break;
      await new Promise(r => setTimeout(r, 30000));
    }
    if (!this.isLoggedIn) { console.error('[无极CRM] 启动失败'); return; }
    await this.doSync();
    this.startPolling();
  }

  // ---------- Status ----------
  getStatus() {
    return {
      loggedIn: this.isLoggedIn,
      cachedCount: Object.keys(this.cachedLeads).length,
      lastFetchTime: this.lastFetchTime,
      loginError: this.loginError,
      fetchError: this.fetchError,
      pollIntervalMs: this.pollIntervalMs,
      lastSyncInfo: this.lastSyncInfo,
    };
  }
}

module.exports = { WujiCRM, FIELD_LABELS };

