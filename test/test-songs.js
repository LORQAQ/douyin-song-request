'use strict';
/**
 * 选歌质量回归（**需要联网**，约 2~4 分钟）。
 *
 * 这些脚本要真的去 B站搜、去酷狗查原唱，所以慢；
 * 但它们才是真正验证"点歌选得准不准"的测试 ——
 * 尤其是同名不同歌、非中文歌、指定歌手这些场景。
 *
 * 日常改代码只跑 `npm run verify`（离线、20 秒）就够了；
 * 改动了**选歌/打分逻辑**时再跑这个。
 *
 * 用法：
 *   npm run test:songs              全部跑
 *   npm run test:songs -- russian   只跑某一组（名字见下面 GROUPS 的键）
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const GROUPS = [
  {
    key: 'dash',
    name: '「歌手 - 歌名」格式（8 例，含同名不同歌）',
    script: 'test/test-dash-standard.js',
    // 从输出里抓通过数
    pick: (out) => (out.match(/选对:\s*(\d+)\s*\/\s*(\d+)/) || []).slice(1).join('/'),
  },
  {
    key: 'cn',
    name: '中文歌（10 首，看是否选到原唱版本）',
    script: 'test/regress-cn-songs.js',
    pick: (out) => (out.match(/选对（标题\/UP含原唱）:\s*(\d+)\s*\/\s*(\d+)/) || []).slice(1).join('/'),
  },
  {
    key: 'noncn',
    name: '非中文歌（英文/日文/韩文，10 首）',
    script: 'test/diag-non-cn.js',
    pick: (out) => (out.match(/查到原唱:\s*(\d+)\s*\/\s*查不到:\s*(\d+)/) || []).slice(1).join(' / '),
  },
  {
    key: 'russian',
    name: '俄语歌（4 首，西里尔字母）',
    script: 'test/test-russian.js',
    pick: (out) => {
      const ok = (out.match(/→ ✅/g) || []).length;
      const bad = (out.match(/→ ❌/g) || []).length;
      return `成功 ${ok} / 失败 ${bad}`;
    },
  },
  {
    key: 'samename',
    name: '同名不同歌（时长指纹核对）',
    script: 'test/test-same-name.js',
    pick: (out) => (out.match(/时长吻合/g) || []).length + ' 处时长吻合',
  },
  {
    key: 'sametitle',
    name: '同名多版本（Alone / Stay / Hello / Sorry）',
    script: 'test/test-same-title-multi.js',
    pick: (out) => (out.match(/应该就是这首/g) || []).length + ' 首命中',
  },
  {
    key: 'multi',
    name: '多语种混合（8 首）',
    script: 'test/test-multi-songs.js',
    pick: (out) => (out.match(/有原唱背书:\s*(\d+)\s*\/\s*(\d+)/) || []).slice(1).join('/'),
  },
  {
    key: 'idle',
    name: '空闲垫播（自动垫 + 有人点歌打断）',
    script: 'test/test-idle-play.js',
    pick: (out) => (out.match(/垫播次数\s*:\s*(\d+)/) || [])[1] + ' 次垫播',
  },
];

const want = process.argv.slice(2).filter((x) => !x.startsWith('-'));
const list = want.length ? GROUPS.filter((g) => want.includes(g.key)) : GROUPS;

if (!list.length) {
  console.log('');
  console.log('没有匹配的分组。可选：');
  for (const g of GROUPS) console.log('  ' + g.key.padEnd(12) + g.name);
  console.log('');
  process.exit(1);
}

console.log('');
console.log('═══════ 选歌质量回归（联网，请耐心）═══════');
console.log('  分组: ' + list.map((g) => g.key).join(', '));
console.log('');

let failed = 0;
for (const g of list) {
  const t0 = Date.now();
  process.stdout.write('  ▶ ' + g.name + ' … ');
  const r = spawnSync('node', [path.join(ROOT, g.script)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const ms = Date.now() - t0;
  // 这些脚本是"诊断型"的，退出码不一定可靠；有输出就算跑到了
  const ran = out.length > 50;
  const ok = ran && r.status === 0;
  if (!ok) failed += 1;
  const detail = g.pick(out) || (ran ? '已执行' : '无输出');
  console.log((ok ? '✅' : '⚠️ ') + Math.round(ms / 1000) + 's  ' + detail);
  if (!ran) {
    const bad = out.split('\n').filter(Boolean).slice(-4);
    for (const l of bad) console.log('        ' + l.trim().slice(0, 100));
  }
}

console.log('');
console.log('───────────────────────────────────────');
console.log(
  failed === 0
    ? '  ✅ 全部跑通'
    : '  ⚠️ 有 ' + failed + ' 组返回非零（这些是诊断脚本，看上面的数字判断质量）'
);
console.log('  提示：这些数字会受 B站搜索结果波动影响，偶尔掉一两首是正常的。');
console.log('═══════════════════════════════════════');
console.log('');

process.exitCode = 0; // 诊断型脚本不作为门禁
