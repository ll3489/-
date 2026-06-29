const { save, load } = require('./persist');

const SCHEDULER_INTERVAL = 30000;
const MAX_LOG = 200;

class Pipeline {
  constructor(wuji, voicefox) {
    this.wuji = wuji;
    this.voicefox = voicefox;
    this.enabled = false;
    this.sourceFilter = 'all';
    this.holdArea = [];
    this.queue = [];
    this.activeLeadsId = null;
    this.activePhone = null;
    this.activeTaskId = null;
    this.log = [];
    this.stats = { totalEnqueued: 0, totalAnswered: 0, totalFailed: 0, totalUnreachable: 0 };
    this._schedulerTimer = null;
    this._restoreFromDisk();
    this.wuji.onSync = (info, details) => this._reconcileQueue();
    this.voicefox.onSync = (newlyAnswered) => this.processCompletedCalls(newlyAnswered);
    this._startScheduler();
  }

  _saveToDisk() {
    save('pipeline', {
      queue: this.queue, holdArea: this.holdArea, log: this.log,
      stats: this.stats, activeLeadsId: this.activeLeadsId,
      activePhone: this.activePhone, activeTaskId: this.activeTaskId,
      enabled: this.enabled, sourceFilter: this.sourceFilter,
    });
  }

  _restoreFromDisk() {
    const data = load('pipeline');
    if (data) {
      this.queue = data.queue || [];
      this.holdArea = data.holdArea || [];
      this.log = data.log || [];
      this.stats = data.stats || { totalEnqueued: 0, totalAnswered: 0, totalFailed: 0, totalUnreachable: 0 };
      this.activeLeadsId = data.activeLeadsId || null;
      this.activePhone = data.activePhone || null;
      this.activeTaskId = data.activeTaskId || null;
      if (data.enabled !== undefined) this.enabled = data.enabled;
      if (data.sourceFilter) this.sourceFilter = data.sourceFilter;
      console.log('[Pipeline] �Ӵ��ָ̻����� ' + this.queue.length + ' ��, ��ȷ�� ' + this.holdArea.length + ' ��');
    }
  }

  _reconcileQueue() {
    const allLeads = this.wuji.cachedLeads || {};
    const queueMap = {};
    this.queue.forEach(q => { queueMap[q.leadsId] = q; });
    let changed = false;

    for (const [leadsId, lead] of Object.entries(allLeads)) {
      const phone = lead.mobile || lead.telephone;
      if (!phone) continue;
      const isFollowedInCRM = !!(lead.lastContent || lead.lastCallTime);
      const inQueue = queueMap[leadsId];
      const inHold = this.holdArea.some(h => h.leadsId === leadsId);

      if (isFollowedInCRM && inHold) {
        this.holdArea = this.holdArea.filter(h => h.leadsId !== leadsId);
        changed = true; continue;
      }
      if (inHold) continue;

      if (!isFollowedInCRM && inQueue && inQueue.status === 'pending') {
        const source = lead.fieldJbdcox || '';
        const matchesFilter = (this.sourceFilter === 'all') ||
          (this.sourceFilter === 'manual' && source === '�˹��ֶ�') ||
          (this.sourceFilter === 'system' && source === 'ϵͳ����');
        if (!matchesFilter) {
          this.queue = this.queue.filter(q => q.leadsId !== leadsId);
          changed = true; continue;
        }
      }

      if (isFollowedInCRM && inQueue && inQueue.status === 'pending') {
        this.queue = this.queue.filter(q => q.leadsId !== leadsId);
        changed = true; continue;
      }

      if (!isFollowedInCRM && !inQueue) {
        const source = lead.fieldJbdcox || '';
        if (this.sourceFilter === 'manual' && source !== '�˹��ֶ�') continue;
        if (this.sourceFilter === 'system' && source !== 'ϵͳ����') continue;
        this.queue.push({
          leadsId, phone, source,
          leadsName: lead.leadsName || '(������)',
          createTime: lead.createTime || new Date().toISOString(),
          attemptCount: 0, status: 'pending',
          enqueuedAt: new Date().toISOString(),
          lastAttemptAt: null, lastHangupReason: null, taskId: null,
        });
        this.stats.totalEnqueued++;
        changed = true;
      }
    }
    // Remove queue/hold items whose leads no longer exist in CRM
    const validIds = new Set(Object.keys(allLeads));
    const beforeQueue = this.queue.length;
    const beforeHold = this.holdArea.length;
    this.queue = this.queue.filter(q => validIds.has(q.leadsId));
    this.holdArea = this.holdArea.filter(h => validIds.has(h.leadsId));
    if (this.queue.length !== beforeQueue || this.holdArea.length !== beforeHold) {
      changed = true;
    }
    // Clean up active call state if the lead was removed
    if (this.activeLeadsId && !validIds.has(this.activeLeadsId)) {
      this.activeLeadsId = null;
      this.activePhone = null;
      this.activeTaskId = null;
    }

    if (changed) {
      this.queue.sort((a, b) => new Date(b.createTime) - new Date(a.createTime));
      this._saveToDisk();
    }
  }

