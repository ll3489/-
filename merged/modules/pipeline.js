const { save, load } = require('./persist');

const MAX_LOG = 200;

class Pipeline {
  constructor(wuji, voicefox) {
    this.wuji = wuji;
    this.voicefox = voicefox;
    this.enabled = true;
    this.log = [];
    this.stats = { totalMatched: 0, totalWritten: 0, totalFailed: 0 };
    this._restoreFromDisk();

    this.voicefox.onSync = async (newlyAnswered, info) => {
      if (!this.enabled) return;
      await this.processNewCalls(newlyAnswered);
    };
  }

  // ---------- Persistence ----------
  _saveToDisk() {
    save('pipeline', {
      log: this.log,
      stats: this.stats,
    });
  }

  _restoreFromDisk() {
    const data = load('pipeline');
    if (data) {
      this.log = data.log || [];
      this.stats = data.stats || { totalMatched: 0, totalWritten: 0, totalFailed: 0 };
      console.log('[Pipeline] 从磁盘恢复 ' + this.stats.totalWritten + ' 条写入记录, ' + this.log.length + ' 条日志');
    }
  }

  async processNewCalls(newlyAnswered) {
    for (const call of newlyAnswered) {
      try {
        await this.processCall(call);
      } catch (err) {
        console.error('[Pipeline] 处理通话 ' + call.id + ' 失败:', err.message);
        this.addLog(call.id, call.callee, 'error', err.message);
        this.stats.totalFailed++;
        this._saveToDisk();
      }
    }
  }

  async processCall(call) {
    const phone = call.callee || '';
    if (!phone) {
      this.addLog(call.id, phone, 'skipped', '无被叫号码');
      this._saveToDisk();
      return;
    }

    const lead = this.wuji.findLeadByPhone(phone);
    if (!lead) {
      this.addLog(call.id, phone, 'unmatched', 'CRM中未找到匹配线索');
      this._saveToDisk();
      return;
    }

    this.stats.totalMatched++;

    let summary = '';
    let suggestion = '';
    try {
      const aiSummary = await this.voicefox.getCallAiSummary(call.id);
      if (aiSummary && aiSummary.summary) summary = aiSummary.summary;
      if (aiSummary && aiSummary.suggestion) suggestion = aiSummary.suggestion;
    } catch (e) {}

    let transcript = '';
    try {
      const lines = await this.voicefox.getCallTranscript(call.id);
      if (lines && lines.length > 0) {
        transcript = lines.slice(0, 10).map(l => '[' + l.speaker + '] ' + l.content).join('\n');
      }
    } catch (e) {}

    let content = '[AI外呼自动跟进] 通话完成\n';
    content += '被叫号码: ' + phone + '\n';
    content += '通话时长: ' + (call.duration || 0) + '秒\n';
    if (summary) content += 'AI摘要: ' + summary + '\n';
    if (suggestion) content += 'AI建议: ' + suggestion + '\n';
    if (transcript) content += '对话片段:\n' + transcript + '\n';

    const success = await this.wuji.writeFollowUp(lead.leadsId, content);
    if (success) {
      this.stats.totalWritten++;
      this.addLog(call.id, phone, 'written', '线索"' + (lead.leadsName || lead.mobile) + '"跟进已写入 (' + (call.duration || 0) + 's)');
      console.log('[Pipeline] 通话 #' + call.id + ' 线索 ' + lead.leadsId + ' 跟进已写入');
    } else {
      this.stats.totalFailed++;
      this.addLog(call.id, phone, 'error', '写入CRM跟进失败');
    }
    this._saveToDisk();
  }

  addLog(callId, phone, status, message) {
    this.log.push({ time: new Date().toISOString(), callId, phone, status, message });
    if (this.log.length > MAX_LOG) {
      this.log = this.log.slice(this.log.length - MAX_LOG);
    }
  }

  async processCallById(recordId) {
    try {
      const call = await this.voicefox.getCallDetail(recordId);
      await this.processCall(call);
      return true;
    } catch (err) {
      console.error('[Pipeline] 手动处理通话 ' + recordId + ' 失败:', err.message);
      return false;
    }
  }

  getStatus() {
    return {
      enabled: this.enabled,
      stats: this.stats,
      recentLog: this.log.slice(-50).reverse(),
    };
  }

  toggle(enable) {
    this.enabled = enable !== undefined ? !!enable : !this.enabled;
    console.log('[Pipeline] ' + (this.enabled ? '已启用' : '已禁用'));
  }

  async runBatchMatch() {
    if (!this.voicefox.isLoggedIn || !this.wuji.isLoggedIn) {
      return { matched: 0, errors: ['请确保两个系统都已登录'] };
    }

    const answeredCalls = [];
    for (const id of Object.keys(this.voicefox.cachedCallsById)) {
      const call = this.voicefox.cachedCallsById[id];
      if (call.hangupReason === 'answered') {
        answeredCalls.push(call);
      }
    }

    let matched = 0;
    for (const call of answeredCalls) {
      const lead = this.wuji.findLeadByPhone(call.callee || '');
      if (lead) matched++;
    }

    return { totalAnswered: answeredCalls.length, matchedInCRM: matched, unmatched: answeredCalls.length - matched };
  }
}

module.exports = { Pipeline };
