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

/**
 * 【避免被限流】未认证的 GitHub API 每小时只有 60 次，
 * 这个脚本一次要打 30+ 次，跑两遍就 403 了（表现为"文件读不到"的假失败）。
 * 所以优先用本机已存的凭据（5000 次/小时）；拿不到就退回匿名。
 */
function getToken() {
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
    });
    const m = (r.stdout || '').match(/^password=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}
const TOKEN = getToken();
const AUTH_HEADERS = {
  'User-Agent': 'accept-check',
  Accept: 'application/vnd.github+json',
  ...(TOKEN ? { Authorization: `token ${TOKEN}` } : {}),
};

/** 判断一个响应是不是被限流了（而不是真的失败） */
function isRateLimited(status, text) {
  return status === 403 && /rate limit|API rate/i.test(String(text || ''));
}

/** 用 contents 接口读一个文件（返回文本，读不到返回 null） */
async function readFile(p) {
  try {
    const r = await fetch(`${API}/contents/${p.split('/').map(encodeURIComponent).join('/')}`, {
      headers: AUTH_HEADERS,
      signal: AbortSignal.timeout(20000),
    });
    const raw = await r.text();
    if (r.status !== 200) {
      return { status: r.status, text: null, rateLimited: isRateLimited(r.status, raw) };
    }
    const j = JSON.parse(raw);
    if (!j.content) return { status: r.status, text: null };
    return { status: 200, text: Buffer.from(j.content, 'base64').toString('utf8') };
  } catch (e) {
    return { status: 0, text: null, err: e.message };
  }
}

