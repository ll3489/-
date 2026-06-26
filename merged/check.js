
// ===================================================================
// Global State
// ===================================================================
var allLeads = [], filteredLeads = [];
var allCalls = [], filteredCalls = [];
var allTasks = [];
var leadsSortField = 'createTime', leadsSortDir = -1, leadsPage = 1, LEADS_PAGE_SIZE = 20;
var callsSortField = 'startAt', callsSortDir = -1, callsPage = 1, CALLS_PAGE_SIZE = 20;
var pollingLeads = false, pollingCalls = false;
var currentTab = 'leads', currentSubtab = 'call-logs';

// ===================================================================
// Utils
// ===================================================================
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtTime(ts) { if (!ts) return '--'; try { return new Date(ts).toLocaleString(); } catch(e) { return ts; } }
function fmtDur(sec) { if (!sec && sec !== 0) return '--'; var m = Math.floor(sec/60); var s = sec%60; return m>0 ? m+'分'+s+'秒' : s+'秒'; }

// ===================================================================
// Tab Switching
// ===================================================================
function switchTab(tab) {
  document.querySelectorAll('.tabs .tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.tab-content').forEach(function(t) { t.classList.remove('active'); });
  document.querySelector('.tabs .tab[data-tab="'+tab+'"]').classList.add('active');
  document.getElementById('tab'+tab.charAt(0).toUpperCase()+tab.slice(1)).classList.add('active');
  currentTab = tab;
  if (tab === 'leads') { filterLeads(); }
  if (tab === 'calls') { filterCalls(); }
  if (tab === 'pipeline') { refreshPipeline(); }
}

function switchSubtab(subtab) {
  var parent = document.querySelector('#tabCalls') || document;
  parent.querySelectorAll('.tab[data-subtab]').forEach(function(t) { t.classList.remove('active'); });
  parent.querySelectorAll('.subtab-content').forEach(function(t) { t.classList.remove('active'); });
  var tab = parent.querySelector('.tab[data-subtab="'+subtab+'"]');
  if (tab) tab.classList.add('active');
  var content = document.getElementById('subtab'+subtab.charAt(0).toUpperCase()+subtab.slice(1).replace(/-./g,function(m){return m[1].toUpperCase();}));
  if (content) content.classList.add('active');
  currentSubtab = subtab;
}

// ===================================================================
// Status
// ===================================================================
async function refreshStatus() {
  try {
    var r = await fetch('/api/status');
    var d = await r.json();
    // Wuji
    var bw = document.getElementById('badgeWuji');
    var sw = document.getElementById('statusWuji');
    if (d.wuji.loggedIn) { bw.className = 'badge online'; sw.textContent = '无极在线'; }
    else { bw.className = 'badge offline'; sw.textContent = d.wuji.loginError || '无极离线'; }
    // Voicefox
    var bv = document.getElementById('badgeVoicefox');
    var sv = document.getElementById('statusVoicefox');
    if (d.voicefox.loggedIn) { bv.className = 'badge online'; sv.textContent = '声狐在线'; }
    else { bv.className = 'badge offline'; sv.textContent = d.voicefox.loginError || '声狐离线'; }
    // Pipeline
    var bp = document.getElementById('badgePipeline');
    var sp = document.getElementById('statusPipeline');
    if (d.pipeline && d.pipeline.enabled) { bp.className = 'badge online'; sp.textContent = '联动运行中'; }
    else { bp.className = 'badge pending'; sp.textContent = '联动暂停'; }
    if (d.pipeline) updatePipelineUI(d.pipeline);
    // Wuji sync info
    if (d.wuji.lastSyncInfo) showWujiSyncInfo(d.wuji.lastSyncInfo.info, d.wuji.lastSyncInfo.time);
    if (d.wuji.fetchError) showWujiError(d.wuji.fetchError); else showWujiError(null);
    // Voicefox sync info
    if (d.voicefox.lastSyncInfo) showVfSyncInfo(d.voicefox.lastSyncInfo.info, d.voicefox.lastSyncInfo.time);
    if (d.voicefox.fetchError) showVfError(d.voicefox.fetchError); else showVfError(null);
    // Poll intervals
    var ws = document.getElementById('wujiInterval');
    for (var i=0;i<ws.options.length;i++) if (parseInt(ws.options[i].value)===d.wuji.pollIntervalMs) { ws.value=d.wuji.pollIntervalMs; break; }
    var vs = document.getElementById('vfInterval');
    for (var i=0;i<vs.options.length;i++) if (parseInt(vs.options[i].value)===d.voicefox.pollIntervalMs) { vs.value=d.voicefox.pollIntervalMs; break; }
    // Show user info if logged in
    if (d.voicefox.loggedIn && d.voicefox.user) {
      document.getElementById('vfLoginStatus').textContent = d.voicefox.user.displayName || d.voicefox.user.email;
    }
  } catch(e) {}
}

// ===================================================================
// Wuji CRM: Leads
// ===================================================================
var FIELD_LABELS = {
  leadsName:'线索名称', mobile:'手机号', telephone:'电话', ownerUserName:'负责人',
  ownerDeptName:'部门', source:'来源', assignedPool:'线索池', status:'状态', level:'等级',
  fieldGjmfug:'类别', fieldXzhmxa:'渠道', fieldJbdcox:'获客方式', fieldKqjpds:'线索金额',
  lastContent:'最后内容', updateTime:'更新时间', createTime:'创建时间', remark:'备注',
  address:'地址', email:'邮箱'
};
var COLUMNS = [
  { key:'leadsName', label:'线索名称', sortable:true },
  { key:'mobile', label:'手机号', sortable:true },
  { key:'telephone', label:'电话', sortable:true },
  { key:'ownerUserName', label:'负责人', sortable:true },
  { key:'ownerDeptName', label:'部门', sortable:true },
  { key:'source', label:'来源', sortable:true },
  { key:'assignedPool', label:'线索池', sortable:true },
  { key:'fieldGjmfug', label:'类别', sortable:true },
  { key:'fieldXzhmxa', label:'渠道', sortable:true },
  { key:'fieldJbdcox', label:'获客方式', sortable:true },
  { key:'fieldKqjpds', label:'线索金额', sortable:true },
  { key:'createUserName', label:'创建人', sortable:true },
  { key:'createTime', label:'创建时间', sortable:true },
  { key:'updateTime', label:'更新时间', sortable:true },
  { key:'status', label:'状态', sortable:true },
  { key:'level', label:'等级', sortable:false },
  { key:'address', label:'地址', sortable:false },
  { key:'email', label:'邮箱', sortable:false },
  { key:'remark', label:'备注', sortable:false },
];