  _startScheduler() {
    if (this._schedulerTimer) clearInterval(this._schedulerTimer);
    this._schedulerTimer = setInterval(() => this.tick(), SCHEDULER_INTERVAL);
  }

  async tick() {
    if (!this.enabled || !this.voicefox.isLoggedIn || !this.wuji.isLoggedIn) return;
    if (this.activeTaskId && this.queue.some(q => q.leadsId === this.activeLeadsId && q.status === 'calling')) return;
    this.activeTaskId = null; this.activeLeadsId = null; this.activePhone = null;
    const next = this.queue.find(q => q.status === 'pending');
    if (!next) return;
    try {
      const result = await this.voicefox.createTask(next.phone, '\u81ea\u52a8_' + (next.leadsName || next.phone).slice(0,20));
      next.status = 'calling'; next.taskId = result.id;
      next.lastAttemptAt = new Date().toISOString(); next.attemptCount++;
      this.activeLeadsId = next.leadsId; this.activePhone = next.phone; this.activeTaskId = result.id;
      this._saveToDisk();
    } catch (err) {
      next.status = 'failed';
      this._saveToDisk();
    }
  }

  async processCompletedCalls(newlyAnswered) {
    if (!this.enabled && !this.queue.some(q => q.status === 'calling')) return;
    const callingItems = this.queue.filter(q => q.status === 'calling' && q.taskId);
    if (callingItems.length === 0) return;

    const allCalls = Object.values(this.voicefox.cachedCallsById);
    for (const item of callingItems) {
      var matchedCall = allCalls.find(c => c.hangupReason && c.callee && c.callee.replace(/[^0-9]/g,"") === (item.phone||"").replace(/[^0-9]/g,"") && (!item.lastAttemptAt || new Date(c.endAt||c.startAt||0) > new Date(item.lastAttemptAt)));
      if (!matchedCall) {
        if (item.attemptCount >= 2) {
          var msg = "\u0032\u6b21\u7535\u8bdd\u5747\u65e0\u6cd5\u63a5\u901a";
          try { await this.wuji.writeFollowUp(item.leadsId, msg); } catch(e) {}
          item.status = "failed";
          this.stats.totalUnreachable++;
          this._saveToDisk();
        }
        continue;
      }
      if (item.lastHangupReason === matchedCall.hangupReason) {
        if (item.attemptCount >= 2) {
          var msg = "\u0032\u6b21\u7535\u8bdd\u5747\u65e0\u6cd5\u63a5\u901a";
          try { await this.wuji.writeFollowUp(item.leadsId, msg); } catch(e) {}
          item.status = "failed";
          this.stats.totalUnreachable++;
          this._saveToDisk();
        }
        continue;
      }
      const wasManual = item._fromHold;
      item.lastHangupReason = matchedCall.hangupReason;

      if (matchedCall.hangupReason === 'answered') {
        let summary = '', suggestion = '', transcript = '';
        try {
          const aiSummary = await this.voicefox.getCallAiSummary(matchedCall.id);
          if (aiSummary) { summary = aiSummary.summary || ''; suggestion = aiSummary.suggestion || ''; }
        } catch(e) {}
        try {
          const lines = await this.voicefox.getCallTranscript(matchedCall.id);
          if (lines && lines.length > 0) transcript = lines.slice(0, 6).map(l => '[' + l.speaker + '] ' + l.content).join('\n');
        } catch(e) {}
        let content = '[AI\u5916\u547c] \u5df2\u63a5\u901a\n\u901a\u8bdd\u65f6\u957f: ' + (matchedCall.duration || 0) + '\u79d2\n' + (matchedCall.duration || 0) + '\u79d2\n';
        if (summary) content += 'AI\u6458\u8981: ' + summary + '\n';
        if (suggestion) content += 'AI\u5efa\u8bae: ' + suggestion + '\n';
        if (transcript) content += '\u5bf9\u8bdd\u7247\u6bb5:\n' + transcript + '\n';try { await this.wuji.writeFollowUp(item.leadsId, content); } catch(e) {}
        item.status = 'completed';
        this.stats.totalAnswered++;
        if (wasManual) this.holdArea = this.holdArea.filter(h => h.leadsId !== item.leadsId);
      } else {
        if (item.attemptCount >= 2) {
          var content = '[AI外呼] 2次电话均无法接通';
          try { await this.wuji.writeFollowUp(item.leadsId, content); } catch(e) {}
          item.status = 'failed';
          this.stats.totalUnreachable++;
          if (item._fromHold) this.holdArea = this.holdArea.filter(h => h.leadsId !== item.leadsId);
        } else {
          item.status = 'pending';
          this.queue = this.queue.filter(q => q.leadsId !== item.leadsId);
          this.queue.push(item);
        }
      }
      this._saveToDisk();
    }
    if (this.activeTaskId && !this.queue.some(q => q.taskId === this.activeTaskId && q.status === 'calling')) {
      this.activeTaskId = null; this.activeLeadsId = null; this.activePhone = null;
    }
  }

