(function (root) {
  const STRUCTURED_LOG_PREFIX = '@@WANDAO_LOG@@';

  function fallbackCompact(value, limit = 700) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function fallbackFirstNonEmpty(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
    }
    return '';
  }

  function normalizeStructuredLogType(level) {
    const text = String(level || '').toLowerCase();
    if (text === 'success') return 'success';
    if (text === 'warn' || text === 'warning') return 'warn';
    if (text === 'error' || text === 'fatal') return 'error';
    return 'info';
  }

  function createProcessor(deps = {}) {
    let lineBuffer = '';
    let tocDiscovered = 0;
    const appendDetailedLog = deps.appendDetailedLog || (() => {});
    const appendUserLog = deps.appendUserLog || (() => {});
    const updateProgress = deps.updateProgress || (() => {});
    const onPlainLine = deps.onPlainLine || (() => {});
    const compactDiagnostic = deps.compactDiagnostic || fallbackCompact;
    const firstNonEmpty = deps.firstNonEmpty || fallbackFirstNonEmpty;
    const formatUserError = deps.formatUserError || ((message) => String(message || ''));
    const summarizePythonLine = deps.summarizePythonLine || (() => null);
    const formatError = deps.formatError || ((error) => String(error?.message || error || ''));

    function structuredLogSource(event) {
      const provider = event.provider || 'python';
      const taskId = event.taskId ? `#${String(event.taskId).slice(-6)}` : '';
      return `${provider}${taskId}`;
    }

    function structuredErrorText(event) {
      const parts = [];
      if (event.error?.status) parts.push(`HTTP ${event.error.status}`);
      if (event.error?.code) parts.push(String(event.error.code));
      if (event.error?.message) parts.push(String(event.error.message));
      if (event.error && !parts.length) parts.push(compactDiagnostic(event.error, 260));
      return parts.filter(Boolean).join('：');
    }

    function structuredDocText(event) {
      const doc = event.doc || {};
      return firstNonEmpty(doc.title, doc.path, doc.id, event.document, event.path);
    }

    function summarizeEvent(event) {
      const eventName = String(event.event || '');
      const type = normalizeStructuredLogType(event.level);
      const message = compactDiagnostic(event.message, 260);
      const doc = structuredDocText(event);
      const error = structuredErrorText(event);
      const progress = event.progress || {};
      const stats = event.stats || {};

      if (eventName === 'log.message') {
        if (/API .*失败.*(改用|兜底)|接口.*失败.*(改用|兜底)/i.test(message)) {
          return { type: type === 'error' ? 'warn' : type, message: compactDiagnostic(message, 220) };
        }
        return summarizePythonLine(message);
      }
      if (eventName === 'task.started') {
        return { type: 'info', message: message || '任务已开始。' };
      }
      if (eventName === 'task.completed') {
        return { type: 'success', message: message || '任务完成。' };
      }
      if (eventName === 'task.stopped') {
        return { type: 'warn', message: message || '任务已停止。' };
      }
      if (eventName === 'task.failed') {
        return { type: 'error', message: formatUserError(error || message || '任务执行失败') };
      }
      if (eventName === 'task.progress') {
        const current = Number(progress.current || 0);
        const total = Number(progress.total || 0);
        const statParts = [];
        if (Number.isFinite(stats.groupPage) || Number.isFinite(stats.groupBatchTopics)) {
          const suffix = total ? `，预计 ${total} 篇左右` : '';
          return { type: 'info', message: `帖子列表读取：已读取 ${current || 0} 篇${suffix}` };
        }
        if (Number.isFinite(stats.exportedDocs)) statParts.push(`导出 ${stats.exportedDocs}`);
        if (Number.isFinite(stats.importedDocs)) statParts.push(`导入 ${stats.importedDocs}`);
        if (Number.isFinite(stats.createdDocs)) statParts.push(`创建 ${stats.createdDocs}`);
        if (Number.isFinite(stats.updatedDocs)) statParts.push(`更新 ${stats.updatedDocs}`);
        if (Number.isFinite(stats.skippedDocs)) statParts.push(`跳过 ${stats.skippedDocs}`);
        if (Number.isFinite(stats.imageSuccess)) statParts.push(`图片 ${stats.imageSuccess}`);
        if (Number.isFinite(stats.attachmentSuccess)) statParts.push(`附件 ${stats.attachmentSuccess}`);
        if (Number.isFinite(stats.attachmentUploads)) statParts.push(`附件 ${stats.attachmentUploads}`);
        if (Number.isFinite(stats.failureCount) && stats.failureCount) statParts.push(`失败 ${stats.failureCount}`);
        if (current && total) {
          return { type: stats.failureCount ? 'warn' : 'info', message: `进度 ${current}/${total}${statParts.length ? `，${statParts.join('，')}` : ''}` };
        }
        return null;
      }
      if (/^toc\.(started|root|progress|completed)$/.test(eventName) || /^toc\.cache\./.test(eventName)) {
        if (!message) return null;
        return { type, message };
      }
      if (eventName === 'document.export.failed' && type !== 'error') {
        if (/video-topic/i.test(error || message)) {
          return { type: 'warn', message: `已跳过视频帖：${doc || '未命名帖子'}` };
        }
        return { type, message: `已跳过：${doc || message || '当前条目'}${error ? `（${error}）` : ''}` };
      }
      if (eventName.endsWith('.failed') || type === 'error') {
        const subject = doc ? `${doc}：` : '';
        const detail = error || message || compactDiagnostic(event, 360);
        return { type: 'error', message: formatUserError(`${subject}${detail}`) };
      }
      if (/^(auth|browser)\./.test(eventName) && message) {
        return { type, message };
      }
      return null;
    }

    function updateProgressFromEvent(event) {
      const eventName = String(event.event || '');
      if (eventName.startsWith('toc.')) {
        if (eventName === 'toc.started' || eventName === 'toc.root') tocDiscovered = 0;
        const stats = event.stats || {};
        const explicit = Number(stats.discovered ?? event.progress?.current ?? 0);
        const discoveredMatch = /已发现\s*(\d+)\s*个节点/.exec(String(event.message || ''));
        const discoveredFromMessage = Number(discoveredMatch?.[1] || 0);
        tocDiscovered = Math.max(
          tocDiscovered,
          Number.isFinite(explicit) ? explicit : 0,
          Number.isFinite(discoveredFromMessage) ? discoveredFromMessage : 0
        );
        const base = tocDiscovered ? `正在读取目录，已发现 ${tocDiscovered} 个节点` : '正在读取目录…';
        const detail = eventName === 'toc.page' && event.message ? `${base}，${compactDiagnostic(event.message, 140)}` : base;
        updateProgress(0, 0, detail);
        return;
      }
      if (event.event !== 'task.progress' || !event.progress) return;
      const current = Number(event.progress.current || 0);
      const total = Number(event.progress.total || 0);
      if (!current && !total) return;
      const stats = event.stats || {};
      const detailParts = (Number.isFinite(stats.groupPage) || Number.isFinite(stats.groupBatchTopics))
        ? [`帖子列表读取 ${current}/${total || '?'}`]
        : [`已处理 ${current}/${total || '?'}`];
      if (Number.isFinite(stats.exportedDocs)) detailParts.push(`导出 ${stats.exportedDocs}`);
      if (Number.isFinite(stats.importedDocs)) detailParts.push(`导入 ${stats.importedDocs}`);
      if (Number.isFinite(stats.createdDocs)) detailParts.push(`创建 ${stats.createdDocs}`);
      if (Number.isFinite(stats.skippedDocs)) detailParts.push(`跳过 ${stats.skippedDocs}`);
      if (Number.isFinite(stats.failureCount) && stats.failureCount) detailParts.push(`失败 ${stats.failureCount}`);
      updateProgress(current, total, detailParts.join('，'));
    }

    function handleEvent(event) {
      const type = normalizeStructuredLogType(event.level);
      const message = event.message || compactDiagnostic(event, 600);
      appendDetailedLog(structuredLogSource(event), type, message, {
        event: event.event || '',
        provider: event.provider || '',
        data: event
      });
      updateProgressFromEvent(event);
      const summary = summarizeEvent(event);
      if (summary) appendUserLog(summary.message, summary.type);
    }

    function handleLine(line) {
      if (!line) return;
      if (line.startsWith(STRUCTURED_LOG_PREFIX)) {
        const payload = line.slice(STRUCTURED_LOG_PREFIX.length);
        try {
          handleEvent(JSON.parse(payload));
        } catch (error) {
          appendDetailedLog('python', 'error', `结构化日志解析失败：${formatError(error)}；原始内容：${payload}`);
        }
        return;
      }
      onPlainLine(line);
    }

    function handleChunk(data) {
      lineBuffer += String(data || '');
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || '';
      lines.forEach(handleLine);
    }

    function reset() {
      lineBuffer = '';
      tocDiscovered = 0;
    }

    return {
      handleChunk,
      handleLine,
      handleEvent,
      summarizeEvent,
      reset
    };
  }

  const api = {
    STRUCTURED_LOG_PREFIX,
    normalizeStructuredLogType,
    createProcessor
  };

  root.WandaoStructuredLogs = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
