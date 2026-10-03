'use strict';
/**
 * 用本机已存的 GitHub 凭据创建仓库并推送。
 *
 * 凭据来源：Windows 凭据管理器里 `git:https://github.com` 那条
 * （通过 `git credential fill` 取回，全程不回显明文）。
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPO = 'douyin-song-request';
const OWNER = 'LORQAQ';

function log(s) {
  console.log(s);
  fs.appendFileSync(path.join(process.env.TEMP, 'gh-push.txt'), s + '\n', 'utf8');
}

/** 从凭据管理器取 token（不回显） */
function getToken() {
  const r = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const m = (r.stdout || '').match(/^password=(.+)$/m);
  return m ? m[1].trim() : null;
}

async function api(token, method, url, body) {
  const res = await fetch('https://api.github.com' + url, {
    method,
    headers: {
      Authorization: `token ${token}`,
      'User-Agent': 'dsh-publish',
      Accept: 'application/vnd.github+json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

(async () => {
  try {
    fs.unlinkSync(path.join(process.env.TEMP, 'gh-push.txt'));
  } catch {
    /* ignore */
  }

  const token = getToken();
  if (!token) {
    log('❌ 拿不到 GitHub 凭据');
    process.exitCode = 1;
    return;
  }
  log('✅ 已取到凭据（不回显）');

  // ---- 1) 仓库是否已存在 ----
  let r = await api(token, 'GET', `/repos/${OWNER}/${REPO}`);
  if (r.status === 200) {
    log(`仓库已存在：${r.json.html_url}`);
  } else if (r.status === 404) {
    log('仓库不存在，开始创建…');
    r = await api(token, 'POST', '/user/repos', {
      name: REPO,
      description:
        '抖音弹幕点歌 → 自动在 B 站找到原版并播放。给直播主播用的纯音频点歌工具，含歌单悬浮窗、音量自动校准、直链过期自愈。',
      homepage: '',
      private: false,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false,
    });
    if (r.status === 201) {
      log(`✅ 仓库已创建：${r.json.html_url}`);
    } else {
      log(`❌ 创建失败：HTTP ${r.status}  ${r.text.slice(0, 300)}`);
      process.exitCode = 1;
      return;
    }
  } else {
    log(`❌ 查询仓库失败：HTTP ${r.status}  ${r.text.slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }

  // ---- 2) 设置 topics + 描述 ----
  const topics = ['douyin', 'bilibili', 'live', 'danmaku', 'nodejs', 'windows', 'music', 'zh-cn'];
  const t = await api(token, 'PUT', `/repos/${OWNER}/${REPO}/topics`, { names: topics });
  log(t.status === 200 ? `✅ topics 已设置：${topics.join(', ')}` : `⚠️ topics 设置失败 HTTP ${t.status}`);

  const e = await api(token, 'PATCH', `/repos/${OWNER}/${REPO}`, {
    description:
      '抖音弹幕点歌 → 自动在 B 站找到原版并播放。给直播主播用的纯音频点歌工具，含歌单悬浮窗、音量自动校准、直链过期自愈。',
    has_issues: true,
    has_wiki: false,
  });
  log(e.status === 200 ? '✅ 仓库描述已设置' : `⚠️ 描述设置失败 HTTP ${e.status}`);

  // ---- 3) 推送 ----
  log('正在推送代码…');
  const remote = `https://github.com/${OWNER}/${REPO}.git`;
  const git = (args, opts = {}) =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit' });

  try {
    const remotes = execFileSync('git', ['remote'], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (!remotes.split('\n').includes('origin')) {
      git(['remote', 'add', 'origin', remote], { quiet: true });
      log('  已添加 remote origin');
    } else {
      git(['remote', 'set-url', 'origin', remote], { quiet: true });
      log('  已更新 remote origin');
    }
  } catch (err) {
    log('  ⚠️ 设置 remote 出错：' + err.message);
  }

  const push = spawnSync('git', ['push', '-u', 'origin', 'main', '--force'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (push.status === 0) {
    log('✅ 推送成功');
  } else {
    log('❌ 推送失败: ' + ((push.stderr || '') + (push.stdout || '')).slice(0, 500));
    process.exitCode = 1;
    return;
  }

  // ---- 4) 验证公开可访问 ----
  log('正在验证公开可访问…');
  const check = await api(token, 'GET', `/repos/${OWNER}/${REPO}`);
  if (check.status === 200) {
    log(`  仓库: ${check.json.html_url}`);
    log(`  可见性: ${check.json.private ? '私有 ❌' : '公开 ✅'}`);
    log(`  默认分支: ${check.json.default_branch}`);
    log(`  大小: ${check.json.size} KB`);
  }
  const anon = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/README.md`, {
    headers: { 'User-Agent': 'dsh-publish' },
    signal: AbortSignal.timeout(20000),
  });
  log(`  匿名访问 README: HTTP ${anon.status} ${anon.ok ? '✅ 无需登录即可看到' : '❌'}`);
  log('DONE');
})().catch((err) => {
  log('!! 异常: ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