function loadCachedLeads() {
  try {
    var c = localStorage.getItem('wujiLeads');
    if (c) { var d = JSON.parse(c); if (d && d.list && d.list.length>0) { allLeads=d.list; updateSourcesFilter(); filterLeads(); } }
  } catch(e) {}
}

function saveCachedLeads() {
  try { localStorage.setItem('wujiLeads', JSON.stringify({list:allLeads,time:new Date().toISOString()})); } catch(e) {}
}

function renderLeadsHeaders() {
  var h = '<th style="width:30px">#</th><th style="width:44px">跟进</th>';
  COLUMNS.forEach(function(c) {
    var s = leadsSortField === c.key;
    h += '<th class="'+(s?'sorted':'')+'" onclick="'+(c.sortable?"sortLeadsBy('"+c.key+"')":'')+'" style="'+(c.sortable?'':'cursor:default')+'">'
      + c.label + (c.sortable ? '<span class="sort">'+(s?(leadsSortDir>0?'\u25B2':'\u25BC'):'\u21C5')+'</span>' : '') + '</th>';
  });
  document.getElementById('leadsHead').innerHTML = h;
}

function renderLeadsBody() {
  var tbody = document.getElementById('leadsBody');
  if (!filteredLeads || filteredLeads.length === 0) {
    tbody.innerHTML = '<tr><td colspan="'+(COLUMNS.length+1)+'"><div class="empty-state"><p>暂无线索数据</p></div></td></tr>';
    return;
  }
  var start = (leadsPage - 1) * LEADS_PAGE_SIZE;
  var pageLeads = filteredLeads.slice(start, start + LEADS_PAGE_SIZE);
  tbody.innerHTML = pageLeads.map(function(lead, i) {
    var idx = start + i + 1;
    var sh = lead.status === 1 ? '<span class="tag answered">正常</span>'
      : lead.status === 2 ? '<span class="tag new">已转化</span>'
      : lead.status === 3 ? '<span class="tag failed">已关闭</span>'
      : '<span class="tag">'+lead.status+'</span>';
    var hasFollowUp = lead.lastContent || lead.lastCallTime;
    return '<tr data-id="'+lead.leadsId+'" data-name="'+esc(lead.leadsName||'')+'"><td style="color:var(--text2);font-size:11px">'+idx+'</td>'
      + '<td style="text-align:center"><button class="btn small '+(hasFollowUp?'green':'')+'" onclick="openRecord(\''+lead.leadsId+'\',\''+esc(lead.leadsName||'')+'\')">'+(hasFollowUp?'跟进':'写跟进')+'</button></td>'
      + COLUMNS.map(function(c) {
        var v = lead[c.key];
        if (v === undefined || v === null) v = '';
        if (c.key === 'status') return '<td>'+sh+'</td>';
        if (v === '' || v === 0) return '<td style="color:#ccc">-</td>';
        if (c.key === 'mobile' || c.key === 'telephone') return '<td><a href="tel:'+v+'" style="color:var(--primary);text-decoration:none">'+esc(v)+'</a></td>';
        return '<td title="'+esc(v)+'">'+esc(v)+'</td>';
      }).join('') + '</tr>';
  }).join('');
  updateLeadsPagination(filteredLeads.length);
}

function updateLeadsPagination(total) {
  document.getElementById('leadsCount').textContent = '显示 '+filteredLeads.length+' 条，共 '+total+' 条';
  var tp = Math.ceil(total / LEADS_PAGE_SIZE) || 1;
  var h = '<button class="page-btn" onclick="goLeadsPage(1)" '+(leadsPage<=1?'disabled':'')+'>&laquo;</button>';
  h += '<button class="page-btn" onclick="goLeadsPage('+(leadsPage-1)+')" '+(leadsPage<=1?'disabled':'')+'>&lsaquo;</button>';
  var sp = Math.max(1, leadsPage-2), ep = Math.min(tp, leadsPage+2);
  if (ep-sp < 4) { if (sp===1) ep=Math.min(tp,sp+4); else sp=Math.max(1,ep-4); }
  for (var p=sp;p<=ep;p++) h += '<button class="page-btn'+(p===leadsPage?' active':'')+'" onclick="goLeadsPage('+p+')">'+p+'</button>';
  h += '<button class="page-btn" onclick="goLeadsPage('+(leadsPage+1)+')" '+(leadsPage>=tp?'disabled':'')+'>&rsaquo;</button>';
  h += '<button class="page-btn" onclick="goLeadsPage('+tp+')" '+(leadsPage>=tp?'disabled':'')+'>&raquo;</button>';
  document.getElementById('leadsPagination').innerHTML = h;
}

function goLeadsPage(p) { leadsPage = p; renderLeadsBody(); }

function sortLeadsBy(field) {
  if (leadsSortField === field) leadsSortDir = -leadsSortDir;
  else { leadsSortField = field; leadsSortDir = -1; }
  renderLeadsHeaders(); sortLeadsData(); renderLeadsBody();
}

function sortLeadsData() {
  filteredLeads.sort(function(a, b) {
    var va = a[leadsSortField] || '', vb = b[leadsSortField] || '';
    if (leadsSortField === 'createTime' || leadsSortField === 'updateTime') return leadsSortDir * (new Date(va) - new Date(vb));
    if (leadsSortField === 'fieldKqjpds') return leadsSortDir * ((parseFloat(va)||0) - (parseFloat(vb)||0));
    return leadsSortDir * String(va).localeCompare(String(vb), 'zh-CN');
  });
}

