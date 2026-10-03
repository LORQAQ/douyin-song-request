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

  /**
   * 【还要处理"本地已删除"的文件】
   *
   * 上面只比对了"本地文件 vs 远端 tree"，只看得到新增和修改。
   * 本地删掉的文件在远端会一直留着 —— 表现成"我明明删了，GitHub 上还在"。
   * 所以反过来再扫一遍：远端有、本地文件已不存在的，在 tree 里用 sha:null 标记删除。
   */
  const localSet = new Set(tracked);
  const toDelete = [];
  for (const rel of remoteFiles.keys()) {
    if (localSet.has(rel)) continue;
    if (fs.existsSync(path.join(ROOT, rel))) continue; // 本地还在，不动它
    toDelete.push(rel);
  }
  if (toDelete.length > 0) {
    log('需要删除: ' + toDelete.length + ' 个文件（本地已不存在）');
    toDelete.forEach((r) => log('   - ' + r));
  }

  if (toUpload.length === 0 && toDelete.length === 0) {
    log('已一致，无需推送');
    return;
  }

  // 3) 上传 blob（新增/修改的）
  //    sha:null 的条目表示删除（GitHub Git Data API 的约定）
  const treeItems = toDelete.map((rel) => ({
    path: rel,
    mode: '100644',
    type: 'blob',
    sha: null,
  }));
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

  /**
   * 关于「本地 HEAD 和远端 SHA 不一样」：
   *
   * 这是本机 github.com:443 不通、只能走 API 推送的必然结果 ——
   * API 在服务端新建的 commit 对象本地没有（git fetch 也用不了），
   * 所以 `git update-ref` 指不过去、本地也没法真正"对齐"。
   *
   * 影响：只是 `git status` 会显示本地领先 1 个 commit，
   * **文件内容是一致的**（api-sync 是按内容 hash 比对后再上传的）。
   * 下次同步时它会自动把旧的本地 commit 视作"没这个文件"，
   * 但因为内容相同（blob sha 一样），不会重复上传。
   *
   * 想彻底消除这个差异，需要在能连 github.com 的网络下执行一次：
   *     git fetch origin && git reset --hard origin/main
   */
  const localHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (localHead !== commit.json.sha) {
    log('提示: 本地 HEAD(' + localHead.slice(0, 8) + ') 与远端(' + commit.json.sha.slice(0, 8) + ') 不同');
    log('      这是 API 推送的正常现象，文件内容一致；');
    log('      等网络能连 github.com 时执行 git fetch origin && git reset --hard origin/main 即可对齐。');
  }

  log('DONE');
})().catch((e) => {
  log('!! 异常: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
