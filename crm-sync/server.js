const express = require('express');
const fetch = require('node-fetch');
const { chromium } = require('playwright');
const querystring = require('querystring');

const app = express();
const PORT = 3456;
const BASE = 'https://wuji.rpaab.com';

let adminToken = null, isLoggedIn = false, loginError = null, fetchError = null;
let cachedLeads = {}, lastFetchTime = null, lastSyncInfo = null;
let pollTimer = null, pollIntervalMs = 15000, updateLog = [];
const MAX_LOG = 100;

const FIELD_LABELS = {
  leadsName:'线索名称',mobile:'手机号',telephone:'电话',ownerUserName:'负责人',
  ownerDeptName:'部门',source:'来源',assignedPool:'线索池',status:'状态',level:'等级',
  fieldGjmfug:'类别',fieldXzhmxa:'渠道',fieldJbdcox:'获客方式',fieldKqjpds:'线索金额',
  lastContent:'最后内容',updateTime:'更新时间',createTime:'创建时间',remark:'备注',
  address:'地址',email:'邮箱'
};
const WATCH_FIELDS = Object.keys(FIELD_LABELS);

async function doLogin() {
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(5000);
    await page.fill('input[placeholder="请输入手机号"]', '15583598381');
    await page.click('button:has-text("继续")');
    await page.waitForSelector('input[placeholder="请输入密码"]', { timeout: 15000 });
    await page.fill('input[placeholder="请输入密码"]', 'll123456');
    await page.click('button:has-text("登录")');
    let ok = false;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1000);
      if (!page.url().includes('login')) { ok = true; break; }
    }
    if (!ok) { loginError = 'Login page did not redirect'; isLoggedIn = false; return false; }
    const token = await page.evaluate(() => {
      const v = localStorage.getItem('Admin-Token');
      return v ? JSON.parse(v).data : null;
    });
    if (!token) { loginError = 'No token found'; isLoggedIn = false; return false; }
    adminToken = token; isLoggedIn = true; loginError = null;
    console.log('Login OK'); return true;
  } catch (err) {
    loginError = err.message; isLoggedIn = false; return false;
  } finally {
    if (browser) try { await browser.close(); } catch(e) {}
  }
}

async function apiJSON(path, body) {
  if (!adminToken) return null;
  try {
    const resp = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8', 'client': 'ADMIN_WEB', 'admin-token': adminToken },
      body: JSON.stringify(body),
    });
    const r = await resp.json();
    if (r.code === 302) {
      console.log('Token expired');
      adminToken = null; isLoggedIn = false;
      if (await doLogin()) return await apiJSON(path, body);
      return null;
    }
    return r;
  } catch (err) { fetchError = err.message; return null; }
}

async function apiForm(path, body) {
  if (!adminToken) return null;
  try {
    const resp = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'client': 'ADMIN_WEB', 'admin-token': adminToken },
      body: querystring.stringify(body),
    });
    const r = await resp.json();
    if (r.code === 302) {
      adminToken = null; isLoggedIn = false;
      if (await doLogin()) return await apiForm(path, body);
      return null;
    }
    return r;
  } catch (err) { fetchError = err.message; return null; }
}

async function fetchAllLeads() {
  const all = [];
  for (let p = 1; p <= 100; p++) {
    const r = await apiJSON('/crmLeads/queryPageList', {
      search: '', type: 1, sceneId: '2039616665299111936',
      searchList: [], page: p, limit: 50,
    });
    if (!r || r.code !== 0 || !r.data || !r.data.list) break;
    all.push(...r.data.list);
    if (r.data.list.length < 50) break;
  }
  return all;
}

function getChanges(oldL, newL) {
  const c = [];
  WATCH_FIELDS.forEach(k => {
    const ov = oldL[k] !== undefined && oldL[k] !== null ? String(oldL[k]) : '';
    const nv = newL[k] !== undefined && newL[k] !== null ? String(newL[k]) : '';
    if (ov !== nv) c.push({ field: FIELD_LABELS[k], old: ov.slice(0,50), new: nv.slice(0,50) });
  });
  return c;
}

function computeInfo(newLeads) {
  const info = { total: newLeads.length, added: 0, updated: 0, same: 0 };
  let details = []; const nm = {};
  newLeads.forEach(l => { nm[l.leadsId] = l; });
  const ok = Object.keys(cachedLeads);
  if (ok.length === 0) {
    info.added = newLeads.length;
    newLeads.slice(0,30).forEach(l => details.push({ leadsId:l.leadsId, leadsName:l.leadsName||l.mobile||'(无名称)', changed:[{field:'(新线索)',old:'',new:l.leadsName||l.mobile||''}] }));
    if (newLeads.length > 30) details.push({ leadsId:'', leadsName:'... 等 '+(newLeads.length-30)+' 条', changed:[] });
    return { info, details };
  }
  let dc = 0;
  Object.keys(nm).forEach(id => {
    if (!cachedLeads[id]) { info.added++; if (dc < 30) { dc++; details.push({ leadsId:id, leadsName:nm[id].leadsName||nm[id].mobile||'(无名称)', changed:[{field:'(新线索)',old:'',new:nm[id].leadsName||nm[id].mobile||''}] }); } }
    else {
      const ch = getChanges(cachedLeads[id], nm[id]);
      if (ch.length > 0) { info.updated++; if (dc < 30) { dc++; details.push({ leadsId:id, leadsName:nm[id].leadsName||nm[id].mobile||'(无名称)', changed:ch }); } }
      else info.same++;
    }
  });
  const tc = info.added + info.updated;
  if (tc > dc) details.push({ leadsId:'', leadsName:'... 等 '+(tc-dc)+' 条', changed:[] });
  return { info, details };
}