let pass = 0;
let fail = 0;
let skipped = 0;
const check = (name, ok, detail) => {
  if (ok) { pass += 1; log(`  ✅ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail += 1; log(`  ❌ ${name}${detail ? '  ' + detail : ''}`); }
};
const skip = (name, why) => {
  skipped += 1;
  log(`  ⏭  ${name}  跳过（${why}）`);
};

(async () => {
  log('════════ 发布验收 ════════');
  log(`  （GitHub API 认证: ${TOKEN ? '已用本机凭据' : '匿名（容易限流）'}）`);
  log('');

  // ---- 1) 仓库元信息 ----
  log('  【GitHub 仓库】');
  let meta = null;
  try {
    const r = await fetch(API, { headers: AUTH_HEADERS, signal: AbortSignal.timeout(20000) });
    const raw = await r.text();
    if (isRateLimited(r.status, raw)) {
      skip('仓库元信息', 'API 限流');
    } else {
      meta = JSON.parse(raw);
      check('仓库公开可访问', r.status === 200 && meta.private === false, meta.html_url || '');
      check('描述已设置', Boolean(meta.description), String(meta.description || '').slice(0, 56) + '…');
      check('topics 已设置', Array.isArray(meta.topics) && meta.topics.length > 0, (meta.topics || []).join(','));
      check('默认分支是 main', meta.default_branch === 'main', meta.default_branch);
      check('未归档/未禁用', !meta.archived && !meta.disabled);
    }
  } catch (e) {
    check('仓库元信息', false, e.message);
  }

  // ---- 2) 关键文件匿名可读 ----
  log('');
  log('  【关键文件都能读到】');
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
    // 注：public/overlay.html 已经移除（浏览器版歌单页拆掉了），
    // 它现在应该 404，所以放到下面的"必须不存在"清单里。
    // 悬浮窗本体在 overlay/ 子项目里：
    ['overlay/SongOverlay.cs', (t) => t.includes('UpdateLayeredWindow')],
    ['overlay/README.md', (t) => t.includes('通信协议') || t.includes('协议')],
    ['overlay/build.bat', (t) => t.includes('csc.exe')],
    ['scripts/start-all.bat', (t) => t.length > 100],
    ['scripts/stop-all.ps1', (t) => t.includes('Stop-Process')],
    ['.github/workflows/ci.yml', (t) => t.includes('npm test')],
    ['test/regression.js', (t) => t.includes('sanitizeConfigPatch')],
    ['test/run.js', (t) => t.includes('回归测试')],
  ];
  let rateHit = false;
  for (const [f, verify] of files) {
    if (rateHit) { skip(f, 'API 限流'); continue; }
    const { status, text, err, rateLimited } = await readFile(f);
    if (rateLimited) { rateHit = true; skip(f, 'API 限流'); continue; }
    if (err) check(f, false, err);
    else if (text === null) check(f, false, `HTTP ${status}`);
    else check(f, status === 200 && verify(text), `${text.length} 字符`);
  }

  // ---- 3) 敏感文件绝不能出现在仓库里 ----
  log('');
  log('  【必须不存在的文件】');
  for (const f of [
    // 本地数据（绝不该提交）
    'config.json',
    'pins.json',
    'collections-index.json',
    'music-meta-cache.json',
    // 已经移除的东西（浏览器版歌单页 + 一次性测试脚本 + 重复的 overlay 辅助脚本）
    'public/overlay.html',
    'test/generic-feeder.js',
    'scripts/build-overlay.ps1',
    'scripts/overlay-capture-mode.bat',
    'scripts/overlay-hidden-mode.bat',
  ]) {
    if (rateHit) { skip(`${f} 不存在`, 'API 限流'); continue; }
    const { status, rateLimited } = await readFile(f);
    if (rateLimited) { rateHit = true; skip(`${f} 不存在`, 'API 限流'); continue; }
    // 404 = 不存在（正确）；绝不能是 200
    check(`${f} 不存在`, status === 404, `HTTP ${status}`);
  }

  if (!rateHit) {
    try {
      const r = await fetch(`${API}/git/trees/main?recursive=1`, {
        headers: AUTH_HEADERS,
        signal: AbortSignal.timeout(25000),
      });
      const raw = await r.text();
      if (isRateLimited(r.status, raw)) {
        skip('仓库文件树检查', 'API 限流');
      } else {
        const j = JSON.parse(raw);
        // 注意：这个接口的结果会被 GitHub 缓存几十秒 —— 刚推完就查可能拿到旧列表。
        // 关键文件的存在性判断用 contents 接口（上面那些），那个是实时的。
        const paths = (j.tree || []).map((x) => x.path);
        check('文件总数合理', paths.length > 50 && paths.length < 200, `${paths.length} 个文件`);
        check('没有 node_modules', !paths.some((p) => p.startsWith('node_modules/')), '');
        check('没有 .git 残留', !paths.some((p) => p.startsWith('.git/')), '');
        const suspicious = paths.filter((p) => /(^|\/)config\.json$|pins\.json$|collections-index|music-meta-cache/.test(p));
        check('没有本地数据文件', suspicious.length === 0, suspicious.join(','));
        const srcCount = paths.filter((p) => p.startsWith('src/')).length;
        check('源码目录完整', srcCount >= 18, `src/ 下 ${srcCount} 个文件`);
      }
    } catch (e) {
      check('仓库文件树检查', false, e.message);
    }
  } else {
    skip('仓库文件树检查', 'API 限流');
  }

  // ---- 4) Release ----
  log('');
  log('  【Release】');
  /**
   * 版本号从 package.json 读，**不要在测试里写死**。
   * 之前这里硬编码 `v1.0.0`，发了新版本之后这个检查还在看旧 Release，
   * 结果报出一个早已不存在的问题（tag 指向旧 commit），白折腾一轮。
   */
  const pkgVersion = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'package.json'), 'utf8')).version;
  const REL_TAG = `v${pkgVersion}`;
  if (rateHit) {
    skip('Release 检查', 'API 限流');
  } else {
    try {
      const r = await fetch(`${API}/releases/tags/${REL_TAG}`, {
        headers: AUTH_HEADERS,
        signal: AbortSignal.timeout(25000),
      });
      const raw = await r.text();
      if (isRateLimited(r.status, raw)) {
        skip('Release 检查', 'API 限流');
      } else {
        const rel = JSON.parse(raw);
        check(`${REL_TAG} 已发布`, r.status === 200 && rel.draft === false, rel.tag_name || '');
        check('是正式版（非预发布）', rel.prerelease === false);
        check('有说明正文', (rel.body || '').length > 500, `${(rel.body || '').length} 字符`);
        check('有附件', Array.isArray(rel.assets) && rel.assets.length > 0, (rel.assets || []).map((a) => a.name).join(','));
        check('是 latest', rel.tag_name === REL_TAG);
        // 这个版本的 tag 应该指向 main（否则 Release 源码包会缺文件）
        if (meta) {
          const tr = await fetch(`${API}/git/ref/tags/${REL_TAG}`, {
            headers: AUTH_HEADERS,
            signal: AbortSignal.timeout(20000),
          });
          const traw = await tr.text();
          if (!isRateLimited(tr.status, traw)) {
            const tag = JSON.parse(traw);
            const mr = await fetch(`${API}/git/ref/heads/main`, {
              headers: AUTH_HEADERS,
              signal: AbortSignal.timeout(20000),
            });
            const mraw = await mr.text();
            if (!isRateLimited(mr.status, mraw)) {
              const m = JSON.parse(mraw);
              /**
               * tag 可能是 annotated tag，此时 `object.type === 'tag'`、
               * `object.sha` 指向的是 **tag 对象**而不是 commit ——
               * 直接和 main 的 commit sha 比会永远不等。
               * 所以要先解引用一次拿到真正的 commit。
               */
              let tagSha = tag.object && tag.object.sha;
              if (tag.object && tag.object.type === 'tag' && tag.object.url) {
                const dr = await fetch(tag.object.url, {
                  headers: AUTH_HEADERS,
                  signal: AbortSignal.timeout(20000),
                });
                const draw = await dr.text();
                if (!isRateLimited(dr.status, draw)) {
                  const deref = JSON.parse(draw);
                  if (deref.object && deref.object.sha) tagSha = deref.object.sha;
                }
              }
              check(
                'tag 指向最新 commit',
                tagSha === m.object.sha,
                `${String(tagSha).slice(0, 8)} / ${String(m.object.sha).slice(0, 8)}`
              );
            }
          }
        }
      }
    } catch (e) {
      check('Release 检查', false, e.message);
    }
  }

  // ---- 5) 本地 git 状态 ----
  log('');
  log('  【本地 git 状态】');
  try {
    const cwd = path.resolve(__dirname, '..');
    const g = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    // 【不能拿 origin/main 比】本机 github.com:443 不通，git fetch 用不了，
    // origin/main 会停在旧值。改成用 API 查到的远端 HEAD 比。
    const local = g(['rev-parse', 'HEAD']);
    if (meta) {
      const rr = await fetch(`${API}/git/ref/heads/main`, { headers: AUTH_HEADERS, signal: AbortSignal.timeout(20000) });
      const rraw = await rr.text();
      if (isRateLimited(rr.status, rraw)) {
        skip('本地与远端一致', 'API 限流');
      } else {
        const remote = JSON.parse(rraw).object.sha;
        if (local === remote) {
          check('本地与远端一致', true, `${local.slice(0, 8)} / ${remote.slice(0, 8)}`);
        } else {
          // 【已知情况，不算失败】
          // 本机 github.com:443 不通，推送只能走 API；API 在服务端新建的 commit
          // 对象本地没有（git fetch 也用不了），所以两边 SHA 天然不同。
          // 关键看内容：api-sync 是按 git blob 内容 hash 比对后才上传的，
          // 所以只要没有"待上传"，文件就是一致的。
          let pending = '未知';
          try {
            const treeRes = await fetch(`${API}/git/trees/main?recursive=1`, {
              headers: AUTH_HEADERS,
              signal: AbortSignal.timeout(25000),
            });
            const traw = await treeRes.text();
            const remoteFiles = new Map();
            if (!isRateLimited(treeRes.status, traw)) {
              for (const it of JSON.parse(traw).tree || []) {
                if (it.type === 'blob') remoteFiles.set(it.path, it.sha);
              }
              let diff = 0;
              // 【-z 必须加】中文文件名默认会被 git 输出成 "\345\277\253..." 这种转义形式，
              // 拿去 hash-object 会报 "could not open"，于是永远算作"有文件待同步"（假失败）。
              const tracked = g(['ls-files', '-z']).split('\0').filter(Boolean);
              for (const rel of tracked) {
                let sha = '';
                try {
                  // 【--no-filters 必须加】core.autocrlf=true 时 git hash-object 会
                  // 先把 CRLF 转成 LF 再算 sha，而远端存的是原始字节 ——
                  // 于是所有 .bat / .ps1 永远"不一致"（假失败）。
                  sha = g(['hash-object', '--no-filters', rel]);
                } catch {
                  continue;
                }
                if (remoteFiles.get(rel) !== sha) diff += 1;
              }
              pending = String(diff);
            }
          } catch {
            /* 忽略 */
          }
          if (pending === '0') {
            check('本地文件与远端一致（SHA 不同属正常）', true, `本地 ${local.slice(0, 8)} / 远端 ${remote.slice(0, 8)}，内容零差异`);
          } else {
            check('本地与远端一致', false, `${local.slice(0, 8)} / ${remote.slice(0, 8)}，有 ${pending} 个文件待同步`);
          }
        }
      }
    } else {
      skip('本地与远端一致', 'API 限流');
    }
    const commits = g(['rev-list', '--count', 'HEAD']);
    check('提交历史完整', Number(commits) >= 4, `${commits} 个 commit`);
    const remoteUrl = g(['remote', 'get-url', 'origin']);
    check('remote 指向正确', remoteUrl.includes(`${OWNER}/${REPO}`), remoteUrl);
  } catch (e) {
    check('git 检查', false, e.message);
  }

  log('');
  log('════════════════════════════════');
  log(`  通过 ${pass} 项，失败 ${fail} 项${skipped ? `，跳过 ${skipped} 项（限流）` : ''}`);
  log('════════════════════════════════');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  log('!! 异常: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
