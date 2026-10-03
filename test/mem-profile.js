'use strict';
/**
 * 内存归因：看看 127MB 里都是什么。
 *
 * 做法：
 *   1) 只 require 各模块，看每个模块带来的堆增长
 *   2) 看 require.cache 里被加载的文件数
 *   3) 找出体积最大 / 最不该在启动时加载的依赖
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const mb = (n) => Math.round((n / 1024 / 1024) * 10) / 10;

function snap() {
  const m = process.memoryUsage();
  return { heap: m.heapUsed, rss: m.rss };
}

function delta(a, b) {
  return { heap: b.heap - a.heap, rss: b.rss - a.rss, files: b.files - a.files };
}

function countFiles() {
  return Object.keys(require.cache).length;
}

console.log('════════ 内存归因 ════════');
console.log('');

let prev = { ...snap(), files: countFiles() };
console.log(`  起始: heap ${mb(prev.heap)}MB  rss ${mb(prev.rss)}MB  (${prev.files} 个模块)`);
console.log('');

/** 逐个加载，看各步骤的增量 */
const STEPS = [
  ['基础（什么都不加载）', () => {}],
  ['ws（WebSocket 库）', () => require(path.join(ROOT, 'node_modules', 'ws'))],
  ['src/lib/util', () => require(path.join(ROOT, 'src', 'lib', 'util'))],
  ['src/lib/logger', () => require(path.join(ROOT, 'src', 'lib', 'logger'))],
  ['src/config', () => require(path.join(ROOT, 'src', 'config'))],
  ['src/lib/music-meta', () => require(path.join(ROOT, 'src', 'lib', 'music-meta'))],
  ['src/bilibili/bili-api', () => require(path.join(ROOT, 'src', 'bilibili', 'bili-api'))],
  ['src/danmaku/*', () => {
    const d = path.join(ROOT, 'src', 'danmaku');
    for (const f of fs.readdirSync(d)) if (f.endsWith('.js')) require(path.join(d, f));
  }],
  ['src/player/*', () => {
    const d = path.join(ROOT, 'src', 'player');
    for (const f of fs.readdirSync(d)) if (f.endsWith('.js')) require(path.join(d, f));
  }],
  ['src/lib/*（剩余）', () => {
    const d = path.join(ROOT, 'src', 'lib');
    for (const f of fs.readdirSync(d)) if (f.endsWith('.js')) require(path.join(d, f));
  }],
  ['src/server', () => require(path.join(ROOT, 'src', 'server'))],
  ['playwright（可选依赖）', () => {
    try { require(path.join(ROOT, 'node_modules', 'playwright-core')); return 'loaded'; }
    catch { return 'missing'; }
  }],
];

for (const [name, fn] of STEPS) {
  const before = { ...snap(), files: countFiles() };
  let note = '';
  try {
    const r = fn();
    if (typeof r === 'string') note = ' (' + r + ')';
  } catch (e) {
    note = ' (失败: ' + e.message.slice(0, 40) + ')';
  }
  const after = { ...snap(), files: countFiles() };
  const d = delta(before, after);
  const h = (d.heap / 1024 / 1024).toFixed(2);
  const r2 = (d.rss / 1024 / 1024).toFixed(1);
  const flag = d.heap > 3 * 1024 * 1024 ? '  ← 吃内存' : '';
  console.log(
    '  ' + name.padEnd(24) +
    ('+' + h + 'MB').padStart(11) + ' heap  ' +
    ('+' + r2 + 'MB').padStart(9) + ' rss  ' +
    ('+' + d.files).padStart(5) + ' 模块' + note + flag
  );
  prev = after;
}

console.log('');
const fin = { ...snap(), files: countFiles() };
console.log(`  合计: heap ${mb(fin.heap)}MB  rss ${mb(fin.rss)}MB  (${fin.files} 个模块)`);
console.log('');

// 哪些模块文件最大（间接反映解析/常驻成本）
console.log('  最大的 15 个已被加载的模块文件:');
const entries = Object.keys(require.cache)
  .map((f) => {
    try { return { f, size: fs.statSync(f).size }; } catch { return null; }
  })
  .filter(Boolean)
  .sort((a, b) => b.size - a.size)
  .slice(0, 15);
for (const e of entries) {
  const rel = e.f.replace(ROOT, '').replace(/\\/g, '/');
  console.log('    ' + (e.size / 1024).toFixed(0).padStart(6) + ' KB  ' + rel);
}

console.log('');
console.log('  结论提示:');
console.log('    - node_modules 里加载了什么、有多大，上面能直接看出来');
console.log('    - 如果 playwright 在启动时被加载，那它就是内存大头（它只用于自检脚本）');
