'use strict';

/**
 * 获取B站 Cookie 并写进 config.json。
 *
 *   npm run cookie            登录后抓取（推荐，搜索最稳、音质最高）
 *   npm run cookie -- --guest 只抓游客 Cookie（不用登录，也能降低风控概率）
 *
 * 为什么需要 Cookie（**实测结论，别信网上那些说法**）：
 *   1) **主要作用：大幅降低 412 风控**。不登录时B站搜索接口很容易返回
 *      「request was banned」，配了 Cookie 基本不会遇到（实测连续搜索 8/8 成功）。
 *   2) 搜索结果的排序更稳定。
 *   3) 收藏夹/稍后再看等接口可用（以后做歌单功能会用到）。
 *
 * ⚠️ **Cookie 不会提升音质**。实测对照（同一视频、无 Cookie / 游客 / 登录）：
 *    稻香 210kbps / 210kbps / 210kbps，七里香 125/125/125 —— 完全一样。
 *    因为程序本来就按 bandwidth 排序取**最高**那条音轨，匿名也能拿到。
 *    所以不要为了「音质更高」去折腾 Cookie。
 *
 * 本脚本用**系统自带的 Chrome**（不额外下载 Chromium），
 * 抓完会**立刻验证 Cookie 是否真的可用**，并告诉你登录的是哪个账号。
 */

const path = require('path');
const { loadConfig } = require('../src/config');
const { readJsonSafe, writeJson, BILI_HEADERS } = require('../src/lib/util');

/** 等你扫码登录的最长时间（超过就放弃，避免后台任务一直挂着） */
const LOGIN_TIMEOUT_MS = 180000;

/** 写进 config.json 的字段（顺序固定，方便排查） */
const WANTED = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'buvid3', 'buvid4', 'b_nut'];

function findSystemChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  const fs = require('fs');
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 用 B站接口验证 Cookie 是否真的生效；返回 { ok, name, mid, code, message } */
async function verifyCookie(cookieText) {
  try {
    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { ...BILI_HEADERS, Cookie: cookieText },
    });
    const json = await res.json();
    const data = json.data || {};
    return {
      ok: Boolean(data.isLogin),
      name: data.uname || '',
      mid: data.mid || 0,
      code: json.code,
      message: json.message || '',
      vip: data.vipStatus === 1,
    };
  } catch (err) {
    return { ok: false, name: '', code: -1, message: err.message };
  }
}

/** 不带登录、只取游客 Cookie（buvid3/buvid4/b_nut），能明显降低 412 概率 */
async function fetchGuestCookies() {
  const res = await fetch('https://www.bilibili.com/', { headers: { ...BILI_HEADERS } });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const raw of setCookies) {
    const [pair] = raw.split(';');
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (WANTED.includes(name)) jar[name] = value;
  }
  return jar;
}