async function doSync() {
  if (!isLoggedIn) return null;
  try {
    const leads = await fetchAllLeads();
    if (!leads || leads.length === 0) return null;
    const r = computeInfo(leads);
    const nc = {};
    leads.forEach(l => { nc[l.leadsId] = l; });
    cachedLeads = nc;
    lastFetchTime = new Date().toISOString();
    lastSyncInfo = { info: r.info, time: lastFetchTime };
    updateLog.push({ time: lastFetchTime, total: r.info.total, added: r.info.added, updated: r.info.updated, same: r.info.same, details: r.details });
    if (updateLog.length > MAX_LOG) updateLog = updateLog.slice(updateLog.length - MAX_LOG);
    fetchError = null;
    console.log('Sync: +' + r.info.added + ' ~' + r.info.updated + ' =' + r.info.total);
    return r.info;
  } catch (err) { fetchError = err.message; return null; }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(doSync, pollIntervalMs);
}

app.use(express.static('public'));
app.use(express.json());

app.get('/api/status', (req, res) => res.json({ loggedIn: isLoggedIn, cachedCount: Object.keys(cachedLeads).length, lastFetchTime, loginError, fetchError, pollIntervalMs, lastSyncInfo }));

app.get('/api/leads', async (req, res) => {
  try { await doSync(); res.json({ success: true, data: { list: Object.values(cachedLeads), total: Object.keys(cachedLeads).length }, error: fetchError, lastFetchTime, syncInfo: lastSyncInfo }); }
  catch (err) { res.json({ success: false, error: err.message }); }
});

app.get('/api/updatelog', (req, res) => res.json({ success: true, log: updateLog }));

app.post('/api/settings', (req, res) => {
  const iv = parseInt(req.body.pollIntervalMs);
  if (iv && iv >= 5000 && iv <= 3600000) { pollIntervalMs = iv; startPolling(); res.json({ success: true, pollIntervalMs: iv }); }
  else res.json({ success: false, error: '请设置 5-3600000 毫秒' });
});

// Follow-up records API
app.get('/api/record/:leadsId', async (req, res) => {
  const id = req.params.leadsId;
  const page = req.query.page || 1;
  if (!id) { res.json({ success: false, error: 'Missing leadsId' }); return; }
  
  // Call both APIs
  const [actionRecords, activityRecords] = await Promise.all([
    apiForm('/crmActionRecord/queryRecordList', { types: '1', actionId: id, page: page, limit: 20 }),
    apiJSON('/crmActivity/getCrmActivityPageList', { page: 1, crmType: 1, activityTypeId: id, recordType: 1, queryType: 1, wechatAccountIdList: [] })
  ]);
  
  res.json({
    success: true,
    actionRecords: actionRecords,
    activityRecords: activityRecords
  });
});

app.post('/api/record/add', async (req, res) => {
  const { leadsId, content, type } = req.body;
  if (!leadsId || !content) { res.json({ success: false, error: '缺少参数' }); return; }
  const body = {
    crmType: 1,
    activityType: 1,
    activityTypeId: leadsId,
    type: type || 1,
    content: content,
    nextTime: null,
    fieldList: [{ fieldId: "1965374686921011204", value: content }],
    contactsIds: [],
    businessIds: [],
    contractIds: [],
    receivablesIds: [],
    productIds: [],
    file: null,
    img: null
  };
  const r = await apiJSON('/crmActivity/addCrmActivityRecord', body);
  if (r && r.code === 0) {
    res.json({ success: true });
  } else {
    res.json({ success: false, error: (r && r.msg) || '提交失败', detail: r });
  }
});

async function boot() {
  for (let i = 1; i <= 20; i++) {
    console.log('Login attempt', i);
    if (await doLogin()) break;
    await new Promise(r => setTimeout(r, 30000));
  }
  if (!isLoggedIn) { console.error('Boot failed'); return; }
  await doSync(); startPolling();
}

app.listen(PORT, () => {
  console.log(''); console.log('============================================');
  console.log('  无极CRM 线索同步 v4'); console.log('  http://localhost:' + PORT);
  console.log('============================================'); console.log(''); boot();
});