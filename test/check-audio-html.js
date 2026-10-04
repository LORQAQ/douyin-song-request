'use strict';
/** 校验 audio.html 的改动完整性 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'audio.html'), 'utf8');

// 语法
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
let bad = 0;
scripts.forEach((x, i) => {
  try {
    new Function(x[1]);
  } catch (e) {
    bad += 1;
    console.log(`  ❌ 内联脚本 ${i + 1}: ${e.message}`);
  }
});
console.log(`  内联脚本 ${scripts.length} 个，语法失败 ${bad} 个`);

// 关键标识符
const names = ['pendingResumeAt', 'applyResumePosition', 'progress', 'resumeAt'];
for (const n of names) {
  const count = html.split(n).length - 1;
  console.log(`  ${n.padEnd(22)} 出现 ${count} 次`);
}

// 具体检查
const checks = [
  ['声明了 pendingResumeAt', /let pendingResumeAt = 0;/.test(html)],
  ['定义了 applyResumePosition', /function applyResumePosition\(/.test(html)],
  ['playDirect 后调用它', /playDirect\(p\);\s*\n\s*\/\/ 有续播位置就对齐过去/.test(html)],
  ['上报 progress 消息', /send\(\{ type: 'progress'/.test(html)],
  ['读取 payload 的 resumeAt', /pendingResumeAt = Number\(p\.resumeAt\)/.test(html)],
];
console.log('');
for (const [what, ok] of checks) console.log('  ' + (ok ? '✅' : '❌') + ' ' + what);
