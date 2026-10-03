'use strict';

/**
 * 用真实浏览器（带扩展 / 不带扩展）打开直播间，验证弹幕能否被拿到。
 *
 * 用法：
 *   node scripts/browser-danmaku-check.js [webRid] [--ext] [--headed]
 *
 * 不带 --ext：只观察页面自己有没有开 WebSocket（判断抖音在自动化浏览器下是否正常加载）
 * 带 --ext  ：加载本项目 extension 目录，验证扩展能否把弹幕转发到本机服务
 */

const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const webRid = args.find((a) => /^\d+$/.test(a)) || '7456814';
const useExt = args.includes('--ext');
const headed = args.includes('--headed');
const SERVER = process.env.DSR_SERVER || 'http://127.0.0.1:8787';

function detectBrowser() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const list = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return list.find((p) => fs.existsSync(p)) || '';
}

async function main() {
  const { chromium } = require('playwright-core');
  const extDir = path.resolve(__dirname, '..', 'extension');

  const launchOptions = {
    headless: !headed,
    executablePath: detectBrowser(),
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  };
  if (useExt) {
    // 新版 headless 支持扩展；旧版必须带界面
    launchOptions.args.push(`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`);
    if (!headed) launchOptions.channel = undefined;
  }

  console.log(`启动浏览器（headless=${!headed}, 扩展=${useExt}）...`);
  const context = await chromium.launchPersistentContext(path.resolve(__dirname, '..', '.debug-profile'), launchOptions);
  const page = context.pages()[0] || (await context.newPage());

  const wsSeen = [];
  page.on('websocket', (ws) => {
    if (/webcast|douyin/i.test(ws.url())) wsSeen.push(ws.url().slice(0, 120));
  });

  await page.goto(`https://live.douyin.com/${webRid}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
    console.log('页面打开失败：' + e.message);
  });

  console.log('等待 40 秒...');
  await page.waitForTimeout(40000);

  const pageInfo = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    textLen: (document.body && document.body.innerText || '').length,
    injected: Boolean(window.__DSR_INJECTED__),
    frames: Number((document.documentElement.dataset || {}).dsrFrames || 0),
    foundWs: (document.documentElement.dataset || {}).dsrFound || '',
    dsrStatus: typeof window.__DSR_STATUS__ === 'function' ? window.__DSR_STATUS__() : null,
  }));

  console.log('\n=== 页面信息 ===');
  console.log(`  标题: ${pageInfo.title}`);
  console.log(`  URL : ${pageInfo.url}`);
  console.log(`  正文长度: ${pageInfo.textLen}`);
  console.log(`  注入脚本已加载: ${pageInfo.injected}`);
  console.log(`  转发帧数: ${pageInfo.frames}（发现抖音 WS: ${pageInfo.foundWs}）`);
  if (pageInfo.dsrStatus) console.log(`  注入状态: ${JSON.stringify(pageInfo.dsrStatus).slice(0, 200)}`);
  console.log(`  页面自己的抖音 WS: ${wsSeen.length ? wsSeen.join('\n      ') : '（没有）'}`);

  try {
    const state = await (await fetch(`${SERVER}/api/state`)).json();
    console.log('\n=== 本机服务 ===');
    console.log(`  看到的弹幕数: ${state.stats.chatSeen}`);
    for (const c of (state.recentChats || []).slice(0, 8)) console.log(`   💬 ${c.nickname}: ${c.content}`);
  } catch (err) {
    console.log(`\n本机服务未启动（${SERVER}）：${err.message}`);
  }

  await context.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('失败：', err.message);
  process.exit(1);
});