function filterLeads() {
  var search = document.getElementById('leadsSearch').value.toLowerCase().trim();
  var owner = document.getElementById('leadsOwner').value.toLowerCase().trim();
  var source = document.getElementById('leadsSource').value;
  var status = document.getElementById('leadsStatus').value;
  filteredLeads = allLeads.filter(function(l) {
    if (search && !(l.leadsName||'').toLowerCase().includes(search) && !(l.mobile||'').includes(search) && !(l.telephone||'').includes(search)) return false;
    if (owner && !(l.ownerUserName||'').toLowerCase().includes(owner)) return false;
    if (source && (l.source||'') !== source) return false;
    if (status && String(l.status||'') !== status) return false;
    return true;
  });
  leadsPage = 1; sortLeadsData(); renderLeadsBody();
}

function updateSourcesFilter() {
  var s = new Set();
  allLeads.forEach(function(l) { if (l.source) s.add(l.source); });
  var sel = document.getElementById('leadsSource');
  var cv = sel.value;
  sel.innerHTML = '<option value="">全部来源</option>';
  Array.from(s).sort().forEach(function(v) { sel.innerHTML += '<option value="'+esc(v)+'">'+esc(v)+'</option>'; });
  sel.value = cv;
}

function showWujiSyncInfo(info, time) {
  var el = document.getElementById('wujiSyncInfo');
  if (!time) { el.textContent = '--'; return; }
  var t = fmtTime(time);
  if (!info) { el.innerHTML = t+' - 同步完成'; return; }
  var parts = [];
  if (info.added > 0) parts.push('<span class="new">+'+info.added+' 新增</span>');
  if (info.updated > 0) parts.push('<span class="updated">~'+info.updated+' 更新</span>');
  if (info.added === 0 && info.updated === 0) parts.push('<span class="same">无更新</span>');
  el.innerHTML = t+' - 共 <span class="total">'+info.total+'</span> 条 ' + parts.join(' ');
}

function showWujiError(msg) {
  var el = document.getElementById('wujiError');
  if (msg) { el.style.display='inline'; el.textContent=msg; } else el.style.display='none';
}

async function manualSyncLeads() {
  var btn = document.querySelector('#tabLeads .btn.primary');
  btn.disabled = true; btn.textContent = '同步中...';
  document.getElementById('wujiSyncInfo').textContent = '正在同步...';
  try {
    var r = await fetch('/api/wuji/leads');
    var d = await r.json();
    if (d.success && d.data) { allLeads = d.data.list || []; saveCachedLeads(); updateSourcesFilter(); filterLeads(); }
    if (d.syncInfo) showWujiSyncInfo(d.syncInfo.info, d.syncInfo.time);
    if (d.error) showWujiError(d.error); else showWujiError(null);
  } catch(e) { showWujiError(e.message); }
  btn.disabled = false; btn.textContent = '同步';
}

async function changeWujiInterval() {
  var ms = parseInt(document.getElementById('wujiInterval').value);
  try {
    await fetch('/api/wuji/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({pollIntervalMs:ms}) });
  } catch(e) {}
}

// ===================================================================
// Wuji CRM: Follow-up Records
// ===================================================================
async function openRecord(leadsId, leadsName) {
  var modal = document.getElementById('recordModal');
  var body = document.getElementById('recordBody');
  document.getElementById('recordLeadName').textContent = leadsName;
  document.getElementById('recordLeadName').dataset.leadsid = leadsId;
  modal.classList.add('open');
  body.innerHTML = '<div class="empty-state">加载中...</div>';
  try {
    var r = await fetch('/api/wuji/record/'+leadsId);
    var d = await r.json();
    var list = d.activityRecords && d.activityRecords.data ? d.activityRecords.data.list : [];
    if (list.length === 0) { body.innerHTML = '<div class="empty-state">暂无跟进记录</div>'; return; }
    var typeLabels = {1:'跟进',2:'电话',3:'会议',4:'邮件',5:'短信'};
    var h = '';
    list.forEach(function(item) {
      var tl = typeLabels[item.type] || ('类型'+item.type);
      var cr = item.createUser ? item.createUser.realname : '未知';
      h += '<div class="record-item"><div class="record-header"><span class="record-type">'+tl+'</span><span>'+(item.createTime||'')+'</span></div><div class="record-content">'+esc(item.content||'')+'</div><div class="record-meta" style="font-size:11px;color:var(--text2)"><span>'+esc(cr)+'</span></div></div>';
    });
    body.innerHTML = h;
  } catch(e) { body.innerHTML = '<div class="empty-state">加载失败</div>'; }
}

async function submitRecord() {
  var leadsId = document.getElementById('recordLeadName').dataset.leadsid;
  var content = document.getElementById('recordInput').value.trim();
  if (!content || !leadsId) return;
  var btn = document.querySelector('#recordModal .btn.primary');
  btn.disabled = true; btn.textContent = '提交中...';
  try {
    var r = await fetch('/api/wuji/record/add', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({leadsId:leadsId, content:content}) });
    var d = await r.json();
    if (d.success) { document.getElementById('recordInput').value = ''; openRecord(leadsId, document.getElementById('recordLeadName').textContent); }
    else { alert('提交失败: '+(d.error||'未知错误')); }
  } catch(e) { alert('网络错误'); }
  btn.disabled = false; btn.textContent = '提交跟进';
}