  async manualCall(leadsId) {
    if (!this.voicefox.isLoggedIn) return false;
    let item = this.queue.find(q => q.leadsId === leadsId);
    let fromHold = false;
    if (!item) {
      const holdItem = this.holdArea.find(h => h.leadsId === leadsId);
      if (!holdItem) return false;
      item = { leadsId: holdItem.leadsId, phone: holdItem.phone, leadsName: holdItem.leadsName,
        createTime: holdItem.createTime, source: holdItem.source || '',
        attemptCount: 0, status: 'calling', enqueuedAt: new Date().toISOString(),
        lastAttemptAt: null, lastHangupReason: null, taskId: null, _fromHold: true };
      this.queue.push(item);
      this.holdArea = this.holdArea.filter(h => h.leadsId !== leadsId);
      fromHold = true;
    }
    if (item.status !== 'pending' && item.status !== 'calling') {
      if (item.status === 'completed' || item.status === 'failed') {
        item.status = 'calling';
        item.attemptCount = 0;
      } else {
        return false;
      }
    }
    try {
      const result = await this.voicefox.createTask(item.phone, '\u624b\u52a8_' + (item.leadsName || item.phone).slice(0,20));
      item.status = 'calling'; item.taskId = result.id;
      item.lastAttemptAt = new Date().toISOString(); item.attemptCount++;
      this._saveToDisk(); return true;
    } catch (err) {
      item.status = 'pending'; item.taskId = null;
      if (fromHold) {
        this.holdArea.push({ leadsId: item.leadsId, phone: item.phone, leadsName: item.leadsName,
          createTime: item.createTime, source: item.source || '', movedAt: new Date().toISOString() });
        this.queue = this.queue.filter(q => q.leadsId !== leadsId);
      }
      this._saveToDisk(); return false;
    }
  }

  moveToHoldArea(leadsId) {
    const idx = this.queue.findIndex(q => q.leadsId === leadsId);
    if (idx === -1 || this.queue[idx].status !== 'pending') return false;
    const item = this.queue.splice(idx, 1)[0];
    this.holdArea.push({ leadsId: item.leadsId, phone: item.phone, leadsName: item.leadsName,
      createTime: item.createTime, source: item.source || '', movedAt: new Date().toISOString() });
    this._saveToDisk(); return true;
  }

  moveBackToQueue(leadsId) {
    const idx = this.holdArea.findIndex(h => h.leadsId === leadsId);
    if (idx === -1) return false;
    const item = this.holdArea.splice(idx, 1)[0];
    this.queue.push({ leadsId: item.leadsId, phone: item.phone, leadsName: item.leadsName,
      createTime: item.createTime, source: item.source || '',
      attemptCount: 0, status: 'pending', enqueuedAt: new Date().toISOString(),
      lastAttemptAt: null, lastHangupReason: null, taskId: null });
    this._saveToDisk(); return true;
  }

  setSourceFilter(filter) {
    if (!['all', 'manual', 'system'].includes(filter)) return false;
    this.sourceFilter = filter;
    this._reconcileQueue();
    this._saveToDisk(); return true;
  }

  toggle(enable) {
    this.enabled = enable !== undefined ? !!enable : !this.enabled;
    this._saveToDisk();
    if (this.enabled) this.tick();
  }

  getStatus() {
    const pending = this.queue.filter(q => q.status === 'pending').length;
    const calling = this.queue.filter(q => q.status === 'calling').length;
    const completed = this.queue.filter(q => q.status === 'completed').length;
    const failed = this.queue.filter(q => q.status === 'failed').length;
    return {
      enabled: this.enabled, sourceFilter: this.sourceFilter,
      activeCall: this.activePhone ? { phone: this.activePhone, leadsId: this.activeLeadsId, taskId: this.activeTaskId } : null,
      holdArea: this.holdArea.map(h => ({ leadsId: h.leadsId, phone: h.phone, leadsName: h.leadsName, createTime: h.createTime, source: h.source, movedAt: h.movedAt })),
      queue: { total: this.queue.length, pending, calling, completed, failed,
        items: this.queue.slice(0, 200).map(q => ({
          leadsId: q.leadsId, phone: q.phone, leadsName: q.leadsName,
          createTime: q.createTime, attemptCount: q.attemptCount, status: q.status,
          source: q.source || '', lastAttemptAt: q.lastAttemptAt, lastHangupReason: q.lastHangupReason,
        })),
      },
      stats: this.stats,
      recentLog: this.log.slice(-30).reverse(),
    };
  }
}

module.exports = { Pipeline };


