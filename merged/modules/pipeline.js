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

    // Hook: after Wuji CRM sync, enqueue new leads
    this.wuji.onSync = (info, details) => this.onWujiSync(info, details);

    // Hook: after VoiceFox sync, check for completed outbound calls
    this.voicefox.onSync = (newlyAnswered) => this.processCompletedCalls(newlyAnswered);

    this._startScheduler();
  }

  // ---------- Persistence ----------
  _saveToDisk() {
    save('pipeline', {
      queue: this.queue,
      holdArea: this.holdArea,
      log: this.log,
      stats: this.stats,
      activeLeadsId: this.activeLeadsId,
      activePhone: this.activePhone,
      activeTaskId: this.activeTaskId,
      enabled: this.enabled,
      sourceFilter: this.sourceFilter,
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
      console.log('[Pipeline] 从磁盘恢复队列 ' + this.queue.length + ' 条, 待确认 ' + this.holdArea.length + ' 条, 活跃任务: ' + (this.activeTaskId || '无'));
    } else {
      // First run: scan all existing answered calls to build initial queue state
      console.log('[Pipeline] 首次运行，扫描历史通话');
    }
  }

  // ---------- Queue Management ----------
  _reconcileQueue() {
// Full sync: scan ALL CRM leads, reconcile with queue
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

      // If lead doesn't match current sourceFilter, remove from queue
      if (!isFollowedInCRM && inQueue && inQueue.status === 'pending') {
        const source = lead.fieldJbdcox || '';
        const matchesFilter = (this.sourceFilter === 'all') ||
          (this.sourceFilter === 'manual' && source === '人工手动') ||
          (this.sourceFilter === 'system' && source === '系统接入');
        if (!matchesFilter) {
          this.queue = this.queue.filter(q => q.leadsId !== leadsId);
          this.addLog(leadsId, phone, 'filtered', '来源筛选不匹配，移出队列');
          changed = true;
          continue;
        }
      }

      // If lead is now followed up in CRM, remove from holdArea
      if (isFollowedInCRM && inHold) {
        this.holdArea = this.holdArea.filter(h => h.leadsId !== leadsId);
        this.addLog(leadsId, phone, 'removed', '待确认线索已在CRM中跟进，自动移出');
        changed = true;
        continue;
      }

      // Skip if in holdArea (not affected by sourceFilter or queue logic)
      if (inHold) continue;

      if (!isFollowedInCRM && !inQueue) {
        // Apply source filter
        const source = lead.fieldJbdcox || '';
        if (this.sourceFilter === 'manual' && source !== '人工手动') continue;
        if (this.sourceFilter === 'system' && source !== '系统接入') continue;

        // New unfollowed lead - add to queue (newest first via _sortQueue)
        this.queue.push({
          leadsId,
          phone: phone,
          leadsName: lead.leadsName || '(无名称)',
          createTime: lead.createTime || new Date().toISOString(),
          attemptCount: 0,
          status: 'pending',
          enqueuedAt: new Date().toISOString(),
          lastAttemptAt: null,
          lastHangupReason: null,
          taskId: null,
          source: lead.fieldJbdcox || '',
        });
        this.stats.totalEnqueued++;
        this.addLog(leadsId, phone, 'enqueued', '线索"' + (lead.leadsName || phone) + '"已加入外呼队列');
        changed = true;

      } else if (isFollowedInCRM && inQueue && inQueue.status === 'pending') {
        // Was pending but CRM now has follow-up - remove from queue
        this.queue = this.queue.filter(q => q.leadsId !== leadsId);
        this.addLog(leadsId, phone, 'removed', '已在CRM中跟进，移出队列');
        changed = true;
      }
    }

    if (changed) {
      this._sortQueue();
      this._saveToDisk();
    }
  }

  _sortQueue() {
    // Pending items sorted by createTime descending (newest first)
    // Non-pending items at the bottom
    const pending = this.queue.filter(q => q.status === 'pending').sort((a, b) =>
      new Date(b.createTime) - new Date(a.createTime)
    );
    const others = this.queue.filter(q => q.status !== 'pending');
    this.queue = [...pending, ...others];
  }

  // ---------- Scheduler ----------
  _startScheduler() {
    if (this._schedulerTimer) clearInterval(this._schedulerTimer);
    this._schedulerTimer = setInterval(() => this.tick(), SCHEDULER_INTERVAL);
  }

  async tick() {
    if (!this.enabled) return;
    if (!this.voicefox.isLoggedIn || !this.wuji.isLoggedIn) return;

    // Check if active call has completed
    if (this.activeTaskId) {
      // VoiceFox's doSync handles this; we wait for processCompletedCalls
      const stillActive = this.queue.some(q =>
        q.leadsId === this.activeLeadsId && q.status === 'calling'
      );
      if (stillActive) return; // Still waiting
      this.activeTaskId = null;
      this.activeLeadsId = null;
      this.activePhone = null;
      this._saveToDisk();
    }

    // Find next pending item
    const next = this.queue.find(q => q.status === 'pending');
    if (!next) return;

    await this.callNext(next);
  }

  async callNext(item) {
    if (!this.enabled) return;
    if (!this.voicefox.isLoggedIn) return;

    console.log('[Pipeline] 开始外呼: ' + item.phone + ' (' + item.leadsName + ')');
    this.addLog(item.leadsId, item.phone, 'calling', '正在拨打: ' + item.leadsName);

    try {
      const taskName = 'wuji_pipeline_' + item.leadsId + '_' + Date.now();
      const result = await this.voicefox.createTask(item.phone, taskName);
      const taskId = result.id;

      item.status = 'calling';
      item.taskId = taskId;
      item.lastAttemptAt = new Date().toISOString();
      item.attemptCount++;
      this.activeLeadsId = item.leadsId;
      this.activePhone = item.phone;
      this.activeTaskId = taskId;
      this._saveToDisk();

      console.log('[Pipeline] 外呼任务已创建: #' + taskId + ' -> ' + item.phone);
    } catch (err) {
      console.error('[Pipeline] 创建外呼任务失败: ' + item.phone + ' - ' + err.message);
      this.addLog(item.leadsId, item.phone, 'error', '创建外呼失败: ' + err.message);
      // Mark as failed so we don't keep retrying
      item.status = 'failed';
      this._saveToDisk();
    }
  }

  // ---------- Process Call Results ----------
  async processCompletedCalls(newlyAnswered) {
    if (!this.enabled) return;
    if (!this.activeTaskId) return;

    // Find the active queue item
    const item = this.queue.find(q => q.leadsId === this.activeLeadsId);
    if (!item) return;

    // Look for the call in VoiceFox's cache
    const calls = Object.values(this.voicefox.cachedCallsById);
    const matchedCall = calls.find(c =>
      c.taskId === this.activeTaskId &&
      c.callee && c.callee.replace(/[^0-9]/g, '') === this.activePhone.replace(/[^0-9]/g, '')
    );

    if (!matchedCall) return; // Call not yet completed

    const reason = matchedCall.hangupReason || 'unknown';
    item.lastHangupReason = reason;

    // Check if this call was answered (hangupReason === 'answered')
    const isAnswered = matchedCall.hangupReason === 'answered';
    const wasAlreadyAnswered = newlyAnswered.some(c => c.id === matchedCall.id);

    if (!isAnswered && !['no_answer', 'busy', 'failed', 'cancel', 'timeout'].includes(reason)) {
      return; // Still in progress or unknown state
    }

    if (isAnswered) {
      await this.handleAnswered(item, matchedCall);
    } else {
      await this.handleNotAnswered(item, matchedCall);
    }
  }

  async handleAnswered(item, call) {
    console.log('[Pipeline] 通话已接通: ' + item.phone);

    // Get AI summary
    let summary = '';
    let suggestion = '';
    let collectData = [];
    try {
      const aiSummary = await this.voicefox.getCallAiSummary(call.id);
      if (aiSummary) {
        summary = aiSummary.summary || '';
        suggestion = aiSummary.suggestion || '';
      }
    } catch (e) {}

    // Get collect data (customer intent)
    try {
      const detail = await this.voicefox.getCallDetail(call.id);
      const collect = detail.collect;
      if (collect && collect.length > 0 && collect[0].items) {
        collectData = collect[0].items
          .filter(i => i.answer)
          .map(i => ({ question: i.question, answer: i.answer }));
      }
    } catch (e) {}

    // Build follow-up content
    let content = '[AI外呼] 已接通\n';
    content += '通话时长: ' + (call.duration || 0) + '秒\n';
    if (summary) content += 'AI摘要: ' + summary + '\n';
    if (suggestion) content += 'AI建议: ' + suggestion + '\n';
    if (collectData.length > 0) {
      content += '\n客户意向信息:\n';
      collectData.forEach(d => {
        content += '  ' + d.question + ': ' + d.answer + '\n';
      });
    }

    // Try to get transcript
    try {
      const lines = await this.voicefox.getCallTranscript(call.id);
      if (lines && lines.length > 0) {
        content += '\n对话片段:\n';
        lines.slice(0, 6).forEach(l => {
          content += '  [' + l.speaker + '] ' + l.content + '\n';
        });
      }
    } catch (e) {}

    // Write to Wuji CRM
    const success = await this.wuji.writeFollowUp(item.leadsId, content);
    if (success) {
      item.status = 'completed';
      this.stats.totalAnswered++;
      this.addLog(item.leadsId, item.phone, 'completed',
        '已接通 (' + (call.duration || 0) + 's)' + (summary ? ': ' + summary.slice(0, 60) : ''));
      console.log('[Pipeline] 跟进已写入: ' + item.leadsName);
    } else {
      item.status = 'failed';
      this.stats.totalFailed++;
      this.addLog(item.leadsId, item.phone, 'error', '通话完成但写入CRM失败');
    }

    this.activeTaskId = null;
    this.activeLeadsId = null;
    this.activePhone = null;
    this._saveToDisk();
  }

  async handleNotAnswered(item, call) {
    const reason = call.hangupReason || 'unknown';
    console.log('[Pipeline] 未接通: ' + item.phone + ' (' + reason + '), 第' + item.attemptCount + '次');

    if (item.attemptCount >= 2) {
      // Second failure - write "无法打通" to CRM
      let content = '[AI外呼] 无法打通\n';
      content += '拨打次数: 2次\n';
      content += '最后状态: ' + reason + '\n';
      content += '最后拨打时间: ' + (call.endAt || new Date().toISOString()) + '\n';

      const success = await this.wuji.writeFollowUp(item.leadsId, content);
      if (success) {
        item.status = 'failed';
        this.stats.totalUnreachable++;
        this.addLog(item.leadsId, item.phone, 'unreachable', '2次拨打均未接通，已写入CRM');
        console.log('[Pipeline] 2次未接通，已写入CRM: ' + item.phone);
      } else {
        item.status = 'failed';
        this.stats.totalFailed++;
        this.addLog(item.leadsId, item.phone, 'error', '2次未接通，但写入CRM失败');
      }
    } else {
      // First failure - move to end of queue
      item.status = 'pending';
      // Move to end: remove from current position and add to end
      this.queue = this.queue.filter(q => q.leadsId !== item.leadsId);
      this.queue.push(item);
      this.addLog(item.leadsId, item.phone, 'retrying',
        '第1次未接通 (' + reason + ')，移至队尾等待重试');
      console.log('[Pipeline] 第1次未接通，移至队尾: ' + item.phone);
    }

    this.activeTaskId = null;
    this.activeLeadsId = null;
    this.activePhone = null;
    this._saveToDisk();
  }

  addLog(leadsId, phone, status, message) {
    this.log.push({ time: new Date().toISOString(), leadsId, phone, status, message });
    if (this.log.length > MAX_LOG) this.log = this.log.slice(this.log.length - MAX_LOG);
  }

  onWujiSync(info, details) {
    this._reconcileQueue();
  }
  // ---------- Hold Area ----------
  moveToHoldArea(leadsId) {
    const idx = this.queue.findIndex(q => q.leadsId === leadsId);
    if (idx === -1) return false;
    const item = this.queue[idx];
    if (item.status !== 'pending') return false; // only pending items

    this.queue.splice(idx, 1);
    this.holdArea.push({
      leadsId: item.leadsId,
      phone: item.phone,
      leadsName: item.leadsName,
      createTime: item.createTime,
      source: item.source || '',
      movedAt: new Date().toISOString(),
    });
    this.addLog(leadsId, item.phone, 'hold', '移入待确认区域');
    this._saveToDisk();
    return true;
  }

  moveBackToQueue(leadsId) {
    const idx = this.holdArea.findIndex(h => h.leadsId === leadsId);
    if (idx === -1) return false;
    const item = this.holdArea[idx];

    this.holdArea.splice(idx, 1);
    this.queue.push({
      leadsId: item.leadsId,
      phone: item.phone,
      leadsName: item.leadsName,
      createTime: item.createTime,
      source: item.source || '',
      attemptCount: 0,
      status: 'pending',
      enqueuedAt: new Date().toISOString(),
      lastAttemptAt: null,
      lastHangupReason: null,
      taskId: null,
    });
    this.addLog(leadsId, item.phone, 'unhold', '从待确认移回队列');
    this._saveToDisk();
    return true;
  }

  setSourceFilter(filter) {
    if (!['all', 'manual', 'system'].includes(filter)) return false;
    this.sourceFilter = filter;
    this._reconcileQueue();
    this._saveToDisk();
    this.addLog('', '', 'filter', '筛选切换为: ' + filter);
    return true;
  }

  // ---------- Manual Controls ----------
  toggle(enable) {
    this.enabled = enable !== undefined ? !!enable : !this.enabled;
    console.log('[Pipeline] ' + (this.enabled ? '已启用' : '已禁用'));
    this._saveToDisk();
  }

  // ---------- Status ----------
  getStatus() {
    const pending = this.queue.filter(q => q.status === 'pending').length;
    const calling = this.queue.filter(q => q.status === 'calling').length;
    const completed = this.queue.filter(q => q.status === 'completed').length;
    const failed = this.queue.filter(q => q.status === 'failed').length;

    return {
      enabled: this.enabled,
      sourceFilter: this.sourceFilter,
      activeCall: this.activePhone ? { phone: this.activePhone, leadsId: this.activeLeadsId, taskId: this.activeTaskId } : null,
      holdArea: this.holdArea.map(h => ({
        leadsId: h.leadsId,
        phone: h.phone,
        leadsName: h.leadsName,
        createTime: h.createTime,
        source: h.source,
        movedAt: h.movedAt,
      })),
      queue: {
        total: this.queue.length,
        pending,
        calling,
        completed,
        failed,
        items: this.queue.slice(0, 200).map(q => ({
          leadsId: q.leadsId,
          phone: q.phone,
          leadsName: q.leadsName,
          createTime: q.createTime,
          attemptCount: q.attemptCount,
          status: q.status,
          source: q.source || '',
          enqueuedAt: q.enqueuedAt,
          lastAttemptAt: q.lastAttemptAt,
          lastHangupReason: q.lastHangupReason,
        })),
      },
      stats: this.stats,
      recentLog: this.log.slice(-30).reverse(),
    };
  }
}

module.exports = { Pipeline };

