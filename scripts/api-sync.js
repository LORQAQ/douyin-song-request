'use strict';
/**
 * 用 GitHub API 把工作区的改动推上去。
 *
 * 为什么单独写一个：本机 github.com:443 不通，git push / git fetch 都用不了，
 * 只能走 api.github.com 的 Git Data API。
 *
 * 做法：
 *   1. 拉取远端的 tree，用 git hash-object 算出本地每个文件的 blob sha 做比对
 *   2. 只把"内容不一样"的文件上传成 blob → 建 tree → 建 commit → 更新 ref
 *
 * ⚠️ 【关于删除】
 * 默认**不会**删除远端的任何文件。
 *
 * 为什么改成默认关闭：原来它会自动把"远端有、本地没有"的文件删掉。
 * 结果我本地删掉 overlay/ 之后跑了一次同步，**把 GitHub 上的悬浮窗源码也删了**，
 * 只能再从 git 历史里恢复。远程删除是不可逆的，不该是默认行为。
 *
 * 确实要删远端文件时，显式加 --allow-delete：
 *     node scripts/api-sync.js "说明" --allow-delete
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OWNER = 'LORQAQ';
const REPO = 'douyin-song-request';
const BRANCH = 'main';

/** 是否允许删除远端文件。默认 false —— 见文件头的说明。 */
const ALLOW_DELETE = process.argv.includes('--allow-delete');

/**
 * 【删除保护清单】这些路径永远不会被自动删除，除非同时加 --force-protected。
 *
 * 为什么：`overlay/` 是独立子项目，本地可能故意不装它（省得每次都编译），
 * 但它是仓库的正经内容，绝不该因为"本地没有"就被同步删掉。
 * 有了这层保护，即使误加了 --allow-delete 也删不掉它们。
 */
const PROTECTED_PREFIXES = ['overlay/'];
const FORCE_PROTECTED = process.argv.includes('--force-protected');

function isProtected(rel) {
  if (FORCE_PROTECTED) return false;
  return PROTECTED_PREFIXES.some((p) => rel === p.replace(/\/$/, '') || rel.startsWith(p));
}

const MESSAGE =
  process.argv
    .slice(2)
    .filter((a) => a !== '--allow-delete')
    .join(' ') || 'chore: sync working tree';

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
      // 【必须加 --no-filters】
      // core.autocrlf=true 时，`git hash-object` 会先把 CRLF 转成 LF 再算哈希，
      // 而 GitHub 上存的是文件原始字节。于是所有 CRLF 文件（.bat / .ps1）
      // 算出来的 sha 永远对不上远端 —— 表现成"每次都报告这几个文件需要上传"，
      // 内容明明一模一样。--no-filters 让它按原始字节算，和远端一致。
      sha = execFileSync('git', ['hash-object', '--no-filters', rel], { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch {
      continue;
    }
    if (remoteFiles.get(rel) !== sha) toUpload.push({ rel, sha });
  }
  log('需要上传: ' + toUpload.length + ' 个文件');
  toUpload.forEach((x) => log('   ' + x.rel));

  /**
   * 【远端删除：默认关闭，必须显式 --allow-delete】
   *
   * 原来这段是无条件执行的 —— 本地删文件后跑一次同步，远端也跟着删。
   * 踩过的坑：我本地删掉 overlay/ 之后同步了一次，GitHub 上的悬浮窗源码
   * 一起被删了，只能从 git 历史里 checkout 回来。
   * 远程删除不可逆，不该是默认行为。所以现在：
   *   · 不加 --allow-delete → 只报告"这些文件远端有、本地没有"，不动它们
   *   · 加了 --allow-delete → 才真的删
   */
  const localSet = new Set(tracked);
  const orphaned = [];
  const protectedHits = [];
  for (const rel of remoteFiles.keys()) {
    if (localSet.has(rel)) continue;
    if (fs.existsSync(path.join(ROOT, rel))) continue; // 本地还在，不算删除
    if (isProtected(rel)) {
      protectedHits.push(rel);
      continue; // 受保护，永远不删
    }
    orphaned.push(rel);
  }

  if (protectedHits.length > 0) {
    log('');
    log('🛡  ' + protectedHits.length + ' 个受保护文件本地不存在，已跳过（不会删除）：');
    protectedHits.slice(0, 8).forEach((r) => log('   🛡 ' + r));
    if (protectedHits.length > 8) log('   …还有 ' + (protectedHits.length - 8) + ' 个');
    log('    这些是仓库的正经内容，本地可以故意不装。');
    log('');
  }

  const toDelete = ALLOW_DELETE ? orphaned : [];
  if (orphaned.length > 0) {
    if (ALLOW_DELETE) {
      log('需要删除: ' + toDelete.length + ' 个文件（本地已不存在，--allow-delete 已开启）');
      toDelete.forEach((r) => log('   - ' + r));
    } else {
      log('');
      log('⚠️  有 ' + orphaned.length + ' 个文件远端存在、本地没有：');
      orphaned.forEach((r) => log('   ? ' + r));
      log('    默认不会删除它们（远程删除不可逆）。');
      log('    确实要删就加 --allow-delete 重新执行。');
      log('');
    }
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
