'use strict';
/**
 * 最终扫描：本地还有没有悬浮窗（overlay）的**实体残留**。
 *
 * 区分两类：
 *   · 实体残留 —— 目录/文件/进程/快捷方式，应该全部清掉
 *   · 文字提及 —— 文档和脚本里解释"悬浮窗去哪了"，这是有意保留的
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DESKTOP = path.join(os.homedir(), 'Desktop');
const TEMP = os.tmpdir();

const entities = [];
const mentions = [];

/**
 * 【有意保留的"桥接"文件】
 * 它们的名字里带 overlay，但作用正是给"悬浮窗已经独立出去"这件事做说明/入口，
 * 删掉反而会让用户面对一个难懂的报错。所以不算残留。
 */
const INTENTIONAL = new Set([
  'scripts/overlay-launch.js', // npm run overlay 的入口，找不到 exe 时给出获取指引
  'scripts/pack-overlay-release.js', // 给 Release 打包悬浮窗附件（源码取自 GitHub）
  'test/scan-leftovers.js', // 本脚本自己
  'test/check-frontend.js',
]);

function walk(dir, depth) {
  if (depth > 8) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (full.includes('node_modules') || full.includes(`${path.sep}.git`)) continue;
    const rel = path.relative(ROOT, full).split(path.sep).join('/');

    // 实体：名字本身是悬浮窗相关
    if (/overlay|SongOverlay|悬浮窗|歌单窗/i.test(e.name) && !INTENTIONAL.has(rel)) {
      entities.push({ where: '项目内', what: rel, kind: e.isDirectory() ? '目录' : '文件' });
    }
    if (e.isDirectory()) walk(full, depth + 1);
  }
}

walk(ROOT, 0);

// 文字提及（读文本文件内容）
function scanMentions(dir, depth) {
  if (depth > 4) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (full.includes('node_modules') || full.includes(`${path.sep}.git`)) continue;
    if (e.isDirectory()) {
      scanMentions(full, depth + 1);
      continue;
    }
    if (!/\.(js|json|md|bat|ps1|vbs|html|txt)$/i.test(e.name)) continue;
    try {
      const t = fs.readFileSync(full, 'utf8');
      const n = (t.match(/overlay|SongOverlay|悬浮窗/gi) || []).length;
      if (n > 0) mentions.push({ what: path.relative(ROOT, full), n });
    } catch {
      /* ignore */
    }
  }
}
scanMentions(ROOT, 0);

// 桌面快捷方式
let lnks = [];
try {
  const ps = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$ws=New-Object -ComObject WScript.Shell; Get-ChildItem '${DESKTOP}' -Filter *.lnk -Recurse -EA SilentlyContinue | ForEach-Object { $s=$ws.CreateShortcut($_.FullName); "$($_.Name)|$($s.TargetPath)" }`,
    ],
    { encoding: 'utf8' }
  );
  lnks = (ps.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
} catch {
  /* ignore */
}
const badLnks = lnks.filter((l) => /overlay|SongOverlay|悬浮窗/i.test(l));

// 进程
const procs = [];
for (const n of ['SongOverlay', 'OverlayPlacer', 'WinDiag', 'WhereIsIt']) {
  const r = spawnSync('tasklist', ['/fi', `imagename eq ${n}.exe`, '/nh'], { encoding: 'utf8' });
  if ((r.stdout || '').trim() && !/no tasks|信息: 没有运行/i.test(r.stdout)) procs.push(n);
}

// 临时目录
const temps = [];
try {
  for (const f of fs.readdirSync(TEMP)) {
    if (/overlay|SongOverlay|歌单/i.test(f)) temps.push(f);
  }
} catch {
  /* ignore */
}

console.log('════════ 悬浮窗残留 · 最终扫描 ════════');
console.log('');

let bad = 0;
const section = (title, list, fmt) => {
  console.log('  【' + title + '】' + (list.length === 0 ? '  ✅ 无' : '  ⚠️ ' + list.length + ' 处'));
  for (const x of list) console.log('     ' + fmt(x));
  if (list.length) bad += list.length;
};

section('项目内的实体（文件/目录）', entities, (x) => `${x.kind}  ${x.what}`);
section('桌面快捷方式指向悬浮窗', badLnks, (x) => x);
section('正在运行的悬浮窗进程', procs, (x) => x + '.exe');
section('临时目录残留', temps, (x) => x);

console.log('');
console.log('  【文档/脚本里的文字说明】' + mentions.length + ' 个文件（有意保留）');
for (const m of mentions.sort((a, b) => b.n - a.n).slice(0, 12)) {
  console.log('     ' + m.what.padEnd(34) + m.n + ' 处提及');
}
if (mentions.length > 12) console.log('     …还有 ' + (mentions.length - 12) + ' 个');

console.log('');
console.log('════════════════════════════════════════');
if (bad === 0) {
  console.log('  ✅ 本地没有任何悬浮窗实体残留');
  console.log('     剩下的只有文档里解释"它去哪了"的文字。');
} else {
  console.log('  ⚠️ 还有 ' + bad + ' 处残留需要处理');
}
console.log('════════════════════════════════════════');
process.exitCode = bad ? 1 : 0;
