'use strict';
/**
 * 一键全量验证（离线部分，约 20 秒）。
 *
 * 为什么做这个脚本：
 *   之前验证要手动一条条敲，而且分不清哪些要联网、哪些不要 ——
 *   结果跑一次"全量回归"要几分钟（大部分时间耗在实时搜索接口上），
 *   排查问题时非常低效。
 *
 * 这里只跑**离线**检查（不访问 B站/酷狗），秒级到十几秒出结果。
 * 需要联网的选歌质量测试在 `npm run test:songs`。
 *
 * 用法：npm run verify
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** 离线检查：不联网，快 */
const OFFLINE = [
  ['单元测试（100 项）', 'test/run.js'],
  ['发布验收（Release / git 同步）', 'test/accept.js'],
  ['点歌格式验收', 'test/accept-format.js'],
  ['批处理文件安全', 'test/check-batch.js'],
  ['前端引用完整性', 'test/check-frontend.js'],
  ['悬浮窗残留扫描', 'test/scan-leftovers.js'],
];

console.log('');
console.log('═══════════ 全量验证（离线）═══════════');
console.log('');

let failed = 0;
const results = [];

for (const [name, script] of OFFLINE) {
  const t0 = Date.now();
  process.stdout.write('  ▶ ' + name + ' … ');
  const r = spawnSync('node', [path.join(ROOT, script)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  const out = (r.stdout || '') + (r.stderr || '');
  const ok = r.status === 0;

  // 从输出里挑一行最有信息量的结论
  const summary =
    (out.match(/结果：通过\s*\d+\s*项，失败\s*\d+\s*项/) || [])[0] ||
    (out.match(/通过\s*\d+\s*项，失败\s*\d+\s*项/) || [])[0] ||
    (out.match(/✅[^\n]{0,50}/) || [])[0] ||
    (ok ? '✅ 通过' : '❌ 失败');

  if (ok) {
    console.log('✅ ' + Math.round(ms / 1000) + 's  ' + summary);
  } else {
    failed += 1;
    console.log('❌ ' + Math.round(ms / 1000) + 's  ' + summary);
    // 失败时把出错的几行打出来，省得再单独跑一遍
    const bad = out.split('\n').filter((l) => /❌|✗|Error|错误/.test(l)).slice(0, 6);
    for (const l of bad) console.log('        ' + l.trim().slice(0, 100));
  }
  results.push({ name, ok, ms, summary });
}

console.log('');
console.log('───────────────────────────────────────');
const total = results.reduce((a, b) => a + b.ms, 0);
if (failed === 0) {
  console.log('  ✅ 全部通过（' + results.length + ' 组，共 ' + Math.round(total / 1000) + ' 秒）');
  console.log('');
  console.log('  想额外测"选歌准不准"（需要联网，约 2~4 分钟）：');
  console.log('    npm run test:songs');
} else {
  console.log('  ❌ 有 ' + failed + ' 组失败（共 ' + Math.round(total / 1000) + ' 秒）');
}
console.log('═══════════════════════════════════════');
console.log('');

process.exitCode = failed ? 1 : 0;
