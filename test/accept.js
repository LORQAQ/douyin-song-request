'use strict';
/**
 * 发布前最终验收（不 spawn 子进程，避免管道限制；也不起服务 —— 
 * 服务相关项已由 test/run.js 的 87 项覆盖）。
 *
 * 这里只查两件还没验证过的事：
 *   1. GitHub 上的仓库内容是否真的公开可读、文件齐不齐
 *   2. 本地 git 与远端是否一致
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LOG = path.join(process.env.TEMP, 'final-accept.txt');
try { fs.unlinkSync(LOG); } catch {}
const log = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n', 'utf8'); };

const OWNER = 'LORQAQ';
const REPO = 'douyin-song-request';
// 注意：不要用 raw.githubusercontent.com —— 实测在某些网络环境下 DNS 解析不了。
// GitHub API 的 contents 接口同样能匿名读文件内容，而且更稳。
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

/** 用 contents 接口匿名读一个文件（返回文本，读不到返回 null） */
async function readFile(p) {
  try {
    const r = await fetch(`${API}/contents/${p.split('/').map(encodeURIComponent).join('/')}`, {
      headers: { 'User-Agent': 'accept-check', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20000),
    });
    if (r.status !== 200) return { status: r.status, text: null };
    const j = await r.json();
    if (!j.content) return { status: r.status, text: null };
    return { status: 200, text: Buffer.from(j.content, 'base64').toString('utf8') };
  } catch (e) {
    return { status: 0, text: null, err: e.message };
  }
}

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass += 1; log(`  ✅ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail += 1; log(`  ❌ ${name}${detail ? '  ' + detail : ''}`); }
};

(async () => {
  log('════════ 发布验收 ════════');
  log('');

  // ---- 1) 仓库元信息（匿名，不带任何 token）----
  log('  【GitHub 仓库】');
  try {
    const r = await fetch(API, {
      headers: { 'User-Agent': 'accept-check' },
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json();
    check('仓库公开可访问', r.status === 200 && j.private === false, j.html_url || '');
    check('描述已设置', Boolean(j.description), String(j.description || '').slice(0, 56) + '…');
    check('topics 已设置', Array.isArray(j.topics) && j.topics.length > 0, (j.topics || []).join(','));
    check('默认分支是 main', j.default_branch === 'main', j.default_branch);
    check('未归档/未禁用', !j.archived && !j.disabled);
  } catch (e) {
    check('仓库元信息', false, e.message);
  }

  // ---- 2) 关键文件匿名可读 ----
  log('');
  log('  【关键文件都能匿名读到】');
  const files = [
    ['README.md', (t) => t.includes('抖音') && t.length > 3000],
    ['CHANGELOG.md', (t) => t.includes('1.0.0')],
    ['LICENSE', (t) => t.includes('MIT')],
    ['package.json', (t) => t.includes('douyin-song-request')],
    ['config.example.json', (t) => t.includes('server')],
    ['src/index.js', (t) => t.includes('main()')],
    ['src/server.js', (t) => t.includes('_isLocalOrigin')],
    ['src/bilibili/bili-api.js', (t) => t.length > 10000],
    ['public/audio.html', (t) => t.includes('watchdogFails')],
    ['public/overlay.html', (t) => t.includes('<')],
    ['overlay/SongOverlay.cs', (t) => t.includes('UpdateLayeredWindow')],
    ['scripts/start-all.bat', (t) => t.length > 100],
    ['scripts/stop-all.ps1', (t) => t.includes('Stop-Process')],
    ['.github/workflows/ci.yml', (t) => t.includes('npm test')],
    ['test/regression.js', (t) => t.includes('sanitizeConfigPatch')],
    ['test/run.js', (t) => t.includes('回归测试')],
  ];
  for (const [f, verify] of files) {
    const { status, text, err } = await readFile(f);
    if (err) check(f, false, err);
    else if (text === null) check(f, false, `HTTP ${status}`);
    else check(f, status === 200 && verify(text), `${text.length} 字符`);
  }

  // ---- 3) 敏感文件绝不能出现在仓库里 ----
  log('');
  log('  【敏感文件必须不存在】');
  for (const f of ['config.json', 'pins.json', 'collections-index.json', 'music-meta-cache.json']) {
    const { status } = await readFile(f);
    check(`${f} 不存在`, status === 404, `HTTP ${status}`);
  }
  try {
    const r = await fetch(`${API}/git/trees/main?recursive=1`, {
      headers: { 'User-Agent': 'accept-check' },
      signal: AbortSignal.timeout(25000),
    });
    const j = await r.json();
    const paths = (j.tree || []).map((x) => x.path);
    check('文件总数合理', paths.length > 50 && paths.length < 200, `${paths.length} 个文件`);
    check('没有 node_modules', !paths.some((p) => p.startsWith('node_modules/')), '');
    check('没有 .git 残留', !paths.some((p) => p.startsWith('.git/')), '');
    const suspicious = paths.filter((p) => /config\.json$|pins\.json$|collections-index|music-meta-cache/.test(p));
    check('没有本地数据文件', suspicious.length === 0, suspicious.join(','));
    const srcCount = paths.filter((p) => p.startsWith('src/')).length;
    check('源码目录完整', srcCount >= 18, `src/ 下 ${srcCount} 个文件`);
  } catch (e) {
    check('仓库文件树检查', false, e.message);
  }

  // ---- 4) 本地与远端一致 ----
  log('');
  log('  【本地 git 状态】');
  try {
    const cwd = path.resolve(__dirname, '..');
    const g = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const local = g(['rev-parse', 'HEAD']);
    const remote = g(['rev-parse', 'origin/main']);
    check('本地与远端一致', local === remote, `${local.slice(0, 8)} / ${remote.slice(0, 8)}`);
    const commits = g(['rev-list', '--count', 'HEAD']);
    check('提交历史完整', Number(commits) >= 4, `${commits} 个 commit`);
    const remoteUrl = g(['remote', 'get-url', 'origin']);
    check('remote 指向正确', remoteUrl.includes(`${OWNER}/${REPO}`), remoteUrl);
  } catch (e) {
    check('git 检查', false, e.message);
  }

  log('');
  log('════════════════════════════════');
  log(`  通过 ${pass} 项，失败 ${fail} 项`);
  log('════════════════════════════════');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  log('!! 异常: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
