'use strict';
/**
 * 用 GitHub API 把工作区里"已跟踪但未提交"的改动推上去。
 *
 * 为什么单独写一个：本机 github.com:443 不通，git push / git fetch 都用不了，
 * 只能走 api.github.com 的 Git Data API。
 *
 * 做法：
 *   1. 用一个临时 git 仓库把当前工作区做成一个 commit（不动原仓库的 HEAD）
 *   2. 用 API 把变化上传成 blob → tree → commit → 更新 ref
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OWNER = 'LORQAQ';
const REPO = 'douyin-song-request';
const BRANCH = 'main';
const MESSAGE = process.argv[2] || 'chore: sync working tree';

const LOG = path.join(process.env.TEMP, 'api-sync.txt');
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

(async () => {
  TOKEN = getToken();
  if (!TOKEN) { log('拿不到凭据'); process.exitCode = 1; return; }

  // 1) 远端 head
  const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  const remoteHead = ref.json.object.sha;
  const remoteCommit = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${remoteHead}`);
  const remoteTreeSha = remoteCommit.json.tree.sha;
  log('远端 HEAD: ' + remoteHead.slice(0, 8));

  // 2) 找出工作区里与远端 tree 不同的文件：
  //    用临时仓库 + 远端 tree 做对比太麻烦，直接比对"本地文件的内容 hash"
  const remoteTree = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/${remoteTreeSha}?recursive=1`);
  const remoteFiles = new Map();
  for (const item of remoteTree.json.tree || []) {
    if (item.type === 'blob') remoteFiles.set(item.path, item.sha);
  }
  log('远端文件数: ' + remoteFiles.size);

  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => !p.startsWith('.git/'));

  // 用 git hash-object 算出本地文件的 blob sha（和 GitHub 用的是同一种算法）
  const toUpload = [];
  for (const rel of tracked) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    let sha;
    try {
      sha = execFileSync('git', ['hash-object', rel], { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch {
      continue;
    }
    if (remoteFiles.get(rel) !== sha) toUpload.push({ rel, sha });
  }
  log('需要上传: ' + toUpload.length + ' 个文件');
  toUpload.forEach((x) => log('   ' + x.rel));

  if (toUpload.length === 0) {
    log('已一致，无需推送');
    return;
  }

  // 3) 上传 blob
  const treeItems = [];
  for (const { rel } of toUpload) {
    const abs = path.join(ROOT, rel);
    const buf = fs.readFileSync(abs);
    const isBinary = buf.includes(0) || /\.(png|jpg|jpeg|gif|ico|zip|exe)$/i.test(rel);
    const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
      content: isBinary ? buf.toString('base64') : buf.toString('utf8'),
      encoding: isBinary ? 'base64' : 'utf-8',
    });
    if (blob.status !== 201) {
      log('❌ ' + rel + ' 上传失败 HTTP ' + blob.status);
      process.exitCode = 1;
      return;
    }
    treeItems.push({ path: rel, mode: '100644', type: 'blob', sha: blob.json.sha });
    log('   ✓ ' + rel);
  }

  // 4) tree → commit → ref
  const tree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
    base_tree: remoteTreeSha,
    tree: treeItems,
  });
  if (tree.status !== 201) { log('❌ 建 tree 失败: ' + tree.text.slice(0, 200)); process.exitCode = 1; return; }

  const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message: MESSAGE,
    tree: tree.json.sha,
    parents: [remoteHead],
  });
  if (commit.status !== 201) { log('❌ 建 commit 失败: ' + commit.text.slice(0, 200)); process.exitCode = 1; return; }

  const upd = await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    sha: commit.json.sha,
    force: false,
  });
  if (upd.status !== 200) { log('❌ 更新 ref 失败: ' + upd.text.slice(0, 200)); process.exitCode = 1; return; }

  log('✅ 已推送: ' + commit.json.sha.slice(0, 8));
  log('DONE');
})().catch((e) => {
  log('!! 异常: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
