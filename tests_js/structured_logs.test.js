const assert = require('node:assert/strict');
const test = require('node:test');
const { createProcessor } = require('../wandao_electron/renderer/structured_logs');

test('TOC progress updates visible directory status without page log spam', () => {
  const progress = [];
  const userLogs = [];
  const processor = createProcessor({
    updateProgress: (...args) => progress.push(args),
    appendUserLog: (message, type) => userLogs.push({ message, type })
  });

  processor.handleEvent({ event: 'toc.started', level: 'info', message: '正在打开钉钉目标页面并读取目录…' });
  processor.handleEvent({
    event: 'toc.progress',
    level: 'info',
    message: '钉钉目录读取中：已检查 10 个文件夹，已发现 87 个节点。',
    stats: { scannedFolders: 10, discovered: 87 }
  });
  processor.handleEvent({
    event: 'toc.page',
    level: 'info',
    message: '正在读取钉钉目录「项目资料」第 2 页…',
    stats: { page: 2, discovered: 87 }
  });

  assert.deepEqual(progress[0], [0, 0, '正在读取目录…']);
  assert.deepEqual(progress[1], [0, 0, '正在读取目录，已发现 87 个节点']);
  assert.match(progress[2][2], /正在读取目录，已发现 87 个节点/);
  assert.match(progress[2][2], /项目资料/);
  assert.equal(userLogs.some(({ message }) => message.includes('第 2 页')), false);
});

test('TOC cache hit is visible while opaque cache keys stay out of user logs', () => {
  const userLogs = [];
  const processor = createProcessor({
    appendUserLog: (message, type) => userLogs.push({ message, type })
  });

  processor.handleEvent({
    event: 'toc.cache.hit',
    level: 'info',
    message: '复用刚读取的钉钉目录：共 1023 个节点，跳过重复目录扫描。',
    stats: { discovered: 1023, dentryKey: 'must-not-be-rendered', docKey: 'must-not-be-rendered' }
  });

  assert.deepEqual(userLogs, [{
    type: 'info',
    message: '复用刚读取的钉钉目录：共 1023 个节点，跳过重复目录扫描。'
  }]);
  assert.equal(userLogs[0].message.includes('must-not-be-rendered'), false);
});
