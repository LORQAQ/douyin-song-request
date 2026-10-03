'use strict';
/**
 * 最终验收：把「歌手 - 歌名」格式相关的所有行为过一遍。
 *
 * 覆盖：解析规则、配置项、文档一致性、以及本地文件/远端是否同步。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { parseRequest } = require('../src/danmaku/parser');
const {
  BilibiliClient,
  isSafeSubstringMatch,
  collectionTrust,
  isLabelOrDistributor,
} = require('../src/bilibili/bili-api');

let pass = 0;
let fail = 0;
const ok = (name) => { pass += 1; console.log('  ✅ ' + name); };
const bad = (name, why) => { fail += 1; console.log('  ❌ ' + name + (why ? '  → ' + why : '')); };
const check = (name, cond, why) => (cond ? ok(name) : bad(name, why));

console.log('════════ 最终验收 ════════');
console.log('');

// ── 1) 点歌格式硬规则 ──
console.log('【1】「歌手 - 歌名」硬规则');
const cfg = { keywords: ['点歌'], requireKeyword: true, stripWords: ['点歌'], minLength: 2, maxLength: 40 };
const fmtCases = [
  ['点歌 周杰伦 - 晴天', '周杰伦', '晴天'],
  ['点歌 Alan Walker - Alone', 'Alan Walker', 'Alone'],
  ['点歌 Taylor Swift - Love Story', 'Taylor Swift', 'Love Story'],
  ['点歌 米津玄師 - Lemon', '米津玄師', 'Lemon'],
  ['点歌 Alone-Heart', 'Alone', 'Heart'],
  ['点歌 Alone – Heart', 'Alone', 'Heart'],
  ['点歌 Alone — Heart', 'Alone', 'Heart'],
  ['点歌 Heart   -   Alone', 'Heart', 'Alone'],
];
for (const [msg, a, t] of fmtCases) {
  const r = parseRequest(msg, cfg);
  check(`${msg}  →  ${a} / ${t}`, r && r.artist === a && r.title === t, `得到 ${r && r.artist} / ${r && r.title}`);
}

console.log('');
console.log('【2】别的格式不解析歌手');
for (const msg of ['点歌 晴天 周杰伦', '点歌 周杰伦 晴天', '点歌 晴天', '点歌 Alone Heart', '点歌 A - B - C']) {
  const r = parseRequest(msg, cfg);
  check(`${msg}  →  不解析歌手`, r && r.artist === '' && r.title === '', `得到 ${r && r.artist} / ${r && r.title}`);
}

console.log('');
console.log('【3】匹配安全性（非中文歌踩过的坑）');
check('shipofyou 不命中 you', isSafeSubstringMatch('shapeofyou', 'you') === false);
check('faded 不命中 20180528faded', isSafeSubstringMatch('faded', '20180528faded') === false);
check('晴天 命中 周杰伦晴天', isSafeSubstringMatch('晴天', '周杰伦晴天') === true);
check('lemon 命中 lemon米津玄师', isSafeSubstringMatch('lemon', 'lemon米津玄师') === true);
check('索尼音乐中国 判为唱片公司', isLabelOrDistributor('索尼音乐中国') === true);
check('周杰伦 不判为唱片公司', isLabelOrDistributor('周杰伦') === false);
const tut = collectionTrust('零基础学唱《残酷天使的行动纲领》', '残酷な天使のテーゼ', '臧赤君', '高桥洋子');
check('学唱教程被排除', tut.reject === true);
const fan = collectionTrust('PSY《2026 SUMMER SWAG》Fancam合集', '강남스타일', 'Psycho42', 'PSY');
check('演唱会饭拍被降权', fan.bonus < 0);

console.log('');
console.log('【4】版本号一致性（单一事实来源）');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check('package.json 版本是 ' + pkg.version, /^\d+\.\d+\.\d+$/.test(pkg.version));
const mr = fs.readFileSync(path.join(ROOT, 'scripts', 'make-release.js'), 'utf8');
const po = fs.readFileSync(path.join(ROOT, 'scripts', 'pack-overlay-release.js'), 'utf8');
check('make-release 从 package.json 读版本', /PKG\.version/.test(mr));
check('pack-overlay-release 从 package.json 读版本', /PKG\.version/.test(po));
check('两个脚本的 zip 名规则一致', /overlay-\$\{TAG\}\.zip/.test(mr) && /overlay-\$\{TAG\}\.zip/.test(po));

console.log('');
console.log('【5】CHANGELOG 有当前版本的条目');
const cl = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
check('CHANGELOG 含 [' + pkg.version + ']', cl.includes(`[${pkg.version}]`));

console.log('');
console.log('【6】README 记录了格式约定');
const rm = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
check('README 有「点歌格式」章节', /## .*点歌格式/.test(rm));
check('README 说明了横线前是歌手', /横线前面是歌手/.test(rm));
check('README 明确了其他写法不解析', /不解析歌手|一律不采用|一律不解析/.test(rm));

console.log('');
console.log('【7】本地与远端一致');
const sync = spawnSync('node', [path.join(ROOT, 'scripts', 'api-sync.js'), '--dry-run'], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000,
});
const syncOut = (sync.stdout || '') + (sync.stderr || '');
const pending = /待同步|需要上传|pending/i.test(syncOut) && !/0 个|没有|无变化|DONE/i.test(syncOut);
check('本地文件已全部同步到远端', !pending, syncOut.split('\n').filter(Boolean).slice(-3).join(' | '));

console.log('');
console.log('════════════════════════════');
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
console.log('════════════════════════════');
process.exitCode = fail ? 1 : 0;