// ===================================================================
// VoiceFox: Login
// ===================================================================
async function doVoicefoxLogin() {
  var email = document.getElementById('vfEmail').value.trim();
  var password = document.getElementById('vfPassword').value.trim();
  if (!email || !password) { document.getElementById('vfLoginStatus').textContent = '请填写邮箱和密码'; return; }
  document.getElementById('vfLoginStatus').textContent = '登录中...';
  try {
    var r = await fetch('/api/voicefox/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email:email,password:password}) });
    var d = await r.json();
    if (d.success) {
      document.getElementById('vfLoginStatus').textContent = d.user ? (d.user.displayName||d.user.email) : '登录成功';
      document.getElementById('vfEmail').value = ''; document.getElementById('vfPassword').value = '';
      refreshStatus();
    } else {
      document.getElementById('vfLoginStatus').textContent = d.error || '登录失败';
    }
  } catch(e) { document.getElementById('vfLoginStatus').textContent = '网络错误'; }
}

// ===================================================================
// VoiceFox: Calls
// ===================================================================
var CALLS_COLUMNS = [
  { key:'callee', label:'被叫号码', sortable:true },
  { key:'taskName', label:'任务名称', sortable:true },
  { key:'startAt', label:'开始时间', sortable:true },
  { key:'duration', label:'时长', sortable:true },
  { key:'hangupReason', label:'状态', sortable:true },
  { key:'actions', label:'操作', sortable:false },
];

function renderCallsHeaders() {
  var h = '<th style="width:30px">#</th>';
  CALLS_COLUMNS.forEach(function(c) {
    if (c.key === 'actions') { h += '<th style="cursor:default">'+c.label+'</th>'; return; }
    var s = callsSortField === c.key;
    h += '<th class="'+(s?'sorted':'')+'" onclick="sortCallsBy(\''+c.key+'\')">'
      + c.label + '<span class="sort">'+(s?(callsSortDir>0?'\u25B2':'\u25BC'):'\u21C5')+'</span></th>';
  });
  document.getElementById('callsHead').innerHTML = h;
}

function renderCallsBody() {
  var tbody = document.getElementById('callsBody');
  if (!filteredCalls || filteredCalls.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><p>暂无通话记录</p></div></td></tr>';
    return;
  }
  var start = (callsPage - 1) * CALLS_PAGE_SIZE;
  var pageCalls = filteredCalls.slice(start, start + CALLS_PAGE_SIZE);
  tbody.innerHTML = pageCalls.map(function(call, i) {
    var idx = start + i + 1;
    var statusClass = call.hangupReason === 'answered' ? 'answered' : call.hangupReason === 'no_answer' ? 'no_answer' : call.hangupReason === 'busy' ? 'busy' : 'failed';
    var statusLabel = call.hangupReason === 'answered' ? '已接通' : call.hangupReason === 'no_answer' ? '无人接听' : call.hangupReason === 'busy' ? '占线' : call.hangupReason === 'failed' ? '失败' : call.hangupReason || '--';
    var taskName = (call.task && call.task.name) || '';
    var hasSummary = call.task && (call.task.summary || call.task.suggestion);
    return '<tr><td style="color:var(--text2);font-size:11px">'+idx+'</td>'
      + '<td><a href="tel:'+esc(call.callee||'')+'" style="color:var(--primary);text-decoration:none">'+esc(call.callee||'')+'</a>'+((call.calleeAttribute)?'<br><span style="font-size:10px;color:var(--text2)">'+esc(call.calleeAttribute)+'</span>':'')+'</td>'
      + '<td>'+(taskName ? esc(taskName) : '<span style="color:#ccc">-</span>')+'</td>'
      + '<td>'+fmtTime(call.startAt)+'</td>'
      + '<td>'+(call.duration?fmtDur(call.duration):'--')+'</td>'
      + '<td><span class="tag '+statusClass+'">'+statusLabel+'</span>'+ (hasSummary?'<br><span style="font-size:10px;color:var(--green)">有摘要</span>':'') +'</td>'
      + '<td><button class="btn small" onclick="showCallDetail('+call.id+')">详情</button></td></tr>';
  }).join('');
  updateCallsPagination(filteredCalls.length);
}

function updateCallsPagination(total) {
  document.getElementById('callsCount').textContent = '显示 '+filteredCalls.length+' 条，共 '+total+' 条';
  var tp = Math.ceil(total / CALLS_PAGE_SIZE) || 1;
  var h = '<button class="page-btn" onclick="goCallsPage(1)" '+(callsPage<=1?'disabled':'')+'>&laquo;</button>';
  h += '<button class="page-btn" onclick="goCallsPage('+(callsPage-1)+')" '+(callsPage<=1?'disabled':'')+'>&lsaquo;</button>';
  var sp = Math.max(1, callsPage-2), ep = Math.min(tp, callsPage+2);
  if (ep-sp < 4) { if (sp===1) ep=Math.min(tp,sp+4); else sp=Math.max(1,ep-4); }
  for (var p=sp;p<=ep;p++) h += '<button class="page-btn'+(p===callsPage?' active':'')+'" onclick="goCallsPage('+p+')">'+p+'</button>';
  h += '<button class="page-btn" onclick="goCallsPage('+(callsPage+1)+')" '+(callsPage>=tp?'disabled':'')+'>&rsaquo;</button>';
  h += '<button class="page-btn" onclick="goCallsPage('+tp+')" '+(callsPage>=tp?'disabled':'')+'>&raquo;</button>';
  document.getElementById('callsPagination').innerHTML = h;
}

function goCallsPage(p) { callsPage = p; renderCallsBody(); }

function sortCallsBy(field) {
  if (callsSortField === field) callsSortDir = -callsSortDir;
  else { callsSortField = field; callsSortDir = -1; }
  renderCallsHeaders(); sortCallsData(); renderCallsBody();
}

function sortCallsData() {
  filteredCalls.sort(function(a, b) {
    var va, vb;
    if (callsSortField === 'taskName') { va = (a.task&&a.task.name)||''; vb = (b.task&&b.task.name)||''; }
    else { va = a[callsSortField]||''; vb = b[callsSortField]||''; }
    if (callsSortField === 'startAt' || callsSortField === 'answerAt' || callsSortField === 'endAt') return callsSortDir * (new Date(va) - new Date(vb));
    if (callsSortField === 'duration' || callsSortField === 'billsec') return callsSortDir * ((parseFloat(va)||0) - (parseFloat(vb)||0));
    return callsSortDir * String(va).localeCompare(String(vb), 'zh-CN');
  });
}

function filterCalls() {
  var search = document.getElementById('callsSearch').value.toLowerCase().trim();
  var status = document.getElementById('callsStatus').value;
  filteredCalls = allCalls.filter(function(c) {
    if (search) {
      if (!(c.callee||'').includes(search) && !((c.task&&c.task.name)||'').toLowerCase().includes(search) && !(c.taskId||'').toString().includes(search)) return false;
    }
    if (status && (c.hangupReason||'') !== status) return false;
    return true;
  });
  callsPage = 1; sortCallsData(); renderCallsBody();
}

function showVfSyncInfo(info, time) {
  var el = document.getElementById('vfSyncInfo');
  if (!time) { el.textContent = '--'; return; }
  var t = fmtTime(time);
  if (!info) { el.innerHTML = t+' - 同步完成'; return; }
  var parts = [];
  if (info.answered > 0) parts.push('<span class="new">'+info.answered+' 接通</span>');
  if (info.noAnswer > 0) parts.push('<span class="updated">'+info.noAnswer+' 未接</span>');
  if (info.busy > 0) parts.push('<span class="updated">'+info.busy+' 占线</span>');
  if (info.failed > 0) parts.push('<span style="color:var(--red);font-weight:600">'+info.failed+' 失败</span>');
  if (parts.length === 0) parts.push('<span class="same">无更新</span>');
  el.innerHTML = t+' - 共 <span class="total">'+info.total+'</span> 通 ' + parts.join(' ');
}

function showVfError(msg) {
  var el = document.getElementById('vfError');
  if (msg) { el.style.display='inline'; el.textContent=msg; } else el.style.display='none';
}

async function manualSyncCalls() {
  var btn = document.getElementById('syncCallsBtn');
  btn.disabled = true; btn.textContent = '同步中...';
  try {
    var r = await fetch('/api/voicefox/sync');
    var d = await r.json();
    if (d.success) { await fetchAllCalls(); if (d.data) showVfSyncInfo(d.data, new Date().toISOString()); }
    if (d.error) showVfError(d.error); else showVfError(null);
  } catch(e) { showVfError(e.message); }
  btn.disabled = false; btn.textContent = '同步';
}

async function fetchAllCalls() {
  try {
    var r = await fetch('/api/voicefox/calls/cached/all');
    var d = await r.json();
    if (d.success && d.data) {
      allCalls = d.data.list || [];
      filterCalls();
      saveCachedCalls();
      updateCallStats();
    }
  } catch(e) {}
}

function saveCachedCalls() {
  try { localStorage.setItem('voicefoxCalls', JSON.stringify({list:allCalls, time:new Date().toISOString()})); } catch(e) {}
}

function loadCachedCalls() {
  try {
    var raw = localStorage.getItem('voicefoxCalls');
    if (raw) { var d = JSON.parse(raw); if (d && d.list && d.list.length > 0) { allCalls = d.list; filterCalls(); } }
  } catch(e) {}
}

async function changeVfInterval() {
  var ms = parseInt(document.getElementById('vfInterval').value);
  try {
    await fetch('/api/voicefox/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({pollIntervalMs:ms}) });
  } catch(e) {}
}

// ===================================================================
// VoiceFox: Call Detail
// ===================================================================
async function showCallDetail(recordId) {
  var modal = document.getElementById('detailModal');
  var body = document.getElementById('detailBody');
  document.getElementById('detailTitle').textContent = '通话详情 #'+recordId;
  modal.classList.add('open');
  body.innerHTML = '<div class="empty-state">加载中...</div>';
  try {
    var [detailR, transcriptR, summaryR] = await Promise.all([
      fetch('/api/voicefox/calls/'+recordId),
      fetch('/api/voicefox/calls/'+recordId+'/transcript'),
      fetch('/api/voicefox/calls/'+recordId+'/summary'),
    ]);
    var detail = await detailR.json();
    var transcript = await transcriptR.json();
    var summary = await summaryR.json();
    var d = detail.data || {};
    var html = '';

    // Basic info
    html += '<div class="detail-section"><h3>基本信息</h3><div class="detail-grid">';
    html += '<div class="field-row"><span class="field-label">被叫</span><span class="field-value">'+esc(d.callee||'')+'</span></div>';
    html += '<div class="field-row"><span class="field-label">归属地</span><span class="field-value">'+esc(d.calleeAttribute||'')+'</span></div>';
    html += '<div class="field-row"><span class="field-label">主叫线路</span><span class="field-value">'+esc(d.caller||'')+'</span></div>';
    html += '<div class="field-row"><span class="field-label">状态</span><span class="field-value"><span class="tag '+(d.hangupReason==='answered'?'answered':d.hangupReason==='no_answer'?'no_answer':d.hangupReason==='busy'?'busy':'failed')+'">'+esc(d.hangupReason||'')+'</span></span></div>';
    html += '<div class="field-row"><span class="field-label">挂断方</span><span class="field-value">'+(d.hangupSide==='caller'?'主叫挂断':d.hangupSide==='callee'?'被叫挂断':esc(d.hangupSide||'-'))+'</span></div>';
    html += '<div class="field-row"><span class="field-label">时长</span><span class="field-value">'+fmtDur(d.duration)+' (计费 '+fmtDur(d.billsec)+')</span></div>';
    html += '<div class="field-row"><span class="field-label">开始</span><span class="field-value">'+fmtTime(d.startAt)+'</span></div>';
    if (d.answerAt) html += '<div class="field-row"><span class="field-label">接通</span><span class="field-value">'+fmtTime(d.answerAt)+'</span></div>';
    html += '<div class="field-row"><span class="field-label">任务</span><span class="field-value">'+esc((d.task&&d.task.name)||'')+'</span></div>';
    html += '<div class="field-row"><span class="field-label">任务ID</span><span class="field-value">'+(d.taskId||'')+'</span></div>';
    html += '</div></div>';

    // Recording
    var recordUrl = d.recordFile || d.rawRecordFile || '';
    html += '<div class="detail-section"><h3>录音文件</h3>';
    if (recordUrl) html += '<button class="btn green small" onclick="downloadRecording('+recordId+')">下载录音 (WAV)</button> <span id="dlStatus_'+recordId+'" style="font-size:11px;color:var(--text2)"></span>';
    else html += '<div style="color:var(--text2);font-size:12px">无录音文件</div>';
    html += '</div>';

    // Collect data
    var collect = d.collect;
    if (collect && collect.length > 0 && collect[0].items) {
      var items = collect[0].items;
      var hasData = false;
      for (var i=0;i<items.length;i++) { if (items[i].answer) { hasData=true; break; } }
      if (hasData) {
        html += '<div class="detail-section"><h3>AI 采集数据</h3><div class="collect-items">';
        for (var i=0;i<items.length;i++) { if (items[i].answer) html += '<div class="collect-item"><span class="q">'+esc(items[i].question)+'：</span><span class="a">'+esc(items[i].answer)+'</span></div>'; }
        html += '</div></div>';
      }
    }

    // AI Summary
    if (summary.data) {
      var s = summary.data;
      if (s.summary || s.suggestion) {
        html += '<div class="detail-section"><h3>AI 摘要</h3><div class="summary-box">';
        if (s.summary) html += '<div>'+esc(s.summary)+'</div>';
        if (s.suggestion) html += '<div style="margin-top:4px"><strong>建议：</strong>'+esc(s.suggestion)+'</div>';
        html += '</div></div>';
      }
    }

    // Transcript
    if (transcript.success && transcript.data && transcript.data.length > 0) {
      html += '<div class="detail-section"><h3>对话记录 ('+transcript.data.length+' 条)</h3><div>';
      transcript.data.forEach(function(item) {
        var cls = item.speaker === 'AI' ? 'ai' : item.speaker === '客户' ? 'client' : 'system';
        html += '<div class="transcript-item '+cls+'"><span class="time">'+item.time+'s</span><div class="speaker">'+esc(item.speaker)+'</div><div>'+esc(item.content)+'</div></div>';
      });
      html += '</div></div>';
    }

    body.innerHTML = html || '<div class="empty-state">无法加载详情</div>';
  } catch(e) { body.innerHTML = '<div class="empty-state">加载失败: '+e.message+'</div>'; }
}

async function downloadRecording(recordId) {
  var el = document.getElementById('dlStatus_'+recordId);
  if (el) el.textContent = '下载中...';
  try {
    var a = document.createElement('a');
    a.href = '/api/voicefox/calls/'+recordId+'/download';
    a.download = 'call_'+recordId+'.wav'; a.click();
    if (el) el.textContent = '已开始下载';
  } catch(e) { if (el) el.textContent = '下载失败'; }
}

// ===================================================================
// VoiceFox: Call Stats
// ===================================================================
function updateCallStats() {
  var total = allCalls.length;
  var answered = allCalls.filter(function(c){return c.hangupReason==='answered';}).length;
  var noAnswer = allCalls.filter(function(c){return c.hangupReason==='no_answer'||c.hangupReason==='timeout';}).length;
  var busy = allCalls.filter(function(c){return c.hangupReason==='busy';}).length;
  var failed = allCalls.filter(function(c){return c.hangupReason==='failed'||c.hangupReason==='cancel';}).length;
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statAnswered').textContent = answered;
  document.getElementById('statNoAnswer').textContent = noAnswer;
  document.getElementById('statBusy').textContent = busy;
  document.getElementById('statFailed').textContent = failed;
}

// ===================================================================
// VoiceFox: Task Management
// ===================================================================
async function loadTaskList() {
  var tbody = document.getElementById('tasksBody');
  tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state">加载中...</div></td></tr>';
  try {
    var r = await fetch('/api/voicefox/tasks/filter', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    var d = await r.json();
    if (d.success && d.data) {
      allTasks = d.data.items || d.data.list || d.data || [];
      var nameFilter = document.getElementById('taskSearchName').value.toLowerCase().trim();
      var filtered = allTasks.filter(function(t) { if (nameFilter && !(t.name||'').toLowerCase().includes(nameFilter)) return false; return true; });
      if (filtered.length === 0) { tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state">暂无任务</div></td></tr>'; return; }
      tbody.innerHTML = filtered.map(function(task) {
        var statusLabel = task.status === 'completed'||task.status==='done' ? '已完成' : task.status==='running' ? '进行中' : task.status==='pending' ? '待开始' : task.status==='paused' ? '已暂停' : task.status||'--';
        var statusCls = (task.status==='completed'||task.status==='done') ? 'answered' : task.status==='running' ? 'no_answer' : 'pending';
        return '<tr><td>'+esc(task.name||'')+'</td><td>'+task.id+'</td><td><span class="tag '+statusCls+'">'+statusLabel+'</span></td><td>'+(task.total||0)+'</td><td>'+fmtTime(task.createTime||task.createdAt)+'</td><td><button class="btn small" onclick="showTaskDetail('+task.id+')">详情</button></td></tr>';
      }).join('');
    } else { tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state">暂无任务</div></td></tr>'; }
  } catch(e) { tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state">加载失败: '+e.message+'</div></td></tr>'; }
}

async function showTaskDetail(taskId) {
  var modal = document.getElementById('detailModal');
  var body = document.getElementById('detailBody');
  document.getElementById('detailTitle').textContent = '任务详情 #'+taskId;
  modal.classList.add('open');
  body.innerHTML = '<div class="empty-state">加载中...</div>';
  try {
    var [taskR, statR] = await Promise.all([
      fetch('/api/voicefox/task/'+taskId),
      fetch('/api/voicefox/task/'+taskId+'/statistics'),
    ]);
    var task = await taskR.json();
    var stat = await statR.json();
    var t = task.data || {}; var s = stat.data || {};
    var html = '<div class="detail-section"><h3>任务信息</h3><div class="detail-grid">';
    html += '<div class="field-row"><span class="field-label">名称</span><span class="field-value">'+esc(t.name||'')+'</span></div>';
    html += '<div class="field-row"><span class="field-label">ID</span><span class="field-value">'+(t.id||'')+'</span></div>';
    html += '<div class="field-row"><span class="field-label">状态</span><span class="field-value">'+esc(t.status||'')+'</span></div>';
    html += '</div></div><div class="detail-section"><h3>统计数据</h3><div class="detail-grid">';
    html += '<div class="field-row"><span class="field-label">号码总数</span><span class="field-value">'+(s.totalNum||0)+'</span></div>';
    html += '<div class="field-row"><span class="field-label">待呼叫</span><span class="field-value">'+(s.pendingNum||0)+'</span></div>';
    html += '<div class="field-row"><span class="field-label">呼叫中</span><span class="field-value">'+(s.callingNum||0)+'</span></div>';
    html += '<div class="field-row"><span class="field-label">已呼叫</span><span class="field-value">'+(s.calledNum||0)+'</span></div>';
    html += '<div class="field-row"><span class="field-label">已接通</span><span class="field-value" style="color:var(--green);font-weight:600">'+(s.calledAnsweredNum||0)+'</span></div>';
    html += '<div class="field-row"><span class="field-label">未接通</span><span class="field-value" style="color:var(--orange)">'+(s.calledUnAnsweredNum||0)+'</span></div>';
    html += '</div></div>';
    body.innerHTML = html;
  } catch(e) { body.innerHTML = '<div class="empty-state">加载失败: '+e.message+'</div>'; }
}

async function createTask() {
  var phone = document.getElementById('createPhone').value.trim();
  var name = document.getElementById('createName').value.trim();
  var vid = parseInt(document.getElementById('createVid').value) || 42558;
  if (!phone) { document.getElementById('createResult').innerHTML = '<span style="color:var(--red)">请填写手机号</span>'; return; }
  document.getElementById('createResult').innerHTML = '正在创建任务...';
  try {
    var r = await fetch('/api/voicefox/task/create', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone:phone, name:name||undefined, assistantVid:vid}) });
    var d = await r.json();
    if (d.success) {
      document.getElementById('createResult').innerHTML = '<span style="color:var(--green)">任务创建成功，ID: '+d.data.id+', 名称: '+esc(d.data.name)+'</span>';
      document.getElementById('createPhone').value = ''; document.getElementById('createName').value = '';
      loadTaskList(); manualSyncCalls();
    } else { document.getElementById('createResult').innerHTML = '<span style="color:var(--red)">创建失败: '+esc(d.error||'')+'</span>'; }
  } catch(e) { document.getElementById('createResult').innerHTML = '<span style="color:var(--red)">网络错误: '+e.message+'</span>'; }
}

// ===================================================================
// VoiceFox: Sync Log
// ===================================================================
async function showCallLog() {
  var modal = document.getElementById('logModal');
  var body = document.getElementById('logBody');
  modal.classList.add('open');
  body.innerHTML = '<div class="empty-state">加载中...</div>';
  try {
    var r = await fetch('/api/voicefox/updatelog');
    var d = await r.json();
    if (!d.success || !d.log || d.log.length===0) { body.innerHTML = '<div class="empty-state">暂无同步记录</div>'; return; }
    var html = '';
    d.log.slice().reverse().forEach(function(entry) {
      var time = fmtTime(entry.time);
      var summary = '共 '+entry.total+' 通';
      if (entry.answered > 0) summary += ' | '+entry.answered+' 接通';
      if (entry.noAnswer > 0) summary += ' | '+entry.noAnswer+' 未接';
      if (entry.busy > 0) summary += ' | '+entry.busy+' 占线';
      if (entry.failed > 0) summary += ' | '+entry.failed+' 失败';
      if (entry.answered===0 && entry.noAnswer===0 && entry.busy===0 && entry.failed===0) summary += ' | 无变化';
      html += '<div class="log-entry"><div class="log-time">'+time+'</div><div class="log-summary">'+summary+'</div></div>';
    });
    body.innerHTML = html;
  } catch(e) { body.innerHTML = '<div class="empty-state">加载失败: '+e.message+'</div>'; }
}

// ===================================================================
// Pipeline
// ===================================================================
function updatePipelineUI(p) {
  if (!p) return;
  document.getElementById('pipePending').textContent = p.queue ? p.queue.pending : 0;
  document.getElementById('pipeCalling').textContent = p.queue ? p.queue.calling : 0;
  document.getElementById('pipeCompleted').textContent = p.queue ? p.queue.completed : 0;
  document.getElementById('pipeUnreachable').textContent = p.queue ? p.queue.failed : 0;
  document.getElementById('pipeTotal').textContent = p.stats ? p.stats.totalEnqueued : 0;

  var label = document.getElementById('pipelineToggleLabel');
  var btn = document.getElementById('pipelineToggleBtn');
  if (p.enabled) {
    label.textContent = '\u6b63\u5728\u62e8\u6253'; label.style.color = 'var(--green)';
    btn.textContent = '\u6682\u505c'; btn.className = 'btn small';
  } else {
    label.textContent = '\u5df2\u505c\u6b62'; label.style.color = 'var(--text2)';
    btn.textContent = '\u5f00\u59cb\u62e8\u6253'; btn.className = 'btn small green';
  }

  // Active call
  var activeEl = document.getElementById('activeCallInfo');
  if (p.activeCall) {
    activeEl.textContent = '\u6b63\u5728\u62e8\u6253: ' + p.activeCall.phone;
  } else {
    activeEl.textContent = '';
  }

  // Source filter
  var sf = document.getElementById('sourceFilter');
  if (sf && p.sourceFilter) sf.value = p.sourceFilter;

  // Queue table
  var tbody = document.getElementById('queueBody');
  if (p.queue && p.queue.items && p.queue.items.length > 0) {
    var h = '';
    p.queue.items.forEach(function(item, i) {
      if (item.status === 'completed' || item.status === 'failed') return; // skip history items in table
      var statusLabel, statusCls;
      switch (item.status) {
        case 'pending': statusLabel = '\u5f85\u62e8\u6253'; statusCls = 'pending'; break;
        case 'calling': statusLabel = '\u62e8\u6253\u4e2d'; statusCls = 'no_answer'; break;
        default: statusLabel = item.status; statusCls = 'pending';
      }
      var sourceLabel = item.source || '--';
      var callBtn = '<button class="btn small green" onclick="manualCall(\'' + item.leadsId + '\')">拨打</button>';
var holdBtn = item.status === 'pending' ? '<button class="btn small" onclick="moveToHold(\'' + item.leadsId + '\')">搁置</button>' : '';
      h += '<tr><td>' + (i + 1) + '</td>'
        + '<td>' + esc(item.leadsName) + '</td>'
        + '<td>' + esc(item.phone) + '</td>'
        + '<td>' + sourceLabel + '</td>'
        + '<td>' + fmtTime(item.createTime) + '</td>'
        + '<td><span class="tag ' + statusCls + '">' + statusLabel + '</span></td>'
        + '<td>' + (item.attemptCount || 0) + '</td>'
        + '<td>' + callBtn + ' ' + holdBtn + '</td></tr>';
    });
    if (!h) h = '<tr><td colspan="8"><div class="empty-state">\u6682\u65e0\u5f85\u62e8\u6253\u7ebf\u7d22</div></td></tr>';
    tbody.innerHTML = h;
  } else {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">\u6682\u65e0\u961f\u5217\u6570\u636e</div></td></tr>';
  }

  // Hold area table
  var holdBody = document.getElementById('holdBody');
  var holdCount = document.getElementById('holdCount');
  if (p.holdArea && p.holdArea.length > 0) {
    holdCount.textContent = '(' + p.holdArea.length + ' \u6761)';
    var hh = '';
    p.holdArea.forEach(function(item, i) {
      var sourceLabel = item.source || '--';
      hh += '<tr><td>' + (i + 1) + '</td>'
        + '<td>' + esc(item.leadsName) + '</td>'
        + '<td>' + esc(item.phone) + '</td>'
        + '<td>' + sourceLabel + '</td>'
        + '<td>' + fmtTime(item.createTime) + '</td>'
        + '<td>' + fmtTime(item.movedAt) + '</td>'
+ '<td><button class="btn small green" onclick="moveBackToQueue(\'' + item.leadsId + '\')">\u79fb\u56de\u961f\u5217</button> <button class="btn small green" onclick="manualCall(\'' + item.leadsId + '\')">拨打</button></td></tr>';
    });
    holdBody.innerHTML = hh;
  } else {
    holdCount.textContent = '(0 \u6761)';
    holdBody.innerHTML = '<tr><td colspan="7"><div class="empty-state">\u6682\u65e0\u5f85\u786e\u8ba4\u7ebf\u7d22</div></td></tr>';
  }

  // Log
  var logEl = document.getElementById('pipelineLog');
  if (p.recentLog && p.recentLog.length > 0) {
    var h = '';
    p.recentLog.forEach(function(entry) {
      var icon = entry.status === 'completed' ? '\u2705' : entry.status === 'unreachable' ? '\u274c' : entry.status === 'retrying' ? '\u23f3' : entry.status === 'enqueued' ? '\u2795' : entry.status === 'calling' ? '\u260e\ufe0f' : '\u2139\ufe0f';
      h += '<div class="log-entry"><div class="log-time">' + fmtTime(entry.time) + ' ' + icon + '</div>'
        + '<div class="log-summary">' + esc(entry.leadsName || entry.phone) + ' - ' + esc(entry.message) + '</div></div>';
    });
    logEl.innerHTML = h;
  } else {
    logEl.innerHTML = '<div class="empty-state">\u6682\u65e0\u8054\u52a8\u8bb0\u5f55</div>';
  }
}

async function refreshPipeline() {
  try {
    var r = await fetch('/api/pipeline/status');
    var d = await r.json();
    if (d.success) updatePipelineUI(d);
  } catch(e) {}
}

async function manualCall(leadsId) {
  try {
    var r = await fetch('/api/pipeline/call-manual/' + leadsId, { method:'POST' });
    var d = await r.json();
    if (d.success) refreshPipeline();
  } catch(e) {}
}

async function moveToHold(leadsId) {
  try {
    var r = await fetch('/api/pipeline/hold/' + leadsId, { method:'POST' });
    var d = await r.json();
    if (d.success) refreshPipeline();
  } catch(e) {}
}

async function moveBackToQueue(leadsId) {
  try {
    var r = await fetch('/api/pipeline/unhold/' + leadsId, { method:'POST' });
    var d = await r.json();
    if (d.success) refreshPipeline();
  } catch(e) {}
}

async function changeSourceFilter() {
  var filter = document.getElementById('sourceFilter').value;
  try {
    await fetch('/api/pipeline/source-filter', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({filter:filter}) });
    refreshPipeline();
  } catch(e) {}
}

async function togglePipeline() {
  try {
    var r = await fetch('/api/pipeline/toggle', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    var d = await r.json();
    if (d.success) refreshPipeline();
  } catch(e) {}
}// ===================================================================
// Modal helpers
// ===================================================================
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// Overlay click to close
['detailModal','recordModal','logModal'].forEach(function(id) {
  var el = document.getElementById(id);
  if (el) el.addEventListener('click', function(e) { if (e.target === this) this.classList.remove('open'); });
});

// ===================================================================
// Polling
// ===================================================================
function startPolling() {
  // Status refresh every 10s
  setInterval(refreshStatus, 10000);
  // Leads polling every 15s
  async function pollLeads() {
    try {
      var r = await fetch('/api/wuji/leads?_t='+Date.now());
      var d = await r.json();
      if (d.success && d.data) { allLeads = d.data.list || []; saveCachedLeads(); updateSourcesFilter(); if (currentTab === 'leads') filterLeads(); }
      if (d.syncInfo) showWujiSyncInfo(d.syncInfo.info, d.syncInfo.time);
      if (d.error) showWujiError(d.error); else showWujiError(null);
    } catch(e) {}
  }
  setInterval(pollLeads, 15000);
  // Calls polling every 15s
  async function pollCalls() {
    try {
      var r = await fetch('/api/voicefox/sync');
      var d = await r.json();
      if (d.success) {
        await fetchAllCalls();
        if (d.data) showVfSyncInfo(d.data, new Date().toISOString());
        if (currentTab === 'pipeline') refreshPipeline();
      }
      if (d.error) showVfError(d.error); else showVfError(null);
    } catch(e) {}
  }
  setInterval(pollCalls, 15000);
}

// ===================================================================
// Global refresh
// ===================================================================
async function refreshAll() {
  document.getElementById('refreshBtn').disabled = true;
  document.getElementById('refreshBtn').textContent = '刷新中...';
  await Promise.all([
    manualSyncLeads(),
    manualSyncCalls(),
    refreshStatus(),
  ]);
  if (currentTab === 'pipeline') refreshPipeline();
  document.getElementById('refreshBtn').disabled = false;
  document.getElementById('refreshBtn').textContent = '刷新';
}

// ===================================================================
// Init
// ===================================================================
async function loadServerCache() {
  try {
    var r = await fetch('/api/wuji/cached');
    var d = await r.json();
    if (d.success && d.data && d.data.list.length > 0) {
      allLeads = d.data.list;
      saveCachedLeads();
      updateSourcesFilter();
      filterLeads();
    }
    var r2 = await fetch('/api/voicefox/calls/cached/all');
    var d2 = await r2.json();
    if (d2.success && d2.data && d2.data.list.length > 0) {
      allCalls = d2.data.list;
      saveCachedCalls();
      filterCalls();
      updateCallStats();
    }
  } catch(e) {}
}

function init() {
  renderLeadsHeaders();
  renderCallsHeaders();
  loadCachedLeads();
  loadCachedCalls();
  loadServerCache();
  refreshStatus();
  startPolling();
}

document.addEventListener('DOMContentLoaded', init);