async function main() {
  const args = process.argv.slice(2);
  const guestOnly = args.includes('--guest');
  const config = loadConfig(args);
  const configPath = config.__paths.config;

  const writeCookie = (jar) => {
    const cookieText = WANTED.filter((k) => jar[k])
      .map((k) => `${k}=${jar[k]}`)
      .join('; ');
    const userConfig = readJsonSafe(configPath, {}) || {};
    userConfig.bilibili = userConfig.bilibili || {};
    userConfig.bilibili.cookie = cookieText;
    writeJson(configPath, userConfig);
    return cookieText;
  };

  console.log('==============================================');
  console.log('  B站 Cookie 配置');
  console.log('==============================================');
  console.log('');

  // ---------- 游客模式 ----------
  if (guestOnly) {
    console.log('模式：只取游客 Cookie（不登录）');
    const jar = await fetchGuestCookies();
    if (!Object.keys(jar).length) {
      console.log('⚠️ 没能从B站首页拿到游客 Cookie，请检查网络。');
      process.exit(1);
    }
    const text = writeCookie(jar);
    console.log(`✅ 已写入 config.json（${Object.keys(jar).length} 个字段）：${Object.keys(jar).join(', ')}`);
    console.log(`   ${text.slice(0, 90)}...`);
    console.log('');
    console.log('说明：游客 Cookie 已能明显降低风控概率（实测连续搜索 8/8 成功）。');
    console.log('登录版还能让搜索结果更稳定。想升级：npm run cookie');
    process.exit(0);
  }

  // ---------- 登录模式 ----------
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    console.log('没装 playwright。可以先用游客模式：npm run cookie -- --guest');
    console.log('或者手动：浏览器登录B站 → F12 → Application → Cookies →');
    console.log('  复制 SESSDATA / bili_jct / DedeUserID / buvid3 拼成一行填进 config.json 的 bilibili.cookie');
    process.exit(1);
  }

  const chromePath = findSystemChrome();
  const profileDir = path.resolve(config.__paths.root, '.bili-login-profile');
  console.log(`浏览器：${chromePath || '（用 playwright 自带 Chromium）'}`);
  console.log(`登录信息会保存在：${profileDir}`);
  console.log('');

  const launchOptions = {
    headless: false,
    viewport: { width: 1180, height: 800 },
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
  };
  if (chromePath) launchOptions.executablePath = chromePath;

  const context = await playwright.chromium.launchPersistentContext(profileDir, launchOptions);
  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});

  console.log('已打开浏览器窗口。请在里面登录B站：');
  console.log('  · 推荐用「扫码登录」——手机B站 App 扫一下就行，不用输密码');
  console.log('  · 登录成功后脚本会**自动检测**，不用按键，等着就行');
  console.log('');
  console.log(`（最多等 ${Math.round(LOGIN_TIMEOUT_MS / 1000)} 秒；也可以直接关掉浏览器窗口放弃）`);
  console.log('');

  // 自动轮询登录状态：不需要用户按回车（后台运行时也没法按）
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let jar = {};
  let lastHint = 0;
  let loggedIn = false;

  while (Date.now() < deadline) {
    // 页面被用户关掉就直接结束，别一直挂着
    if (context.pages().length === 0) {
      console.log('浏览器窗口已关闭，取消。');
      await context.close().catch(() => {});
      process.exit(1);
    }
    let cookies = [];
    try {
      cookies = await context.cookies('https://www.bilibili.com');
    } catch {
      break;
    }
    const found = {};
    for (const c of cookies) {
      if (WANTED.includes(c.name) && c.value) found[c.name] = c.value;
    }
    // SESSDATA 出现且长度像真的（B站登录态的标志）
    if (found.SESSDATA && found.SESSDATA.length > 10) {
      jar = found;
      loggedIn = true;
      break;
    }
    jar = found; // 先留着游客部分
    const waited = Math.round((LOGIN_TIMEOUT_MS - (deadline - Date.now())) / 1000);
    if (waited - lastHint >= 15) {
      lastHint = waited;
      process.stdout.write(`\r已等待 ${waited}s，还在等你扫码登录...`);
    }
    // 没登录时顺手把首页的游客 Cookie 也收集起来
    await page.waitForTimeout(1500);
  }
  process.stdout.write('\r');

  if (!loggedIn) {
    console.log('超时了，没检测到登录。');
    console.log('可以重跑 npm run cookie，或者先用游客模式：npm run cookie -- --guest');
  }

  await context.close().catch(() => {});

  const cookieText = WANTED.filter((k) => jar[k])
    .map((k) => `${k}=${jar[k]}`)
    .join('; ');

  // 关键：抓完立刻验证，避免「写进去了但其实无效」
  process.stdout.write('正在验证 Cookie ...');
  const check = await verifyCookie(cookieText);
  process.stdout.write('\r');

  if (!check.ok) {
    console.log(`⚠️ Cookie 写进去了，但验证没通过（code=${check.code} ${check.message}）。`);
    console.log('   可能是登录没完成就回车了。请重跑 npm run cookie。');
    console.log('   （仍然先保存下来，说不定能降低风控）');
  }

  writeCookie(jar);

  console.log(`✅ 已写入 config.json（${Object.keys(jar).length} 个字段）`);
  if (check.ok) {
    console.log(`   登录账号：${check.name}（UID ${check.mid}）${check.vip ? ' · 大会员' : ''}`);
    console.log('   验证结果：Cookie 有效 ✅');
  } else {
    console.log('   验证结果：未通过 ⚠️（见上面的提示）');
  }
  console.log('');
  console.log('重启程序就生效：npm start（或双击桌面「抖音点歌」）');
  console.log('以后如果又遇到 412 风控，重跑一次 npm run cookie 换新 Cookie 即可。');
}

main().catch((err) => {
  console.error('获取 Cookie 失败：', err.message);
  process.exit(1);
});
