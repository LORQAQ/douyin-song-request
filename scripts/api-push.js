'use strict';
/**
 * 用 GitHub API 推送 commit（绕过 git push）。
 *
 * 为什么需要：本机网络环境下 `github.com:443` 连不上（被阻断），
 * 但 `api.github.com:443` 是通的 —— 所以走 Git Data API 手工建
 * blob/tree/commit 再更新 ref，效果和 git push 一样。
 *
 * 只做增量：本地 HEAD 与远端不同的那些文件才会重新上传。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OWNER = 'LORQAQ';
const REPO = 'douyin-song-request';
const BRANCH = 'main';

const LOG = path.join(process.env.TEMP, 'api-push.txt');
try { fs.unlinkSync(LOG); } catch {}
const log = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n', 'utf8'); };

function getToken() {
  const r = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const m = (r.stdout || '').match(/^password=(.+)$/m);
  return m ? m[1].trim() : null;
}

let TOKEN = null;
async function api(method, url, body) {
  const res = await fetch('https://api.github.com' + url, {
    method,
    headers: {
      Authorization: `token ${TOKEN}`,
      'User-Agent': 'dsh-publish',
      Accept: 'application/vnd.github+json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

/** 列出本地被 git 跟踪的文件（相对路径，正斜杠） */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

(async () => {
  TOKEN = getToken();
  if (!TOKEN) { log('❌ 拿不到凭据'); process.exitCode = 1; return; }
  log('✅ 已取到凭据');

  // ---- 1) 远端当前 main 的 head ----
  const refRes = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  if (refRes.status !== 200) {
    log(`❌ 读不到远端 ref：HTTP ${refRes.status} ${refRes.text.slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }
  const remoteHead = refRes.json.object.sha;
  log(`远端 main HEAD: ${remoteHead.slice(0, 8)}`);

  // ---- 2) 本地 HEAD ----
  const localHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  log(`本地 HEAD     : ${localHead.slice(0, 8)}`);
  if (localHead === remoteHead) {
    log('已经一致，不需要推送');
    process.exitCode = 0;
    return;
  }

  // ---- 3) 找出两边不同的文件 ----
  let changed;
  try {
    changed = execFileSync('git', ['diff', '--name-only', remoteHead, localHead], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    // 远端 commit 本地可能没有（不太可能，但兜底成"全部上传"）
    changed = trackedFiles();
  }
  log(`需要更新的文件：${changed.length} 个`);
  changed.forEach((f) => log('   ' + f));

  // ---- 4) 为每个变更文件创建 blob ----
  const treeItems = [];
  for (const rel of changed) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      // 文件被删除 → 用 null sha 表示删除
      treeItems.push({ path: rel, mode: '100644', type: 'blob', sha: null });
      log(`   - 删除 ${rel}`);
      continue;
    }
    const buf = fs.readFileSync(abs);
    const isText = !buf.includes(0) && !/\.(png|jpg|jpeg|gif|ico|zip|exe)$/i.test(rel);
    const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
      content: isText ? buf.toString('utf8') : buf.toString('base64'),
      encoding: isText ? 'utf-8' : 'base64',
    });
    if (blob.status !== 201) {
      log(`   ❌ ${rel} 上传失败 HTTP ${blob.status} ${blob.text.slice(0, 150)}`);
      process.exitCode = 1;
      return;
    }
    treeItems.push({ path: rel, mode: '100644', type: 'blob', sha: blob.json.sha });
    log(`   ✓ ${rel}`);
  }

  // ---- 5) 建 tree ----
  const treeRes = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
    base_tree: remoteHead ? (await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${remoteHead}`)).json.tree.sha : undefined,
    tree: treeItems,
  });
  if (treeRes.status !== 201) {
    log(`❌ 建 tree 失败：HTTP ${treeRes.status} ${treeRes.text.slice(0, 300)}`);
    process.exitCode = 1;
    return;
  }
  log(`✅ tree: ${treeRes.json.sha.slice(0, 8)}`);

  // ---- 6) 建 commit（沿用本地的提交信息）----
  const msg = execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const commitRes = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message: msg,
    tree: treeRes.json.sha,
    parents: [remoteHead],
  });
  if (commitRes.status !== 201) {
    log(`❌ 建 commit 失败：HTTP ${commitRes.status} ${commitRes.text.slice(0, 300)}`);
    process.exitCode = 1;
    return;
  }
  const newCommit = commitRes.json.sha;
  log(`✅ commit: ${newCommit.slice(0, 8)}`);

  // ---- 7) 更新 ref ----
  const upd = await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    sha: newCommit,
    force: false,
  });
  if (upd.status !== 200) {
    log(`❌ 更新 ref 失败：HTTP ${upd.status} ${upd.text.slice(0, 300)}`);
    process.exitCode = 1;
    return;
  }
  log(`✅ 已推送：远端 main → ${newCommit.slice(0, 8)}`);
  log('DONE');
})().catch((e) => {
  log('!! 异常: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
